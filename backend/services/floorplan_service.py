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
import logging, math, random, time, hashlib
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import desc, select
from database.models import AnalysisRecord, FloorPlanRecord, PlotRecord
from models.schemas import Door, FloorPlanResponse, FloorPlanVariant, GenerateFloorPlanRequest, Room, Wall, Window

logger = logging.getLogger(__name__)
WALL_EXT = 0.23; WALL_INT = 0.12; FLOOR_H = 3.0

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

# ── Footprint ────────────────────────────────────────────────────────────────
def _fp(site:Site,area:float,floors:int)->Tuple[float,float]:
    a=max(area/max(floors,1),30.0)
    uw=max(site.w-1.8,6.0); uh=max(site.h-1.8,6.0)
    r=min(max(uw/max(uh,1),0.6),2.0)
    w=math.sqrt(a*r); h=a/max(w,1)
    if w>uw: w=uw; h=a/w
    if h>uh: h=uh; w=a/h
    return min(w,uw),min(h,uh)

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
        return _pack_linear(items, rect, "y" if rect[3] >= rect[2] else "x")
    garage = items[garage_idx]
    rest = [item for idx, item in enumerate(items) if idx != garage_idx]
    rx, ry, rw, rh = rect
    if rw >= rh:
        garage_h = rh * max(0.46, min(0.62, garage["area"] / sum(item["area"] for item in items) * 1.25))
        return [(garage["type"], rx, ry + rh - garage_h, rw, garage_h)] + _pack_linear(rest, (rx, ry, rw, rh - garage_h), "y")
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
            if abs((a.x+a.width)-b.x)<0.09 and oy>0.7:
                dy=max(a.y,b.y)+oy/2
                doors.append(Door(id=f"door_{dri}",room_to=b.id or b.type,type="interior",
                    x=round(b.x,2),y=round(dy,2),width=min(0.9,oy*0.55),
                    orientation="vertical",symbol="arc_swing",floor=a.floor)); dri+=1
            elif abs((a.y+a.height)-b.y)<0.09 and ox2>0.7:
                dx=max(a.x,b.x)+ox2/2
                doors.append(Door(id=f"door_{dri}",room_to=b.id or b.type,type="interior",
                    x=round(dx,2),y=round(b.y,2),width=min(0.9,ox2*0.55),
                    orientation="horizontal",symbol="arc_swing",floor=a.floor)); dri+=1
    if rooms:
        front=min((r for r in rooms if r.floor==1),key=lambda r:-(r.y+r.height))
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
        min_w = 1.8 if r.type in ("bathroom", "utility", "puja_room") else 2.2
        min_h = 1.8 if r.type in ("bathroom", "utility", "puja_room") else 2.2
        w = max(min_w, min(r.width, fw))
        h = max(min_h, min(r.height, fh))
        x = min(max(r.x, ox), ox + fw - w)
        y = min(max(r.y, oy), oy + fh - h)
        fixed.append(Room(id=r.id, type=r.type, width=round(w, 2), height=round(h, 2), x=round(x, 2), y=round(y, 2), floor=r.floor, orientation=r.orientation))

    for _ in range(3):
        moved = False
        for i in range(len(fixed)):
            a = fixed[i]
            for j in range(i + 1, len(fixed)):
                b = fixed[j]
                if a.floor != b.floor:
                    continue
                oxv = _ov(a.x, a.x + a.width, b.x, b.x + b.width)
                oyv = _ov(a.y, a.y + a.height, b.y, b.y + b.height)
                if oxv * oyv <= 0.01:
                    continue
                nx = min(max(b.x + oxv + 0.15, ox), ox + fw - b.width)
                ny = min(max(b.y + oyv + 0.15, oy), oy + fh - b.height)
                fixed[j] = Room(id=b.id, type=b.type, width=b.width, height=b.height, x=round(nx, 2), y=round(ny, 2), floor=b.floor, orientation=b.orientation)
                moved = True
        if not moved:
            break
    return fixed


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
        layout = _make_layout(ind["types"], ind["amap"], site, total, floors, shape, ind["variant"])
        layout = _repair_layout(layout, site, total, floors)
        if not layout:
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
    sw=sh=math.sqrt(req.plot_area_sqm or 150)*1.8
    try:
        r=await db.execute(select(AnalysisRecord).where(AnalysisRecord.plot_id==req.plot_id).order_by(desc(AnalysisRecord.created_at)))
        a=r.scalars().first()
        if a:
            slope=float(a.slope or slope); flood=float(a.flood_probability or flood)
            ndvi=float(a.ndvi or ndvi); wind=str(a.wind_direction or wind)
            raw=a.raw_features or {}
            lat=float(raw.get("_lat",raw.get("lat",lat))); lon=float(raw.get("_lon",raw.get("lon",lon)))
            sun_h=float(raw.get("sun_exposure_hours",a.sun_exposure_hours or sun_h))
    except Exception as e: logger.warning("site: %s",e)
    try:
        r2=await db.execute(select(PlotRecord).where(PlotRecord.plot_id==req.plot_id))
        p=r2.scalars().first()
        if p and p.polygon:
            pts=p.polygon; cx=sum(c[0] for c in pts)/len(pts); cy=sum(c[1] for c in pts)/len(pts)
            lm=111320*math.cos(math.radians(cy))
            xs=[(c[0]-cx)*lm for c in pts]; ys=[(c[1]-cy)*111320 for c in pts]
            sw=max(abs(max(xs)-min(xs)),8.0); sh=max(abs(max(ys)-min(ys)),8.0)
    except Exception as e: logger.warning("plot: %s",e)
    return Site(sw,sh,lat,lon,wind,slope,flood,ndvi,sun_h)

VNAMES=["Solar Court","Breeze Bar","Compact Core","Split Privacy","L Courtyard","Garden Verandah"]

async def generate_floor_plan(req:GenerateFloorPlanRequest,db:AsyncSession)->FloorPlanResponse:
    site=await _load_site(req,db)
    total=round(max(req.plot_area_sqm or 150.0,45.0),1)
    floors=max(1,min(req.num_floors or 1,4))
    house_type=req.house_type or "Eco-Villa (Single Story)"
    types=_prog(total,req.room_preferences,house_type)
    amap=_alloc(types,total,house_type)
    shape=req.plot_shape or "rectangle"
    method=(req.generation_method or "deterministic").strip().lower()
    variants:List[FloorPlanVariant]=[]; bidx=0; beco=-1.0

    if method == "ga":
        variants, bidx = _ga_search_variants(req, site, total, floors, shape, types, amap)

    # Safe fallback to deterministic if GA returns no valid candidates.
    if not variants:
        method = "deterministic"
        for vi in range(6):
            layout=_make_layout(types,amap,site,total,floors,shape,vi)
            if not layout: continue
            walls,doors,windows=_explicit_geometry(layout,site)
            scores=_score(layout,site,windows)
            va=round(sum(r.width*r.height for r in layout),1)
            variants.append(FloorPlanVariant(
                id=vi+1,style=VNAMES[vi],layout=layout,total_area=va,
                solar_score=scores["solar"],ventilation_score=scores["ventilation"],
                fitness_score=scores["eco"],eco_score=scores["eco"],
                walls=walls,doors=doors,windows=windows,is_best=False,
            ))
            if scores["eco"]>beco: beco=scores["eco"]; bidx=len(variants)-1
    if not variants: raise ValueError("No variants generated")
    variants[bidx].is_best=True; best=variants[bidx]
    try:
        db.add(FloorPlanRecord(
            plot_id=req.plot_id,
            layout_json={"layout":[r.model_dump() for r in best.layout],
                         "walls":[w.model_dump() for w in best.walls or []],
                         "doors":[d.model_dump() for d in best.doors or []],
                         "windows":[w.model_dump() for w in best.windows or []],
                         "generation_method": method,
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
        generation_count=len(variants),sunlight_score=float(best.solar_score),
        ventilation_score=float(best.ventilation_score),
        tree_preserved_count=max(0,int(round(site.ndvi*8))+(2 if req.preserve_trees else 0)),
        orientation_degrees=float(_brg(site.wind)),variants=variants,best_variant_index=bidx,
        generation_method=method,
    )
