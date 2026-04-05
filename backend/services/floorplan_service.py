"""
ECO-3D Professional Floor Plan Generator v6
=============================================
Key fixes over v5:
- Rooms fill their zone completely (no gaps, no disconnected islands)
- All shapes use the SAME rectangular bounding box approach internally,
  with shape-specific zone proportions. Rooms are always contiguous.
- Irregular/L/T shapes use INDENTED zones (set in from edges) but rooms
  still share walls with each other - no floating rectangles.
- Zone packing ensures rooms stretch to fill zone width/height.
- Perimeter walls always drawn regardless of wall data.
- Wind particles bright cyan, visible on dark background.
"""
import asyncio
import logging, math, random, time, hashlib
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import desc, select
from database.models import AnalysisRecord, FloorPlanRecord, PlotRecord
from models.schemas import Door, EcoAuditReportSchema, FloorPlanResponse, FloorPlanVariant, GenerateFloorPlanRequest, Room, Wall, Window
from ai.floorplan.correction_loop import IterationHistory, run_correction_loop
from ai.floorplan.ga_engine import run_all_algorithms
from ai.floorplan.genetic import chromosome_to_response, generate_floor_plan_variants, generate_walls
from ai.floorplan.eco_validator import run_eco_audit

logger = logging.getLogger(__name__)
WALL_EXT = 0.23; WALL_INT = 0.12; FLOOR_H = 3.0


def _normalize_generation_method(value: Optional[str]) -> str:
    raw = (value or "deterministic").strip().lower()
    compact = "".join(ch for ch in raw if ch.isalnum())
    ga_aliases = {
        "ga",
        "gaoptimizer",
        "gaoptimiser",
        "gaoptimization",
        "gaoptimisation",
        "genetic",
        "geneticalgo",
        "geneticalgorithm",
        "evolutionary",
    }
    return "ga" if compact in ga_aliases else "deterministic"

# ── Compass ──────────────────────────────────────────────────────────────────
COMPASS={"N":0,"NNE":22.5,"NE":45,"ENE":67.5,"E":90,"ESE":112.5,"SE":135,"SSE":157.5,
         "S":180,"SSW":202.5,"SW":225,"WSW":247.5,"W":270,"WNW":292.5,"NW":315,"NNW":337.5}
def _brg(d:str)->float: return COMPASS.get((d or "S").upper(),180.0)
def _adiff(a,b): d=abs(a-b)%360; return min(d,360-d)
def _d2c(deg): return min(COMPASS,key=lambda k:_adiff(COMPASS[k],deg%360))
def _climate(lat,sun_h):
    a=abs(lat)
    if a<23.5 and sun_h>=7.5: return "hot"
    if a<35   and sun_h>=6.0: return "warm"
    if a<60:                   return "temperate"
    return "cold"
def _sunny(lat): return "S" if lat>=0 else "N"
def _shade(lat): return "N" if lat>=0 else "S"
def _wwr(climate,rtype):
    base={"living":0.50,"dining":0.40,"bedroom":0.35,"kitchen":0.28,"office":0.30,
          "bathroom":0.18,"utility":0.12,"garage":0.10,"puja_room":0.20}.get(rtype,0.25)
    return base*{"hot":0.72,"warm":0.88,"temperate":1.0,"cold":1.18}.get(climate,1.0)

# ── Room rules ───────────────────────────────────────────────────────────────
SHARE={"living":1.30,"dining":0.70,"kitchen":0.72,"bedroom":1.00,"bathroom":0.38,
       "office":0.70,"utility":0.32,"garage":0.78,"puja_room":0.24}
ASPECT={"living":1.45,"dining":1.25,"kitchen":1.20,"bedroom":1.20,"bathroom":1.05,
        "office":1.20,"utility":1.10,"garage":1.55,"puja_room":1.00}
RMIN={"living":14.0,"dining":8.5,"kitchen":7.5,"bedroom":9.0,"bathroom":3.2,
      "office":7.0,"utility":2.8,"garage":13.0,"puja_room":2.5}
RMAX={"living":36.0,"dining":16.0,"kitchen":14.0,"bedroom":20.0,"bathroom":7.5,
      "office":15.0,"utility":7.0,"garage":22.0,"puja_room":6.0}
CLASS={"living":"pub","dining":"pub","kitchen":"svc","bedroom":"prv","bathroom":"svc",
       "office":"prv","utility":"svc","garage":"svc","puja_room":"prv"}

HOUSE_TYPE_PROFILES = {
    "Eco-Villa (Single Story)": {
        "defaults": {"dining": True, "utility": True},
        "weight": {"living": 1.08, "dining": 1.05},
    },
    "Modern Apartment": {
        "defaults": {"dining": True, "garage": False, "utility": False, "puja_room": False},
        "caps": {"bedrooms": 3, "bathrooms": 2},
        "weight": {"living": 1.12, "garage": 0.3, "utility": 0.6},
    },
    "Sustainable Townhouse": {
        "defaults": {"dining": True, "office": True, "utility": True},
        "weight": {"office": 1.2, "living": 0.96},
    },
    "Green Duplex": {
        "defaults": {"dining": True, "office": True, "garage": True, "utility": True},
        "bonus": {"bathrooms": 1},
        "weight": {"bedroom": 1.08, "bathroom": 1.18, "garage": 1.05},
    },
    "Solar Passive House": {
        "defaults": {"dining": True, "office": True, "utility": True},
        "weight": {"living": 1.18, "dining": 1.12, "kitchen": 0.92, "bedroom": 0.94},
    },
    "Compact Urban Home": {
        "defaults": {"dining": False, "office": False, "garage": False, "utility": True},
        "caps": {"bedrooms": 2, "bathrooms": 2},
        "weight": {"living": 0.92, "bedroom": 0.88, "garage": 0.2},
    },
    "Traditional with Puja": {
        "defaults": {"dining": True, "puja_room": True, "utility": True},
        "weight": {"puja_room": 1.45, "living": 0.98},
    },
}

@dataclass
class Site:
    w:float; h:float; lat:float; lon:float
    wind:str; slope:float; flood:float; ndvi:float; sun_h:float
    elevation: float = 120.0
    rainfall_mm: float = 1200.0
    solar_radiation: float = 5.2
    clay_pct: float = 25.0
    soil_ph: float = 6.8
    bulk_density: float = 1.4
    wind_speed_ms: float = 4.0
    distance_to_water: float = 1000.0
    buildability: float = 72.0
    tree_coordinates: List[dict] = field(default_factory=list)
    polygon: List[List[float]] = field(default_factory=list)

# ── Footprint ────────────────────────────────────────────────────────────────
def _fp(site:Site,area:float,floors:int)->Tuple[float,float]:
    a=max(area/max(floors,1),30.0)
    uw=max(site.w-1.8,6.0); uh=max(site.h-1.8,6.0)
    r=min(max(uw/max(uh,1),0.6),2.0)
    w=math.sqrt(a*r); h=a/max(w,1)
    if w>uw: w=uw; h=a/w
    if h>uh: h=uh; w=a/h
    return min(w,uw),min(h,uh)


def _ga_regularized_envelope(area: float, floors: int, shape: str) -> Tuple[float, float]:
    a = max(area / max(floors, 1), 30.0)
    ratio_map = {
        "rectangle": 1.35,
        "square": 1.0,
        "l-shape": 1.25,
        "t-shape": 1.2,
        "irregular": 1.15,
        "circle": 1.0,
    }
    r = ratio_map.get((shape or "rectangle").strip().lower(), 1.2)
    w = max(8.0, math.sqrt(a * r))
    h = max(8.0, a / max(w, 1e-6))
    return w, h


def _ga_variant_index_for_algorithm(algorithm: str) -> int:
    key = (algorithm or "").strip().lower()
    if "nsga" in key:
        return 0
    if "moea" in key:
        return 1
    if "shade" in key:
        return 2
    if "island" in key:
        return 3
    if "cma" in key:
        return 5
    return 4

# ── Area allocation ───────────────────────────────────────────────────────────
def _alloc(types:List[str],total:float,house_type:str="Eco-Villa (Single Story)")->Dict[str,List[float]]:
    profile = HOUSE_TYPE_PROFILES.get(house_type, {})
    weights = profile.get("weight", {})
    wt=sum(SHARE.get(r,1.0)*weights.get(r,1.0) for r in types) or 1
    areas=[total*(SHARE.get(r,1.0)*weights.get(r,1.0))/wt for r in types]
    areas=[max(RMIN.get(r,4.0),min(RMAX.get(r,30.0),a)) for r,a in zip(types,areas)]
    d=total-sum(areas)
    if abs(d)>0.1:
        cap=[(i,(RMAX.get(types[i],30)-areas[i] if d>0 else areas[i]-RMIN.get(types[i],4)))
             for i in range(len(areas))]
        tc=sum(max(c,0) for _,c in cap) or 1
        for i,c in cap:
            if c>0: areas[i]+=d*(c/tc)
        areas[0]+=total-sum(areas)
    out:Dict[str,List[float]]={}
    for r,a in zip(types,areas): out.setdefault(r,[]).append(round(a,2))
    return out

def _dims(rtype:str,area:float)->Tuple[float,float]:
    ar=ASPECT.get(rtype,1.2); w=math.sqrt(area*ar); h=area/max(w,1e-6)
    return round(w,2),round(h,2)

# ── Room program ──────────────────────────────────────────────────────────────
def _prog(area:float,prefs:Optional[dict],house_type:str="Eco-Villa (Single Story)")->List[str]:
    profile = HOUSE_TYPE_PROFILES.get(house_type, {})
    p={**profile.get("defaults", {}), **(prefs or {})}
    bonus = profile.get("bonus", {})
    caps = profile.get("caps", {})
    beds=max(1,int(p.get("bedrooms",2 if area<140 else 3 if area<240 else 4))+int(bonus.get("bedrooms",0)))
    baths=max(1,int(p.get("bathrooms",max(1,beds-1)))+int(bonus.get("bathrooms",0)))
    if "bedrooms" in caps: beds=min(beds,int(caps["bedrooms"]))
    if "bathrooms" in caps: baths=min(baths,int(caps["bathrooms"]))
    if area<80: beds=min(beds,1); baths=min(baths,1)
    elif area<140: beds=min(beds,2); baths=min(baths,2)
    elif area<240: beds=min(beds,3); baths=min(baths,2)
    rooms=["living","kitchen"]
    if area>=90 and p.get("dining",True): rooms.append("dining")
    rooms+=["bedroom"]*beds+["bathroom"]*baths
    if area>=110 and p.get("office",False): rooms.append("office")
    if area>=120 and p.get("utility",True): rooms.append("utility")
    if area>=170 and p.get("garage",False): rooms.append("garage")
    if area>=70  and p.get("puja_room",False): rooms.append("puja_room")
    return rooms

# ── CORE LAYOUT ENGINE ────────────────────────────────────────────────────────
# Uses a "zone strip" layout:
# The footprint is divided into horizontal bands (for most variants) or
# vertical columns (for cross-ventilation variant).
# Rooms within each band are packed left-to-right, then stretched to fill
# the band completely so there are NEVER any gaps.
#
# Zone definitions per variant (all as fractions of fw, fh):
#  Each zone: (x0, y0, w, h) fractions
ZONE_LIBRARY = {
    "rectangle": {
        0: {"pub": [(0.00, 0.58, 0.64, 0.42)], "prv": [(0.00, 0.00, 1.00, 0.58)], "svc": [(0.64, 0.58, 0.36, 0.42)]},
        1: {"pub": [(0.00, 0.00, 0.46, 1.00)], "prv": [(0.64, 0.00, 0.36, 1.00)], "svc": [(0.46, 0.00, 0.18, 1.00)]},
        2: {"pub": [(0.00, 0.46, 0.68, 0.54)], "prv": [(0.00, 0.00, 1.00, 0.46)], "svc": [(0.68, 0.46, 0.32, 0.54)]},
        3: {"pub": [(0.00, 0.58, 1.00, 0.42)], "prv": [(0.00, 0.00, 0.62, 0.58)], "svc": [(0.62, 0.00, 0.38, 0.58)]},
        4: {"pub": [(0.00, 0.60, 0.64, 0.40)], "prv": [(0.00, 0.00, 0.64, 0.60)], "svc": [(0.64, 0.00, 0.36, 0.30), (0.64, 0.76, 0.36, 0.24)]},
        5: {"pub": [(0.24, 0.56, 0.76, 0.44)], "prv": [(0.24, 0.00, 0.76, 0.56)], "svc": [(0.00, 0.00, 0.24, 1.00)]},
    },
    "square": {
        0: {"pub": [(0.00, 0.54, 0.60, 0.46)], "prv": [(0.00, 0.00, 1.00, 0.54)], "svc": [(0.60, 0.54, 0.40, 0.46)]},
        1: {"pub": [(0.00, 0.00, 0.50, 1.00)], "prv": [(0.72, 0.00, 0.28, 1.00)], "svc": [(0.50, 0.00, 0.22, 1.00)]},
        2: {"pub": [(0.00, 0.00, 0.54, 0.56)], "prv": [(0.00, 0.56, 1.00, 0.44)], "svc": [(0.54, 0.00, 0.46, 0.56)]},
        3: {"pub": [(0.00, 0.56, 1.00, 0.44)], "prv": [(0.00, 0.00, 0.58, 0.56)], "svc": [(0.58, 0.00, 0.42, 0.56)]},
        4: {"pub": [(0.00, 0.58, 0.58, 0.42)], "prv": [(0.00, 0.00, 0.58, 0.58)], "svc": [(0.58, 0.00, 0.42, 0.42)]},
        5: {"pub": [(0.20, 0.58, 0.80, 0.42)], "prv": [(0.20, 0.00, 0.80, 0.58)], "svc": [(0.00, 0.00, 0.20, 1.00)]},
    },
    "lshape": {
        0: {"pub": [(0.00, 0.62, 0.64, 0.38)], "prv": [(0.00, 0.00, 0.58, 0.62)], "svc": [(0.64, 0.62, 0.36, 0.38)]},
        1: {"pub": [(0.00, 0.58, 0.62, 0.42)], "prv": [(0.00, 0.00, 0.58, 0.58)], "svc": [(0.62, 0.58, 0.38, 0.42)]},
        2: {"pub": [(0.00, 0.60, 1.00, 0.40)], "prv": [(0.00, 0.00, 0.56, 0.60)], "svc": [(0.56, 0.60, 0.44, 0.40)]},
        3: {"pub": [(0.00, 0.56, 0.70, 0.44)], "prv": [(0.00, 0.00, 0.56, 0.56)], "svc": [(0.70, 0.56, 0.30, 0.44)]},
        4: {"pub": [(0.00, 0.64, 1.00, 0.36)], "prv": [(0.00, 0.00, 0.52, 0.64)], "svc": [(0.52, 0.64, 0.48, 0.36)]},
        5: {"pub": [(0.00, 0.58, 0.68, 0.42)], "prv": [(0.00, 0.00, 0.54, 0.58)], "svc": [(0.68, 0.58, 0.32, 0.42)]},
    },
    "tshape": {
        0: {"pub": [(0.00, 0.00, 1.00, 0.36)], "prv": [(0.32, 0.36, 0.36, 0.42)], "svc": [(0.32, 0.78, 0.36, 0.22)]},
        1: {"pub": [(0.00, 0.00, 1.00, 0.40)], "prv": [(0.32, 0.40, 0.18, 0.60)], "svc": [(0.50, 0.40, 0.18, 0.60)]},
        2: {"pub": [(0.00, 0.00, 1.00, 0.34)], "prv": [(0.30, 0.34, 0.40, 0.40)], "svc": [(0.30, 0.74, 0.40, 0.26)]},
        3: {"pub": [(0.00, 0.00, 1.00, 0.38)], "prv": [(0.34, 0.38, 0.32, 0.34)], "svc": [(0.34, 0.72, 0.32, 0.28)]},
        4: {"pub": [(0.00, 0.00, 1.00, 0.42)], "prv": [(0.30, 0.42, 0.40, 0.32)], "svc": [(0.30, 0.74, 0.40, 0.26)]},
        5: {"pub": [(0.00, 0.00, 1.00, 0.36)], "prv": [(0.32, 0.36, 0.20, 0.64)], "svc": [(0.52, 0.36, 0.16, 0.64)]},
    },
    "irregular": {
        0: {"pub": [(0.12, 0.60, 0.88, 0.40)], "prv": [(0.00, 0.18, 0.66, 0.42)], "svc": [(0.12, 0.00, 0.78, 0.18)]},
        1: {"pub": [(0.00, 0.26, 0.46, 0.56)], "prv": [(0.66, 0.00, 0.34, 1.00)], "svc": [(0.46, 0.12, 0.20, 0.70)]},
        2: {"pub": [(0.16, 0.62, 0.84, 0.38)], "prv": [(0.00, 0.22, 0.82, 0.40)], "svc": [(0.08, 0.00, 0.60, 0.22)]},
        3: {"pub": [(0.04, 0.58, 0.82, 0.42)], "prv": [(0.00, 0.20, 0.58, 0.38)], "svc": [(0.58, 0.20, 0.30, 0.38), (0.16, 0.00, 0.54, 0.20)]},
        4: {"pub": [(0.20, 0.60, 0.80, 0.40)], "prv": [(0.00, 0.28, 0.70, 0.32)], "svc": [(0.12, 0.00, 0.58, 0.28)]},
        5: {"pub": [(0.08, 0.56, 0.92, 0.44)], "prv": [(0.22, 0.18, 0.78, 0.38)], "svc": [(0.00, 0.18, 0.22, 0.82), (0.10, 0.00, 0.50, 0.18)]},
    },
}


def _normalize_shape(s):
    s=(s or "rectangle").lower().replace(" ","").replace("-","")
    return {"l":"lshape","lshape":"lshape","t":"tshape","tshape":"tshape",
            "rect":"rectangle","square":"square","irregular":"irregular"}.get(s,"rectangle")


def _zone_area(zone: Tuple[float, float, float, float]) -> float:
    return max(zone[2], 0.0) * max(zone[3], 0.0)


def _take_items(group: List[str], area_map: Dict[str, List[float]], counters: Dict[str, int]):
    items = []
    for rtype in group:
        idx = counters.get(rtype, 0)
        areas = area_map.get(rtype, [10.0])
        area = areas[idx] if idx < len(areas) else areas[-1]
        counters[rtype] = idx + 1
        items.append({"type": rtype, "area": float(area)})
    return items


def _split_ratio(total: float, ratios: List[float]) -> List[float]:
    raw = [max(r, 0.01) for r in ratios]
    denom = sum(raw) or 1.0
    out = [total * (r / denom) for r in raw]
    if out:
        out[-1] += total - sum(out)
    return out


def _pack_linear(items, rect, axis):
    rx, ry, rw, rh = rect
    ratios = [item["area"] for item in items]
    sizes = _split_ratio(rw if axis == "x" else rh, ratios)
    cursor = rx if axis == "x" else ry
    placed = []
    for item, size in zip(items, sizes):
        if axis == "x":
            placed.append((item["type"], cursor, ry, size, rh))
            cursor += size
        else:
            placed.append((item["type"], rx, cursor, rw, size))
            cursor += size
    return placed


def _pack_public(items, rect):
    rx, ry, rw, rh = rect
    if len(items) <= 1:
        return [(items[0]["type"], rx, ry, rw, rh)] if items else []
    if len(items) == 2:
        return _pack_linear(items, rect, "x" if rw >= rh else "y")
    lead = items[0]
    tail = items[1:]
    if rw >= rh:
        lead_w = rw * max(0.46, min(0.62, lead["area"] / sum(item["area"] for item in items) * 1.35))
        return [(lead["type"], rx, ry, lead_w, rh)] + _pack_linear(tail, (rx + lead_w, ry, rw - lead_w, rh), "y")
    lead_h = rh * max(0.46, min(0.62, lead["area"] / sum(item["area"] for item in items) * 1.35))
    return [(lead["type"], rx, ry, rw, lead_h)] + _pack_linear(tail, (rx, ry + lead_h, rw, rh - lead_h), "x")


def _pack_private(items, rect):
    rx, ry, rw, rh = rect
    if len(items) <= 2:
        return _pack_linear(items, rect, "x" if rw >= rh else "y")
    cols = 2 if len(items) > 2 else 1
    col_items = [items[i::cols] for i in range(cols)]
    col_widths = _split_ratio(rw, [sum(item["area"] for item in col) for col in col_items])
    placed = []
    cx = rx
    for width, col in zip(col_widths, col_items):
        placed.extend(_pack_linear(col, (cx, ry, width, rh), "y"))
        cx += width
    return placed


def _pack_service(items, rect):
    if not items:
        return []
    garage_idx = next((idx for idx, item in enumerate(items) if item["type"] == "garage"), None)
    if garage_idx is None:
        bathrooms = [item for item in items if item["type"] == "bathroom"]
        others = [item for item in items if item["type"] != "bathroom"]
        rx, ry, rw, rh = rect
        # Keep sanitary rooms in a rear/top band so front edge can stay public.
        if bathrooms and others and rh >= 3.6:
            total_area = max(sum(item["area"] for item in items), 1e-6)
            bath_ratio = max(0.26, min(0.52, sum(item["area"] for item in bathrooms) / total_area))
            bath_h = rh * bath_ratio
            top_band = (rx, ry, rw, bath_h)
            lower_band = (rx, ry + bath_h, rw, rh - bath_h)
            return _pack_linear(bathrooms, top_band, "x" if top_band[2] >= top_band[3] else "y") + _pack_linear(others, lower_band, "x" if lower_band[2] >= lower_band[3] else "y")
        return _pack_linear(items, rect, "y" if rect[3] >= rect[2] else "x")
    garage = items[garage_idx]
    rest = [item for idx, item in enumerate(items) if idx != garage_idx]
    rx, ry, rw, rh = rect
    if rw >= rh:
        garage_h = rh * max(0.46, min(0.62, garage["area"] / sum(item["area"] for item in items) * 1.25))
        rest_rect = (rx, ry, rw, rh - garage_h)
        bathrooms = [item for item in rest if item["type"] == "bathroom"]
        others = [item for item in rest if item["type"] != "bathroom"]
        if bathrooms and others and rest_rect[3] >= 3.4:
            rest_total = max(sum(item["area"] for item in rest), 1e-6)
            b_ratio = max(0.24, min(0.50, sum(item["area"] for item in bathrooms) / rest_total))
            b_h = rest_rect[3] * b_ratio
            top_band = (rest_rect[0], rest_rect[1], rest_rect[2], b_h)
            lower_band = (rest_rect[0], rest_rect[1] + b_h, rest_rect[2], rest_rect[3] - b_h)
            packed_rest = _pack_linear(bathrooms, top_band, "x" if top_band[2] >= top_band[3] else "y") + _pack_linear(others, lower_band, "x" if lower_band[2] >= lower_band[3] else "y")
        else:
            packed_rest = _pack_linear(rest, rest_rect, "y")
        return [(garage["type"], rx, ry + rh - garage_h, rw, garage_h)] + packed_rest
    garage_w = rw * max(0.46, min(0.62, garage["area"] / sum(item["area"] for item in items) * 1.25))
    return [(garage["type"], rx, ry, garage_w, rh)] + _pack_linear(rest, (rx + garage_w, ry, rw - garage_w, rh), "y")


def _pack_items(items, rect, role: str):
    if not items or rect[2] < 0.5 or rect[3] < 0.5:
        return []
    if role == "pub":
        return _pack_public(items, rect)
    if role == "prv":
        return _pack_private(items, rect)
    return _pack_service(items, rect)


def _place_group(
    group: List[str],
    area_map: Dict[str, List[float]],
    counters: Dict[str, int],
    zones: List[Tuple[float, float, float, float]],
    role: str,
):
    items = _take_items(group, area_map, counters)
    if not items or not zones:
        return []
    ordered_zones = sorted(zones, key=_zone_area, reverse=True)
    assignments = [[] for _ in ordered_zones]
    remaining = [_zone_area(zone) for zone in ordered_zones]
    for idx, item in enumerate(sorted(items, key=lambda item: item["area"], reverse=True)):
        if idx < len(assignments):
            assignments[idx].append(item)
            remaining[idx] -= item["area"]
            continue
        best_idx = max(range(len(assignments)), key=lambda zone_idx: remaining[zone_idx])
        assignments[best_idx].append(item)
        remaining[best_idx] -= item["area"]

    placed = []
    for zone, zone_items in zip(ordered_zones, assignments):
        zone_items.sort(key=lambda item: item["area"], reverse=True)
        placed.extend(_pack_items(zone_items, zone, role))
    return placed


def _orient_room(rtype,rx,ry,rw,rh,ox,oy,fw,fh,site:Site)->str:
    cx=rx+rw/2-ox; cy=ry+rh/2-oy
    climate=_climate(site.lat,site.sun_h)
    sunny=_sunny(site.lat); shade=_shade(site.lat)
    wind_c=_d2c(_brg(site.wind))
    # Eco overrides
    if rtype=="living": return shade if climate=="hot" else sunny
    if rtype=="dining": return shade if climate=="hot" else sunny
    if rtype=="kitchen": return "E"
    if rtype=="bedroom": return "E"
    if rtype=="office": return shade
    if rtype in("bathroom","utility"): return wind_c
    if rtype=="garage": return "W"
    # Fallback: nearest perimeter face
    faces=[("N",cy),("S",fh-cy),("W",cx),("E",fw-cx)]
    return min(faces,key=lambda f:f[1])[0]


def _make_layout(types:List[str],area_map:Dict[str,List[float]],
                 site:Site,total_area:float,floors:int,shape:str,vi:int)->List[Room]:
    s=_normalize_shape(shape)
    fw,fh=_fp(site,total_area,floors)
    ox=max(0,(site.w-fw)/2); oy=max(0,(site.h-fh)/2)

    zone_fracs = ZONE_LIBRARY.get(s, ZONE_LIBRARY["rectangle"]).get(vi, ZONE_LIBRARY["rectangle"][0])

    # Separate into classes
    pub=[r for r in types if CLASS.get(r)=="pub"]
    prv=[r for r in types if CLASS.get(r)=="prv"]
    svc=[r for r in types if CLASS.get(r)=="svc"]

    counters:Dict[str,int]={}
    placed:List[Tuple[str,float,float,float,float]]=[]

    for cls, group in [("pub", pub), ("prv", prv), ("svc", svc)]:
        if not group: continue
        zones = []
        for zfx, zfy, zfw, zfh in zone_fracs.get(cls, [(0.0, 0.0, 1.0, 1.0)]):
            zones.append((ox + zfx * fw, oy + zfy * fh, zfw * fw, zfh * fh))
        placed += _place_group(group, area_map, counters, zones, cls)

    # Convert to Room objects
    rooms:List[Room]=[]
    fcounts:Dict[str,int]={}
    for rtype,rx,ry,rw,rh in placed:
        if rw<0.4 or rh<0.4: continue
        fcounts[rtype]=fcounts.get(rtype,0)+1
        rid=f"{rtype}_1_{fcounts[rtype]}"
        orient=_orient_room(rtype,rx,ry,rw,rh,ox,oy,fw,fh,site)
        rooms.append(Room(id=rid,type=rtype,
            width=round(rw,2),height=round(rh,2),
            x=round(rx,2),y=round(ry,2),floor=1,orientation=orient))
    return rooms


# ── Geometry ─────────────────────────────────────────────────────────────────
def _ov(a0,a1,b0,b1): return max(0.0,min(a1,b1)-max(a0,b0))

def _explicit_geometry(rooms:List[Room],site:Optional[Site]=None):
    walls:List[Wall]=[]; doors:List[Door]=[]; windows:List[Window]=[]
    wi=dri=wni=1; added=set()

    for room in rooms:
        for edge,(x1,y1,x2,y2) in [
            ("top",   (room.x,room.y,room.x+room.width,room.y)),
            ("bottom",(room.x,room.y+room.height,room.x+room.width,room.y+room.height)),
            ("left",  (room.x,room.y,room.x,room.y+room.height)),
            ("right", (room.x+room.width,room.y,room.x+room.width,room.y+room.height)),
        ]:
            key=(room.floor,round(x1,3),round(y1,3),round(x2,3),round(y2,3))
            rev=(room.floor,round(x2,3),round(y2,3),round(x1,3),round(y1,3))
            if rev in added: continue
            added.add(key)
            shared=any(
                o.id!=room.id and o.floor==room.floor and (
                    (edge in("top","bottom") and (
                        (abs(y1-o.y)<0.09 and _ov(x1,x2,o.x,o.x+o.width)>0.3) or
                        (abs(y1-(o.y+o.height))<0.09 and _ov(x1,x2,o.x,o.x+o.width)>0.3)
                    )) or
                    (edge in("left","right") and (
                        (abs(x1-o.x)<0.09 and _ov(y1,y2,o.y,o.y+o.height)>0.3) or
                        (abs(x1-(o.x+o.width))<0.09 and _ov(y1,y2,o.y,o.y+o.height)>0.3)
                    ))
                ) for o in rooms
            )
            length=abs(x2-x1) if edge in("top","bottom") else abs(y2-y1)
            walls.append(Wall(
                id=f"wall_{wi}",room_id=room.id or room.type,
                type="interior" if shared else "exterior",
                orientation="horizontal" if edge in("top","bottom") else "vertical",
                x=round((x1+x2)/2,2),y=round((y1+y2)/2,2),
                x2=round(x2,2),y2=round(y2,2),length=round(length,2),
                thickness=WALL_INT if shared else WALL_EXT,
                floor=room.floor,height=FLOOR_H,
            )); wi+=1

    for i,a in enumerate(rooms):
        for b in rooms[i+1:]:
            if a.floor!=b.floor: continue
            oy=_ov(a.y,a.y+a.height,b.y,b.y+b.height)
            ox2=_ov(a.x,a.x+a.width,b.x,b.x+b.width)
            shared_x = None
            if abs((a.x+a.width)-b.x)<0.09:
                shared_x = b.x
            elif abs((b.x+b.width)-a.x)<0.09:
                shared_x = a.x

            shared_y = None
            if abs((a.y+a.height)-b.y)<0.09:
                shared_y = b.y
            elif abs((b.y+b.height)-a.y)<0.09:
                shared_y = a.y

            if shared_x is not None and oy>0.45:
                dy=max(a.y,b.y)+oy/2
                doors.append(Door(id=f"door_{dri}",room_to=b.id or b.type,type="interior",
                    x=round(shared_x,2),y=round(dy,2),width=max(0.75,min(0.95,oy*0.55)),
                    orientation="vertical",symbol="arc_swing",floor=a.floor)); dri+=1
            elif shared_y is not None and ox2>0.45:
                dx=max(a.x,b.x)+ox2/2
                doors.append(Door(id=f"door_{dri}",room_to=b.id or b.type,type="interior",
                    x=round(dx,2),y=round(shared_y,2),width=max(0.75,min(0.95,ox2*0.55)),
                    orientation="horizontal",symbol="arc_swing",floor=a.floor)); dri+=1

    # Ensure functional circulation even when room ordering weakens pair-based adjacency detection.
    interior_target = max(6, len([r for r in rooms if r.floor == 1]) // 2)
    if len(doors) < interior_target:
        existing = {(round(float(d.x), 2), round(float(d.y), 2), d.orientation) for d in doors}
        interior_segments = sorted(
            [w for w in walls if w.type == "interior" and w.floor == 1 and w.length >= 1.0],
            key=lambda w: w.length,
            reverse=True,
        )
        for wall in interior_segments:
            if len(doors) >= interior_target:
                break
            sig = (round(float(wall.x), 2), round(float(wall.y), 2), wall.orientation)
            if sig in existing:
                continue
            doors.append(Door(
                id=f"door_{dri}",
                room_to="adjacent_room",
                type="interior",
                x=round(float(wall.x), 2),
                y=round(float(wall.y), 2),
                width=max(0.75, min(0.95, float(wall.length) * 0.35)),
                orientation=wall.orientation,
                symbol="arc_swing",
                floor=1,
            ))
            existing.add(sig)
            dri += 1
    if rooms:
        floor1 = [r for r in rooms if r.floor == 1]
        preferred = [r for r in floor1 if r.type in ("living", "dining", "office", "kitchen")]
        if preferred:
            candidates = preferred
        else:
            non_service = [r for r in floor1 if r.type not in ("bathroom", "utility", "puja_room")]
            candidates = non_service if non_service else floor1
        front=min(candidates,key=lambda r:-(r.y+r.height))
        doors.append(Door(id=f"door_{dri}",room_to=front.id or front.type,type="entry",
            x=round(front.x+front.width/2,2),y=round(front.y+front.height,2),
            width=1.2,orientation="horizontal",symbol="double_door",floor=1)); dri+=1

    climate=_climate(site.lat if site else 10.0, site.sun_h if site else 8.0) if site else "temperate"
    for room in rooms:
        avail=[]
        for edge,(ex,ey,ew,eh) in [
            ("top",   (room.x,room.y,room.width,0)),
            ("bottom",(room.x,room.y+room.height,room.width,0)),
            ("left",  (room.x,room.y,0,room.height)),
            ("right", (room.x+room.width,room.y,0,room.height)),
        ]:
            is_shared=any(
                o.id!=room.id and o.floor==room.floor and (
                    (edge in("top","bottom") and
                     (abs(ey-o.y)<0.09 or abs(ey-(o.y+o.height))<0.09) and
                     _ov(ex,ex+ew,o.x,o.x+o.width)>0.35) or
                    (edge in("left","right") and
                     (abs(ex-o.x)<0.09 or abs(ex-(o.x+o.width))<0.09) and
                     _ov(ey,ey+eh,o.y,o.y+o.height)>0.35)
                ) for o in rooms
            )
            span=ew if edge in("top","bottom") else eh
            if not is_shared and span>0.8: avail.append((edge,span))
        if not avail: continue
        sun=_sunny(site.lat if site else 10.0)
        face_pref={"living":[sun,"E","W"],"dining":[sun,"E"],"bedroom":["E","N","S"],
                   "kitchen":["E","N"],"office":["N","E"],"bathroom":["N","W"],
                   "utility":["N","W"],"garage":["W","N"],"puja_room":["E","N"]}.get(room.type,[])
        face_map={"top":"N","bottom":"S","left":"W","right":"E"}
        avail.sort(key=lambda e:face_pref.index(face_map.get(e[0],"N")) if face_map.get(e[0]) in face_pref else 9)
        placed_w=[]
        for edge,span in avail:
            if len(placed_w)>=2: break
            wwr=_wwr(climate,room.type)
            ww=round(min(2.8,max(0.55,span*wwr)),2)
            sill=0.85 if room.type not in("bathroom","utility") else 1.5
            windows.append(Window(id=f"win_{wni}",wall=f"{room.id}_{edge}",
                position=0.5,width=ww,floor=room.floor,sill_height=sill,head_height=2.10)); wni+=1
            placed_w.append(edge)
            if room.type in("living","bedroom","dining","office") and len(placed_w)<2:
                for e2,s2 in avail:
                    if e2 not in placed_w:
                        ww2=round(min(1.6,max(0.45,s2*wwr*0.6)),2)
                        windows.append(Window(id=f"win_{wni}",wall=f"{room.id}_{e2}_vent",
                            position=0.5,width=ww2,floor=room.floor,sill_height=1.2,head_height=2.10)); wni+=1
                        placed_w.append(e2); break
            break
    return walls,doors,windows


def _window_face(wall_id: str) -> str:
    parts = wall_id.split("_")
    if not parts:
        return ""
    if parts[-1] == "vent" and len(parts) >= 2:
        return parts[-2]
    return parts[-1]

def _score(rooms:List[Room],site:Site,windows:List[Window])->Dict[str,float]:
    if not rooms: return {"solar":0.5,"ventilation":0.5,"eco":0.5}
    climate=_climate(site.lat,site.sun_h); sunny=_sunny(site.lat)
    pub=[r for r in rooms if CLASS.get(r.type)=="pub"]
    hab=[r for r in rooms if r.type in("living","dining","bedroom","office")]
    solar=0.0
    for r in pub:
        rb=_brg(r.orientation); sb=_brg(sunny)
        s=max(0,math.cos(math.radians(_adiff(rb,sb))))
        solar+=s if climate!="hot" else 1-s
    solar/=max(len(pub),1)
    wind_brg=_brg(site.wind); vent=0.0
    for r in hab:
        rw={_window_face(w.wall) for w in windows if w.wall.startswith(r.id or r.type)}
        has2=len(rw-{""})>=2
        has_wind=any(_adiff(_brg(f.upper()),wind_brg)<90 for f in rw if len(f)==1 or len(f)==2)
        vent+=1.0 if(has2 and has_wind) else 0.5 if has2 else 0.2
    vent/=max(len(hab),1)
    xs=[r.x for r in rooms]+[r.x+r.width for r in rooms]
    ys=[r.y for r in rooms]+[r.y+r.height for r in rooms]
    ta=sum(r.width*r.height for r in rooms)
    bbox=(max(xs)-min(xs))*(max(ys)-min(ys)) or ta
    compact=ta/bbox
    svc=[r for r in rooms if r.type in("kitchen","bathroom","utility")]
    sc=0.0
    if len(svc)>1:
        pairs=[(i,j) for i in range(len(svc)) for j in range(i+1,len(svc))]
        ad=sum(math.dist((svc[i].x+svc[i].width/2,svc[i].y+svc[i].height/2),
                         (svc[j].x+svc[j].width/2,svc[j].y+svc[j].height/2))
               for i,j in pairs)/max(len(pairs),1)
        sc=max(0,1-ad/12.0)
    struct=0.6*max(0,1-site.slope/25)+0.4*max(0,1-site.flood)
    eco=0.25*solar+0.25*vent+0.18*compact+0.14*sc+0.10*struct+0.08
    return {"solar":round(solar,3),"ventilation":round(vent,3),"eco":round(min(0.99,eco),3)}


def _stable_seed(req: GenerateFloorPlanRequest, site: Site, total: float, shape: str, house_type: str) -> int:
    if req.ga_seed is not None:
        return int(req.ga_seed)
    payload = f"{req.plot_id}|{total:.2f}|{shape}|{house_type}|{site.lat:.5f}|{site.lon:.5f}|{site.wind}|{site.slope:.3f}|{site.flood:.3f}"
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]
    return int(digest, 16)


def _room_overlap_ratio(rooms: List[Room]) -> float:
    if not rooms:
        return 0.0
    total = sum(max(0.0, r.width * r.height) for r in rooms) or 1.0
    overlap = 0.0
    for i in range(len(rooms)):
        a = rooms[i]
        for b in rooms[i + 1:]:
            if a.floor != b.floor:
                continue
            ox = _ov(a.x, a.x + a.width, b.x, b.x + b.width)
            oy = _ov(a.y, a.y + a.height, b.y, b.y + b.height)
            overlap += ox * oy
    return overlap / total


def _repair_layout(rooms: List[Room], site: Site, total: float, floors: int) -> List[Room]:
    if not rooms:
        return rooms
    fw, fh = _fp(site, total, floors)
    ox = max(0.0, (site.w - fw) / 2)
    oy = max(0.0, (site.h - fh) / 2)

    fixed: List[Room] = []
    for r in rooms:
        if r.type == "bathroom":
            min_w, min_h = 2.2, 2.1
        elif r.type in ("utility", "puja_room"):
            min_w, min_h = 2.0, 2.0
        else:
            min_w, min_h = 2.2, 2.2
        w = max(min_w, min(r.width, fw))
        h = max(min_h, min(r.height, fh))
        max_ar = 2.4 if r.type == "bathroom" else 3.1
        if w / max(h, 1e-6) > max_ar:
            h = min(fh, max(min_h, w / max_ar))
        if h / max(w, 1e-6) > max_ar:
            w = min(fw, max(min_w, h / max_ar))
        x = min(max(r.x, ox), ox + fw - w)
        y = min(max(r.y, oy), oy + fh - h)
        fixed.append(Room(id=r.id, type=r.type, width=round(w, 2), height=round(h, 2), x=round(x, 2), y=round(y, 2), floor=r.floor, orientation=r.orientation))

    for _ in range(10):
        moved = False
        for i in range(len(fixed)):
            a = fixed[i]
            for j in range(i + 1, len(fixed)):
                b = fixed[j]
                if a.floor != b.floor:
                    continue
                oxv = _ov(a.x, a.x + a.width, b.x, b.x + b.width)
                oyv = _ov(a.y, a.y + a.height, b.y, b.y + b.height)
                if oxv * oyv <= 0.005:
                    continue
                nx = min(max(b.x + oxv + 0.15, ox), ox + fw - b.width)
                ny = min(max(b.y + oyv + 0.15, oy), oy + fh - b.height)
                fixed[j] = Room(id=b.id, type=b.type, width=b.width, height=b.height, x=round(nx, 2), y=round(ny, 2), floor=b.floor, orientation=b.orientation)
                moved = True
        if not moved:
            break
    return fixed


def _select_low_overlap_layout(base_layout: List[Room], site: Site, total: float, floors: int) -> List[Room]:
    if not base_layout:
        return base_layout
    repaired = _repair_layout(base_layout, site, total, floors)
    base_overlap = _room_overlap_ratio(base_layout)
    repaired_overlap = _room_overlap_ratio(repaired)
    return repaired if repaired_overlap + 1e-6 < base_overlap else base_layout


def _layout_penalty(rooms: List[Room], site: Site, total: float, floors: int) -> float:
    if not rooms:
        return 1.0
    fw, fh = _fp(site, total, floors)
    ox = max(0.0, (site.w - fw) / 2)
    oy = max(0.0, (site.h - fh) / 2)
    total_area = sum(r.width * r.height for r in rooms)
    area_dev = abs(total_area - total) / max(total, 1.0)
    overlap = _room_overlap_ratio(rooms)
    out_of_bounds = 0.0
    for r in rooms:
        if r.x < ox - 1e-6 or r.y < oy - 1e-6 or r.x + r.width > ox + fw + 1e-6 or r.y + r.height > oy + fh + 1e-6:
            out_of_bounds += 1.0
    return min(1.0, 0.45 * area_dev + 0.45 * overlap + 0.10 * (out_of_bounds / max(len(rooms), 1)))


def _mutate_types(types: List[str], rng: random.Random) -> List[str]:
    pub = [t for t in types if CLASS.get(t) == "pub"]
    prv = [t for t in types if CLASS.get(t) == "prv"]
    svc = [t for t in types if CLASS.get(t) == "svc"]
    rng.shuffle(pub)
    rng.shuffle(prv)
    rng.shuffle(svc)
    return pub + prv + svc


def _mutate_area_map(types: List[str], base_map: Dict[str, List[float]], total: float, rng: random.Random) -> Dict[str, List[float]]:
    counters: Dict[str, int] = {}
    items = []
    for t in types:
        i = counters.get(t, 0)
        vals = base_map.get(t, [RMIN.get(t, 4.0)])
        v = vals[i] if i < len(vals) else vals[-1]
        counters[t] = i + 1
        jitter = rng.uniform(0.88, 1.12)
        nv = max(RMIN.get(t, 4.0), min(RMAX.get(t, 30.0), v * jitter))
        items.append((t, nv))
    s = sum(v for _, v in items) or 1.0
    scaled = [(t, v * total / s) for t, v in items]
    out: Dict[str, List[float]] = {}
    for t, v in scaled:
        out.setdefault(t, []).append(round(v, 2))
    return out


def _ga_search_variants(
    req: GenerateFloorPlanRequest,
    site: Site,
    total: float,
    floors: int,
    shape: str,
    types: List[str],
    base_amap: Dict[str, List[float]],
) -> Tuple[List[FloorPlanVariant], int]:
    budget_ms = max(1200, min(int(req.ga_time_budget_ms or 2500), 8000))
    seed = _stable_seed(req, site, total, shape, req.house_type or "Eco-Villa (Single Story)")
    rng = random.Random(seed)
    start = time.perf_counter()

    pop_size = 18
    elitism = 3
    max_gens = 80

    population = []
    for i in range(pop_size):
        population.append({
            "variant": i % 6,
            "types": _mutate_types(types[:], rng) if i > 5 else types[:],
            "amap": _mutate_area_map(types, base_amap, total, rng) if i > 5 else base_amap,
        })

    def evaluate(ind):
        raw_layout = _make_layout(ind["types"], ind["amap"], site, total, floors, shape, ind["variant"])
        layout = _select_low_overlap_layout(raw_layout, site, total, floors)
        if not layout:
            return None
        if _room_overlap_ratio(layout) > 0.02:
            return None
        walls, doors, windows = _explicit_geometry(layout, site)
        scores = _score(layout, site, windows)
        penalty = _layout_penalty(layout, site, total, floors)
        bonus = 0.015 * min(1.0, site.ndvi) if req.preserve_trees else 0.0
        fitness = max(0.0, scores["eco"] + bonus - penalty)
        return {
            "layout": layout,
            "walls": walls,
            "doors": doors,
            "windows": windows,
            "scores": scores,
            "fitness": round(fitness, 4),
            "variant": ind["variant"],
        }

    best_snapshots = []
    gen = 0
    while gen < max_gens and (time.perf_counter() - start) * 1000 < budget_ms:
        scored = []
        for ind in population:
            ev = evaluate(ind)
            if ev:
                scored.append((ev["fitness"], ind, ev))
        if not scored:
            break
        scored.sort(key=lambda x: x[0], reverse=True)
        best_snapshots.extend([s[2] for s in scored[:2]])
        best_snapshots = sorted(best_snapshots, key=lambda x: x["fitness"], reverse=True)[:14]

        elites = [s[1] for s in scored[:elitism]]
        next_pop = [{"variant": e["variant"], "types": e["types"][:], "amap": e["amap"]} for e in elites]
        top = scored[: max(6, len(scored) // 2)]
        while len(next_pop) < pop_size:
            p1 = rng.choice(top)[1]
            p2 = rng.choice(top)[1]
            child_types = p1["types"][:] if rng.random() < 0.5 else p2["types"][:]
            if rng.random() < 0.8:
                child_types = _mutate_types(child_types, rng)
            child_amap = p1["amap"] if rng.random() < 0.5 else p2["amap"]
            if rng.random() < 0.85:
                child_amap = _mutate_area_map(child_types, child_amap, total, rng)
            child_variant = p1["variant"] if rng.random() < 0.5 else p2["variant"]
            if rng.random() < 0.35:
                child_variant = (child_variant + rng.choice([-1, 1])) % 6
            next_pop.append({"variant": child_variant, "types": child_types, "amap": child_amap})

        population = next_pop
        gen += 1

    if not best_snapshots:
        return [], 0

    uniq = []
    seen = set()
    for cand in best_snapshots:
        sig = tuple((r.type, r.x, r.y, r.width, r.height, r.orientation) for r in cand["layout"])
        if sig in seen:
            continue
        seen.add(sig)
        uniq.append(cand)
        if len(uniq) >= 6:
            break
    if not uniq:
        return [], 0

    variants: List[FloorPlanVariant] = []
    for i, cand in enumerate(uniq):
        va = round(sum(r.width * r.height for r in cand["layout"]), 1)
        variants.append(FloorPlanVariant(
            id=i + 1,
            algorithm="Legacy-GA",
            style=f"GA Evolution {i + 1}",
            layout=cand["layout"],
            total_area=va,
            solar_score=cand["scores"]["solar"],
            ventilation_score=cand["scores"]["ventilation"],
            fitness_score=cand["fitness"],
            eco_score=cand["fitness"],
            walls=cand["walls"],
            doors=cand["doors"],
            windows=cand["windows"],
            is_best=False,
        ))

    bidx = max(range(len(variants)), key=lambda i: variants[i].fitness_score)
    variants[bidx].is_best = True
    return variants, bidx

async def _load_site(req:GenerateFloorPlanRequest,db:AsyncSession)->Site:
    lat,lon,wind,slope,flood,ndvi,sun_h=10.0,76.0,"SW",4.0,0.25,0.45,8.0
    elevation,rainfall,solar_rad,clay_pct,buildability=120.0,1200.0,5.2,25.0,72.0
    soil_ph,bulk_density,wind_speed_ms,distance_to_water=6.8,1.4,4.0,1000.0
    tree_coordinates: List[dict] = []
    polygon: List[List[float]] = []
    sw=sh=math.sqrt(req.plot_area_sqm or 150)*1.8
    try:
        r=await db.execute(select(AnalysisRecord).where(AnalysisRecord.plot_id==req.plot_id).order_by(desc(AnalysisRecord.created_at)))
        a=r.scalars().first()
        if a:
            slope=float(a.slope or slope); flood=float(a.flood_probability or flood)
            ndvi=float(a.ndvi or ndvi); wind=str(a.wind_direction or wind)
            elevation=float(a.elevation or elevation)
            rainfall=float(a.rainfall_mm or rainfall)
            buildability=float(a.buildability_score or buildability)
            tree_coordinates=list(a.tree_coordinates or [])
            raw=a.raw_features or {}
            lat=float(raw.get("_lat",raw.get("lat",lat))); lon=float(raw.get("_lon",raw.get("lon",lon)))
            sun_h=float(raw.get("sun_exposure_hours",a.sun_exposure_hours or sun_h))
            solar_rad=float(raw.get("solar_radiation", raw.get("solar_radiation_kwh", solar_rad)))
            clay_pct=float(raw.get("clay_pct", clay_pct))
            soil_ph=float(raw.get("soil_ph", soil_ph))
            bulk_density=float(raw.get("bulk_density", bulk_density))
            wind_speed_ms=float(raw.get("wind_ms", raw.get("wind_speed_ms", wind_speed_ms)))
            distance_to_water=float(raw.get("distance_to_water_m", distance_to_water))
    except Exception as e: logger.warning("site: %s",e)
    try:
        r2=await db.execute(select(PlotRecord).where(PlotRecord.plot_id==req.plot_id))
        p=r2.scalars().first()
        if p and p.polygon:
            raw_pts=[list(c[:2]) for c in p.polygon if isinstance(c,(list,tuple)) and len(c)>=2]
            target_area=float(req.plot_area_sqm or 0.0)
            candidates: List[Tuple[List[List[float]], float, float, float]] = []

            # Accept both [lon, lat] and [lat, lon] payloads and choose
            # the mapping that best matches the requested plot area.
            for lon_idx, lat_idx in ((0,1),(1,0)):
                norm_pts: List[List[float]] = []
                valid=True
                for pt in raw_pts:
                    try:
                        lon_v=float(pt[lon_idx]); lat_v=float(pt[lat_idx])
                    except (TypeError, ValueError, IndexError):
                        valid=False; break
                    if not (-180.0<=lon_v<=180.0 and -90.0<=lat_v<=90.0):
                        valid=False; break
                    norm_pts.append([lon_v, lat_v])
                if not valid or len(norm_pts)<3:
                    continue

                lon0=sum(v[0] for v in norm_pts)/len(norm_pts)
                lat0=sum(v[1] for v in norm_pts)/len(norm_pts)
                m_lon=111320*math.cos(math.radians(lat0))
                xs=[(v[0]-lon0)*m_lon for v in norm_pts]
                ys=[(v[1]-lat0)*111320 for v in norm_pts]
                w=max(abs(max(xs)-min(xs)),0.1)
                h=max(abs(max(ys)-min(ys)),0.1)
                area_est=w*h
                score=abs(area_est-target_area) if target_area>0 else -area_est
                candidates.append((norm_pts, w, h, score))

            if candidates:
                best_pts, bw, bh, _ = min(candidates, key=lambda item: item[3])
                sw=max(bw,8.0); sh=max(bh,8.0)
                polygon=best_pts
            elif len(raw_pts)>=3:
                # Fallback for already-projected local coordinates in meters.
                numeric_pts: List[List[float]] = []
                for pt in raw_pts:
                    try:
                        numeric_pts.append([float(pt[0]), float(pt[1])])
                    except (TypeError, ValueError, IndexError):
                        pass
                if len(numeric_pts)>=3:
                    xs=[v[0] for v in numeric_pts]; ys=[v[1] for v in numeric_pts]
                    sw=max(abs(max(xs)-min(xs)),8.0)
                    sh=max(abs(max(ys)-min(ys)),8.0)
                    polygon=numeric_pts
    except Exception as e: logger.warning("plot: %s",e)
    return Site(
        sw,sh,lat,lon,wind,slope,flood,ndvi,sun_h,
        elevation=elevation,
        rainfall_mm=rainfall,
        solar_radiation=solar_rad,
        clay_pct=clay_pct,
        soil_ph=soil_ph,
        bulk_density=bulk_density,
        wind_speed_ms=wind_speed_ms,
        distance_to_water=distance_to_water,
        buildability=buildability,
        tree_coordinates=tree_coordinates,
        polygon=polygon,
    )

VNAMES=["Solar Court","Breeze Bar","Compact Core","Split Privacy","L Courtyard","Garden Verandah"]


def _build_correction_env(
    req: GenerateFloorPlanRequest,
    site: Site,
    total: float,
    shape: str,
) -> Dict[str, Any]:
    return {
        "plot_id": req.plot_id,
        "lat": site.lat,
        "lon": site.lon,
        "plot_area_sqm": total,
        "plot_w": site.w,
        "plot_h": site.h,
        "plot_polygon": site.polygon,
        "flood_probability": site.flood,
        "buildability_score": site.buildability,
        "slope": site.slope,
        "elevation": site.elevation,
        "rainfall_mm": site.rainfall_mm,
        "wind_direction": site.wind,
        "wind_speed_ms": site.wind_speed_ms,
        "sun_exposure_hours": site.sun_h,
        "ndvi": site.ndvi,
        "clay_pct": site.clay_pct,
        "soil_ph": site.soil_ph,
        "bulk_density": site.bulk_density,
        "distance_to_water_m": site.distance_to_water,
        "solar_radiation": site.solar_radiation,
        "solar_radiation_kwh": site.solar_radiation,
        "tree_coordinates": site.tree_coordinates,
        "preserve_trees": req.preserve_trees,
        "plot_shape": shape,
        "room_preferences": req.room_preferences or {},
    }


def _criterion_score_from_audit_payload(audit_payload: Dict[str, Any], criterion_id: int, default_score: float = 0.0) -> float:
    for row in list(audit_payload.get("criteria", []) or []):
        if int(row.get("criterion_id", -1)) == int(criterion_id):
            return float(row.get("score", default_score))
    return float(default_score)


def _history_to_schema(history: IterationHistory, variant_index_map: Dict[int, int]) -> Dict[str, Any]:
    def _room_payload(room: Any) -> Dict[str, Any]:
        if isinstance(room, dict):
            return dict(room)
        try:
            return asdict(room)
        except Exception:
            return {
                "id": getattr(room, "id", None),
                "type": str(getattr(room, "type", "")),
                "width": float(getattr(room, "width", 0.0)),
                "height": float(getattr(room, "height", 0.0)),
                "x": float(getattr(room, "x", 0.0)),
                "y": float(getattr(room, "y", 0.0)),
                "floor": int(getattr(room, "floor", 1)),
                "orientation": str(getattr(room, "orientation", "S")),
            }

    def _window_payload(window: Any) -> Dict[str, Any]:
        if isinstance(window, dict):
            return dict(window)
        try:
            return asdict(window)
        except Exception:
            return {
                "id": getattr(window, "id", None),
                "wall": str(getattr(window, "wall", "")),
                "position": float(getattr(window, "position", 0.5)),
                "width": float(getattr(window, "width", 1.0)),
                "floor": int(getattr(window, "floor", 1)),
                "sill_height": float(getattr(window, "sill_height", 0.9)),
                "head_height": float(getattr(window, "head_height", 2.1)),
            }

    def _wall_payload(wall: Any) -> Dict[str, Any]:
        if isinstance(wall, dict):
            return dict(wall)
        try:
            return asdict(wall)
        except Exception:
            return {
                "id": getattr(wall, "id", None),
                "room_id": str(getattr(wall, "room_id", "")),
                "type": str(getattr(wall, "type", "interior")),
                "orientation": str(getattr(wall, "orientation", "horizontal")),
                "x": float(getattr(wall, "x", 0.0)),
                "y": float(getattr(wall, "y", 0.0)),
                "length": float(getattr(wall, "length", 0.0)),
                "thickness": float(getattr(wall, "thickness", 0.12)),
                "floor": int(getattr(wall, "floor", 1)),
            }

    snapshots: List[Dict[str, Any]] = []
    for snap in history.snapshots:
        correction_payload: Optional[Dict[str, Any]] = None
        if snap.correction is not None:
            correction_payload = {
                "iteration": int(snap.correction.iteration),
                "mutations_applied": [asdict(mutation) for mutation in (snap.correction.mutations_applied or [])],
                "n_mutations": int(snap.correction.n_mutations),
                "criteria_targeted": [int(c) for c in (snap.correction.criteria_targeted or [])],
                "eco_score_before": float(snap.correction.eco_score_before),
                "eco_score_after": float(snap.correction.eco_score_after),
                "score_delta": float(snap.correction.score_delta),
                "improvement": bool(snap.correction.improvement),
            }

        snapshot_rooms = [_room_payload(room) for room in list(getattr(snap.chromosome, "rooms", []) or [])]
        snapshot_windows = [_window_payload(window) for window in list(getattr(snap.chromosome, "windows", []) or [])]
        snapshot_walls = [_wall_payload(wall) for wall in list(generate_walls(list(getattr(snap.chromosome, "rooms", []) or [])) or [])]
        snapshot_audit = asdict(snap.audit)

        snapshots.append(
            {
                "iteration": int(snap.iteration),
                "eco_score": float(snap.audit.composite_eco_score),
                "n_criteria_passed": int(snap.audit.n_criteria_passed),
                "n_criteria_failed": int(snap.audit.n_criteria_failed),
                "correction": correction_payload,
                "cumulative_fixes": list(snap.cumulative_fixes or []),
                "audit": snapshot_audit,
                "rooms": snapshot_rooms,
                "windows": snapshot_windows,
                "walls": snapshot_walls,
                "variant_index": variant_index_map.get(int(snap.iteration)),
            }
        )

    return {
        "total_iterations": int(history.total_iterations),
        "converged": bool(history.converged),
        "convergence_reason": str(history.convergence_reason),
        "initial_eco_score": float(history.initial_eco_score),
        "final_eco_score": float(history.final_eco_score),
        "total_improvement": float(history.total_improvement),
        "eco_score_curve": [float(v) for v in (history.eco_score_curve or [])],
        "snapshots": snapshots,
        "corrections_applied": list(history.corrections_applied or []),
    }


def _build_response_from_correction_history(
    req: GenerateFloorPlanRequest,
    site: Site,
    method: str,
    chromosomes: List[Any],
    history: IterationHistory,
    env_data: Dict[str, Any],
) -> FloorPlanResponse:
    def _layout_signature(layout: List[Room]) -> Tuple[Tuple[str, float, float, float, float, int], ...]:
        rows: List[Tuple[str, float, float, float, float, int]] = []
        for room in list(layout or []):
            rows.append(
                (
                    str(getattr(room, "type", "")),
                    round(float(getattr(room, "x", 0.0)), 2),
                    round(float(getattr(room, "y", 0.0)), 2),
                    round(float(getattr(room, "width", 0.0)), 2),
                    round(float(getattr(room, "height", 0.0)), 2),
                    int(getattr(room, "floor", 1)),
                )
            )
        rows.sort()
        return tuple(rows)

    algorithm_variants: List[FloorPlanVariant] = []
    for idx, chrom in enumerate(chromosomes):
        payload = chromosome_to_response(chrom, idx, env_data)
        audit = run_eco_audit(
            variant_id=idx + 100,
            algorithm=str(payload.get("algorithm", "NSGA-III")),
            rooms=list(payload.get("layout", []) or []),
            walls=list(payload.get("walls", []) or []),
            doors=list(payload.get("doors", []) or []),
            windows=list(payload.get("windows", []) or []),
            env=env_data,
        )
        audit_payload = asdict(audit)
        payload["eco_audit"] = audit_payload
        payload["eco_score"] = round(float(audit.composite_eco_score) / 100.0, 3)
        payload["fitness_score"] = round(float(payload["eco_score"]), 3)
        payload["solar_score"] = round(_criterion_score_from_audit_payload(audit_payload, 1, payload.get("solar_score", 0.0)) / 100.0, 3)
        payload["ventilation_score"] = round(_criterion_score_from_audit_payload(audit_payload, 2, payload.get("ventilation_score", 0.0)) / 100.0, 3)
        payload["structural_score"] = round(_criterion_score_from_audit_payload(audit_payload, 3, payload.get("structural_score", 0.0)) / 100.0, 3)
        payload["flood_score"] = round(_criterion_score_from_audit_payload(audit_payload, 5, payload.get("flood_score", 0.0)) / 100.0, 3)
        payload["tree_score"] = round(_criterion_score_from_audit_payload(audit_payload, 7, payload.get("tree_score", 0.0)) / 100.0, 3)
        payload["is_best"] = False
        algorithm_variants.append(FloorPlanVariant(**payload))

    final_payload = chromosome_to_response(history.final_chromosome, 0, env_data)
    final_audit_payload = asdict(history.final_audit)
    final_payload["id"] = 0
    final_payload["algorithm"] = str(getattr(history.final_chromosome, "algorithm", "NSGA-III"))
    final_payload["style"] = "Eco-Corrected (Best)"
    final_payload["is_best"] = True
    final_payload["eco_audit"] = final_audit_payload
    final_payload["eco_score"] = round(float(history.final_audit.composite_eco_score) / 100.0, 3)
    final_payload["fitness_score"] = round(float(final_payload["eco_score"]), 3)
    final_payload["solar_score"] = round(_criterion_score_from_audit_payload(final_audit_payload, 1, final_payload.get("solar_score", 0.0)) / 100.0, 3)
    final_payload["ventilation_score"] = round(_criterion_score_from_audit_payload(final_audit_payload, 2, final_payload.get("ventilation_score", 0.0)) / 100.0, 3)
    final_payload["structural_score"] = round(_criterion_score_from_audit_payload(final_audit_payload, 3, final_payload.get("structural_score", 0.0)) / 100.0, 3)
    final_payload["flood_score"] = round(_criterion_score_from_audit_payload(final_audit_payload, 5, final_payload.get("flood_score", 0.0)) / 100.0, 3)
    final_payload["tree_score"] = round(_criterion_score_from_audit_payload(final_audit_payload, 7, final_payload.get("tree_score", 0.0)) / 100.0, 3)
    final_variant = FloorPlanVariant(**final_payload)

    variants: List[FloorPlanVariant] = []
    seen_layouts: set[Tuple[Tuple[str, float, float, float, float, int], ...]] = set()
    for candidate in [final_variant] + algorithm_variants:
        sig = _layout_signature(list(candidate.layout or []))
        if sig in seen_layouts:
            continue
        seen_layouts.add(sig)
        variants.append(candidate)

    for idx, variant in enumerate(variants):
        variant.id = idx + 1
        variant.is_best = idx == 0

    variant_layout_index = {
        _layout_signature(list(variant.layout or [])): idx
        for idx, variant in enumerate(variants)
    }
    snapshot_variant_index_map: Dict[int, int] = {}
    for snap in history.snapshots:
        snap_sig = _layout_signature(list(getattr(snap.chromosome, "rooms", []) or []))
        mapped_index = variant_layout_index.get(snap_sig)
        if mapped_index is not None:
            snapshot_variant_index_map[int(snap.iteration)] = mapped_index

    iteration_history_schema = _history_to_schema(history, snapshot_variant_index_map)
    algorithms_used = [str(getattr(chrom, "algorithm", "NSGA-III")) for chrom in chromosomes]
    algorithm_curves = {
        variant.algorithm: [float(v) for v in (variant.convergence_curve or [])]
        for variant in algorithm_variants
    }
    convergence_data: Dict[str, Any] = {
        "eco_score_curve": [float(v) for v in (history.eco_score_curve or [])],
        "total_iterations": int(history.total_iterations),
        "converged": bool(history.converged),
        "convergence_reason": str(history.convergence_reason),
        "total_improvement": float(history.total_improvement),
        "corrections_applied": list(history.corrections_applied or []),
        "algorithm_curves": algorithm_curves,
    }

    best_variant = variants[0]
    return FloorPlanResponse(
        plot_id=req.plot_id,
        layout=best_variant.layout,
        walls=best_variant.walls,
        doors=best_variant.doors,
        windows=best_variant.windows,
        total_area=round(sum(room.width * room.height for room in best_variant.layout), 1),
        fitness_score=float(best_variant.fitness_score),
        eco_score=float(best_variant.eco_score),
        solar_score=float(best_variant.solar_score),
        generation_count=int(history.total_iterations),
        sunlight_score=float(best_variant.solar_score),
        ventilation_score=float(best_variant.ventilation_score),
        structural_score=float(best_variant.structural_score),
        flood_score=float(best_variant.flood_score),
        tree_score=float(best_variant.tree_score),
        tree_preserved_count=max(0, len(site.tree_coordinates)) if req.preserve_trees else 0,
        orientation_degrees=float(_brg(site.wind)),
        variants=variants,
        best_variant_index=0,
        algorithms_used=algorithms_used,
        convergence_data=convergence_data,
        iteration_history=iteration_history_schema,
        generation_method=method,
    )


async def _persist_floorplan_response(
    req: GenerateFloorPlanRequest,
    db: AsyncSession,
    response: FloorPlanResponse,
) -> None:
    try:
        payload = response.model_dump()
        db.add(
            FloorPlanRecord(
                plot_id=req.plot_id,
                layout_json=payload,
                fitness_score=float(response.fitness_score),
                generation_count=int(response.generation_count),
            )
        )
        await db.commit()
    except Exception as e:
        logger.warning("persist: %s", e)
        try:
            await db.rollback()
        except Exception:
            pass

async def generate_floor_plan(req:GenerateFloorPlanRequest,db:AsyncSession)->FloorPlanResponse:
    site=await _load_site(req,db)
    total=round(max(req.plot_area_sqm or 150.0,45.0),1)
    floors=max(1,min(req.num_floors or 1,4))
    house_type=req.house_type or "Eco-Villa (Single Story)"
    types=_prog(total,req.room_preferences,house_type)
    amap=_alloc(types,total,house_type)
    shape=req.plot_shape or "rectangle"
    method=_normalize_generation_method(req.generation_method)
    variants:List[FloorPlanVariant]=[]; bidx=0
    beco=-1.0
    algorithms_used: List[str] = []
    convergence_data: Dict[str, Any] = {}

    # Primary GA path: iterative eco-correction loop over the 5-algorithm GA seed.
    if method == "ga":
        correction_env = _build_correction_env(req, site, total, shape)
        try:
            loop = asyncio.get_running_loop()
            chromosomes = await loop.run_in_executor(None, run_all_algorithms, correction_env)
            if chromosomes:
                history = await loop.run_in_executor(
                    None,
                    run_correction_loop,
                    chromosomes[0],
                    correction_env,
                    req.max_iterations or 12,
                    req.target_eco_score or 92.0,
                )
                response = _build_response_from_correction_history(
                    req=req,
                    site=site,
                    method=method,
                    chromosomes=chromosomes,
                    history=history,
                    env_data=correction_env,
                )
                await _persist_floorplan_response(req, db, response)
                return response
        except Exception as e:
            logger.warning("correction-loop pipeline fallback: %s", e)

    if method == "ga":
        ga_plot_w, ga_plot_h = _fp(site, total, floors)
        ga_polygon: List[List[float]] = []
        if req.layout_mode == "fit_boundary" and site.polygon:
            boundary_aspect = max(site.w, site.h) / max(min(site.w, site.h), 1e-6)
            boundary_capacity = max(site.w * site.h, 1.0)
            target_floor_area = max(total / max(floors, 1), 1.0)
            boundary_too_tight = boundary_capacity < target_floor_area * 0.70
            if boundary_aspect <= 3.2 and not boundary_too_tight:
                ga_plot_w, ga_plot_h = site.w, site.h
                ga_polygon = site.polygon
            else:
                ga_plot_w, ga_plot_h = _ga_regularized_envelope(total, floors, shape)
                logger.warning(
                    "ga boundary envelope regularized (aspect %.2f, capacity %.1f for target %.1f)",
                    boundary_aspect,
                    boundary_capacity,
                    target_floor_area,
                )

        ga_site = Site(
            ga_plot_w,
            ga_plot_h,
            site.lat,
            site.lon,
            site.wind,
            site.slope,
            site.flood,
            site.ndvi,
            site.sun_h,
            elevation=site.elevation,
            rainfall_mm=site.rainfall_mm,
            solar_radiation=site.solar_radiation,
            clay_pct=site.clay_pct,
            buildability=site.buildability,
            tree_coordinates=site.tree_coordinates,
            polygon=ga_polygon,
        )

        env_data = {
            "lat": site.lat,
            "lon": site.lon,
            "plot_area_sqm": total,
            "plot_w": ga_plot_w,
            "plot_h": ga_plot_h,
            "plot_polygon": ga_polygon,
            "flood_probability": site.flood,
            "buildability_score": site.buildability,
            "slope": site.slope,
            "elevation": site.elevation,
            "rainfall_mm": site.rainfall_mm,
            "wind_direction": site.wind,
            "sun_exposure_hours": site.sun_h,
            "ndvi": site.ndvi,
            "clay_pct": site.clay_pct,
            "solar_radiation": site.solar_radiation,
            "tree_coordinates": site.tree_coordinates,
            "preserve_trees": req.preserve_trees,
            "plot_shape": shape,
            "room_preferences": req.room_preferences or {},
        }
        try:
            loop = asyncio.get_running_loop()
            raw_variants = await loop.run_in_executor(None, generate_floor_plan_variants, env_data)
        except Exception as e:
            logger.warning("ga-engine: %s", e)
            raw_variants = []

        relaxed_ga_variants: List[FloorPlanVariant] = []

        for raw in raw_variants[:5]:
            try:
                algo_name = str(raw.get("algorithm", "NSGA-III"))
                algo_types = types[:]
                algo_amap = _alloc(algo_types, total, house_type)
                algo_variant_index = _ga_variant_index_for_algorithm(algo_name)

                raw_layout = _make_layout(algo_types, algo_amap, ga_site, total, floors, shape, algo_variant_index)
                layout = _select_low_overlap_layout(raw_layout, ga_site, total, floors)
                if len(layout) < 3:
                    logger.warning("ga variant rejected: insufficient room count (%s)", len(layout))
                    continue

                walls, doors, windows = _explicit_geometry(layout, ga_site)
                interior_walls = [w for w in walls if w.type == "interior"]

                scores = _score(layout, ga_site, windows)
                total_area = float(sum(r.width * r.height for r in layout))
                overlap_ratio = _room_overlap_ratio(layout)

                strict_ok = (
                    len(interior_walls) >= max(8, len(layout) - 2)
                    and len(doors) >= max(6, len(layout) // 2)
                    and len(windows) >= max(3, len(layout) // 3)
                    and total_area >= max(45.0, total * 0.82)
                    and overlap_ratio <= 0.01
                )
                relaxed_ok = (
                    len(interior_walls) >= max(5, len(layout) // 2)
                    and len(doors) >= max(4, len(layout) // 3)
                    and len(windows) >= max(3, len(layout) // 4)
                    and total_area >= max(45.0, total * 0.72)
                    and overlap_ratio <= 0.02
                )
                if not strict_ok and not relaxed_ok:
                    logger.warning(
                        "ga variant rejected: topology too weak (walls=%s, doors=%s, windows=%s, area=%.1f, overlap=%.4f)",
                        len(interior_walls),
                        len(doors),
                        len(windows),
                        total_area,
                        overlap_ratio,
                    )
                    continue
                structural_layout = max(0.0, min(1.0, (1.0 - overlap_ratio) * max(0.15, 1.0 - ga_site.slope / 35.0)))
                structural_score = max(float(raw.get("structural_score", 0.0)), structural_layout)
                flood_score = max(float(raw.get("flood_score", 0.0)), max(0.0, min(1.0, 1.0 - ga_site.flood + 0.08)))
                tree_score = max(float(raw.get("tree_score", 0.0)), max(0.0, min(1.0, ga_site.ndvi + (0.08 if req.preserve_trees else 0.0))))
                eco_score = min(
                    0.99,
                    0.28 * scores["solar"]
                    + 0.22 * scores["ventilation"]
                    + 0.20 * structural_score
                    + 0.15 * flood_score
                    + 0.10 * tree_score
                    + 0.05 * max(0.0, min(1.0, ga_site.buildability / 100.0)),
                )

                candidate = FloorPlanVariant(
                    id=int(raw.get("id", len(variants) + 1)),
                    algorithm=algo_name,
                    style=str(raw.get("style", f"GA Variant {len(variants) + 1}")),
                    layout=layout,
                    walls=walls,
                    doors=doors,
                    windows=windows,
                    total_area=round(total_area, 1),
                    eco_score=round(float(eco_score), 3),
                    solar_score=round(float(scores["solar"]), 3),
                    ventilation_score=round(float(scores["ventilation"]), 3),
                    structural_score=round(float(structural_score), 3),
                    flood_score=round(float(flood_score), 3),
                    tree_score=round(float(tree_score), 3),
                    fitness_score=round(float(eco_score), 3),
                    is_best=False,
                    convergence_curve=[float(v) for v in raw.get("convergence_curve", [])],
                    generations_run=int(raw.get("generations_run", 0)),
                    converged_early=bool(raw.get("converged_early", False)),
                    runtime_ms=int(raw.get("runtime_ms", 0)),
                )
                if strict_ok:
                    variants.append(candidate)
                else:
                    relaxed_ga_variants.append(candidate)
            except Exception as e:
                logger.warning("ga variant map: %s", e)

        if len(variants) < 3 and relaxed_ga_variants:
            relaxed_ga_variants.sort(key=lambda v: float(v.eco_score), reverse=True)
            existing_algos = {v.algorithm for v in variants}
            for cand in relaxed_ga_variants:
                if cand.algorithm in existing_algos:
                    continue
                variants.append(cand)
                existing_algos.add(cand.algorithm)
                if len(variants) >= 5:
                    break

        if variants:
            variants.sort(key=lambda v: float(v.eco_score), reverse=True)
            for i, variant in enumerate(variants):
                variant.id = i + 1
                if variant.algorithm.lower() == "deterministic":
                    variant.algorithm = "GA"
                variant.is_best = i == 0
            bidx = 0
            algorithms_used = [variant.algorithm for variant in variants]
            convergence_data = {
                variant.algorithm: [float(v) for v in (variant.convergence_curve or [])]
                for variant in variants
            }

        # Resilient fallback: if the primary GA engine returns no valid variants,
        # use the legacy GA search path before dropping to deterministic.
        if not variants:
            try:
                legacy_variants, legacy_best_idx = _ga_search_variants(req, ga_site, total, floors, shape, types, amap)
            except Exception as e:
                logger.warning("legacy-ga-engine: %s", e)
                legacy_variants, legacy_best_idx = [], 0

            if legacy_variants:
                variants = legacy_variants
                bidx = max(0, min(legacy_best_idx, len(variants) - 1))
                for i, variant in enumerate(variants):
                    variant.id = i + 1
                    if variant.algorithm.lower() == "deterministic":
                        variant.algorithm = "Legacy-GA"
                    variant.is_best = i == bidx
                algorithms_used = [variant.algorithm for variant in variants]
                convergence_data = {
                    variant.algorithm: [float(variant.fitness_score)]
                    for variant in variants
                }

    # Safe fallback to deterministic if GA returns no valid candidates.
    if not variants:
        method = "deterministic"
        for vi in range(6):
            layout=_make_layout(types,amap,site,total,floors,shape,vi)
            if not layout: continue
            walls,doors,windows=_explicit_geometry(layout,site)
            scores=_score(layout,site,windows)
            va=round(sum(r.width*r.height for r in layout),1)
            overlap_ratio = _room_overlap_ratio(layout)
            structural_score = max(0.0, min(1.0, (1.0 - overlap_ratio) * max(0.15, 1.0 - site.slope / 35.0)))
            flood_score = max(0.0, min(1.0, 1.0 - site.flood + 0.08))
            tree_score = max(0.0, min(1.0, site.ndvi + (0.08 if req.preserve_trees else 0.0)))
            eco = min(
                0.99,
                0.28 * scores["solar"]
                + 0.22 * scores["ventilation"]
                + 0.20 * structural_score
                + 0.15 * flood_score
                + 0.10 * tree_score
                + 0.05 * max(0.0, min(1.0, site.buildability / 100.0)),
            )
            variants.append(FloorPlanVariant(
                id=vi+1,algorithm="Deterministic",style=VNAMES[vi],layout=layout,total_area=va,
                solar_score=scores["solar"],ventilation_score=scores["ventilation"],
                structural_score=round(structural_score, 3),
                flood_score=round(flood_score, 3),
                tree_score=round(tree_score, 3),
                fitness_score=round(eco, 3),eco_score=round(eco, 3),
                walls=walls,doors=doors,windows=windows,is_best=False,
                convergence_curve=[round(eco, 3)],
                generations_run=1,
                converged_early=True,
                runtime_ms=0,
            ))
            if eco>beco: beco=eco; bidx=len(variants)-1

    if variants:
        variants.sort(key=lambda v: float(v.eco_score), reverse=True)
        for i, variant in enumerate(variants):
            variant.id = i + 1
            variant.is_best = i == 0
        bidx = 0

    if variants:
        for variant in variants:
            try:
                audit_env_data = {
                    "lat": site.lat,
                    "lon": site.lon,
                    "elevation": site.elevation,
                    "slope": site.slope,
                    "flood_probability": site.flood,
                    "wind_direction": site.wind,
                    "wind_speed_ms": site.wind_speed_ms,
                    "sun_exposure_hours": site.sun_h,
                    "solar_radiation_kwh": site.solar_radiation,
                    "rainfall_mm": site.rainfall_mm,
                    "ndvi": site.ndvi,
                    "clay_pct": site.clay_pct,
                    "soil_ph": site.soil_ph,
                    "bulk_density": site.bulk_density,
                    "distance_to_water_m": site.distance_to_water,
                    "tree_coordinates": site.tree_coordinates,
                    "plot_area_sqm": total,
                    "plot_polygon": site.polygon,
                }
                audit = run_eco_audit(
                    variant_id=int(variant.id),
                    algorithm=getattr(variant, "algorithm", "GA"),
                    rooms=list(variant.layout or []),
                    walls=list(variant.walls or []),
                    doors=list(variant.doors or []),
                    windows=list(variant.windows or []),
                    env=audit_env_data,
                )
                audit_payload = asdict(audit)
                criteria = audit_payload.get("criteria", [])
                c1 = next((c for c in criteria if int(c.get("criterion_id", -1)) == 1), None)
                c2 = next((c for c in criteria if int(c.get("criterion_id", -1)) == 2), None)

                variant.eco_audit = EcoAuditReportSchema.model_validate(audit_payload)
                variant.eco_score = round(float(audit_payload.get("composite_eco_score", 0.0)) / 100.0, 3)
                variant.fitness_score = round(float(variant.eco_score), 3)
                if c1 is not None:
                    variant.solar_score = round(float(c1.get("score", variant.solar_score * 100.0)) / 100.0, 3)
                if c2 is not None:
                    variant.ventilation_score = round(float(c2.get("score", variant.ventilation_score * 100.0)) / 100.0, 3)
            except Exception as e:
                logger.warning("eco-audit variant %s failed: %s", getattr(variant, "id", "?"), e)
                variant.eco_audit = None

        variants.sort(key=lambda v: float(v.eco_score), reverse=True)
        for i, variant in enumerate(variants):
            variant.id = i + 1
            variant.is_best = i == 0
        bidx = 0

    if not variants: raise ValueError("No variants generated")
    variants[bidx].is_best=True; best=variants[bidx]
    if not algorithms_used:
        algorithms_used = [variant.algorithm for variant in variants]
    if not convergence_data:
        convergence_data = {
            variant.algorithm: [float(v) for v in (variant.convergence_curve or [])]
            for variant in variants
        }

    try:
        db.add(FloorPlanRecord(
            plot_id=req.plot_id,
            layout_json={"layout":[r.model_dump() for r in best.layout],
                         "walls":[w.model_dump() for w in best.walls or []],
                         "doors":[d.model_dump() for d in best.doors or []],
                         "windows":[w.model_dump() for w in best.windows or []],
                         "generation_method": method,
                         "algorithms_used": algorithms_used,
                         "convergence_data": convergence_data,
                         "variants":[v.model_dump() for v in variants]},
            fitness_score=float(best.fitness_score),generation_count=len(variants),
        ))
        await db.commit()
    except Exception as e:
        logger.warning("persist: %s",e)
        try: await db.rollback()
        except: pass
    return FloorPlanResponse(
        plot_id=req.plot_id,layout=best.layout,walls=best.walls,doors=best.doors,windows=best.windows,
        total_area=round(sum(r.width*r.height for r in best.layout),1),
        fitness_score=float(best.fitness_score),eco_score=float(best.eco_score),
        solar_score=float(best.solar_score),
        generation_count=len(variants),sunlight_score=float(best.solar_score),
        ventilation_score=float(best.ventilation_score),
        structural_score=float(best.structural_score),
        flood_score=float(best.flood_score),
        tree_score=float(best.tree_score),
        tree_preserved_count=max(0,len(site.tree_coordinates)) if req.preserve_trees else 0,
        orientation_degrees=float(_brg(site.wind)),variants=variants,best_variant_index=bidx,
        algorithms_used=algorithms_used,
        convergence_data=convergence_data,
        generation_method=method,
    )
