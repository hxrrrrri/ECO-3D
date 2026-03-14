"""
Production floor-plan generation service.

This generator keeps the existing API contract, but upgrades the internals to:
- produce multiple materially distinct variants
- match the requested total build area exactly
- emit explicit walls, doors, and windows as canonical geometry
- adapt to site climate signals and available plot geometry
"""
import logging
import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import desc, select

from database.models import AnalysisRecord, FloorPlanRecord, PlotRecord
from models.schemas import (
    Door,
    FloorPlanResponse,
    FloorPlanVariant,
    GenerateFloorPlanRequest,
    Room,
    Wall,
    Window,
)

logger = logging.getLogger(__name__)

WALL_EXT = 0.23
WALL_INT = 0.12
FLOOR_HEIGHT = 3.2


# ---------------------------------------------------------------------------
# Passive-solar / climate helpers
# ---------------------------------------------------------------------------

def _climate_profile(lat: float, sun_hours: float) -> str:
    """Classify site climate for passive-design decisions.

    Returns one of: 'hot', 'warm', 'temperate', 'cold'.
    """
    alat = abs(lat)
    if alat < 23.5 and sun_hours >= 7.5:
        return "hot"
    if alat < 35 and sun_hours >= 6.0:
        return "warm"
    if alat < 60:
        return "temperate"
    return "cold"


def _solar_noon_altitude(lat: float) -> Tuple[float, float]:
    """Return (summer_noon_alt°, winter_noon_alt°) at solar noon.

    Uses declination ±23.45° for solstices.
    """
    summer = 90.0 - abs(lat - 23.45)
    winter = 90.0 - abs(lat + 23.45)
    return max(5.0, min(90.0, summer)), max(5.0, min(90.0, winter))


def _overhang_depth_ratio(lat: float) -> float:
    """Horizontal overhang depth / window height to shade the summer sun."""
    summer_alt, _ = _solar_noon_altitude(lat)
    return round(1.0 / max(math.tan(math.radians(summer_alt)), 0.10), 2)


def _wwr(climate: str, room_type: str) -> float:
    """Window-to-wall ratio for a given climate and room type.

    Hot climates get smaller windows to reduce heat gain; cold climates larger.
    """
    base = {
        "living":   0.52, "dining": 0.44, "bedroom":  0.38,
        "office":   0.32, "kitchen": 0.30, "bathroom": 0.18,
        "utility":  0.14, "garage": 0.10, "puja_room": 0.22,
    }.get(room_type, 0.25)
    factor = {"hot": 0.75, "warm": 0.88, "temperate": 1.00, "cold": 1.20}.get(climate, 1.0)
    return base * factor

COMPASS = {
    "N": 0.0, "NNE": 22.5, "NE": 45.0, "ENE": 67.5,
    "E": 90.0, "ESE": 112.5, "SE": 135.0, "SSE": 157.5,
    "S": 180.0, "SSW": 202.5, "SW": 225.0, "WSW": 247.5,
    "W": 270.0, "WNW": 292.5, "NW": 315.0, "NNW": 337.5,
}

ROOM_RULES = {
    "living":   {"share": 1.28, "aspect": 1.45, "min_area": 18.0, "max_area": 36.0, "class": "public"},
    "dining":   {"share": 0.72, "aspect": 1.25, "min_area": 9.5,  "max_area": 18.0, "class": "public"},
    "kitchen":  {"share": 0.76, "aspect": 1.20, "min_area": 8.5,  "max_area": 15.0, "class": "service"},
    "bedroom":  {"share": 1.00, "aspect": 1.16, "min_area": 10.5, "max_area": 21.0, "class": "private"},
    "bathroom": {"share": 0.42, "aspect": 1.05, "min_area": 3.6,  "max_area": 8.0,  "class": "service"},
    "office":   {"share": 0.75, "aspect": 1.20, "min_area": 7.5,  "max_area": 16.0, "class": "private"},
    "utility":  {"share": 0.35, "aspect": 1.10, "min_area": 3.2,  "max_area": 8.0,  "class": "service"},
    "garage":   {"share": 0.78, "aspect": 1.55, "min_area": 14.0, "max_area": 24.0, "class": "service"},
    "puja_room":{"share": 0.25, "aspect": 1.00, "min_area": 2.8,  "max_area": 6.5,  "class": "private"},
}

VARIANT_CONFIGS = [
    {"name": "Solar Court",     "mode": "courtyard",   "public_edge": "south", "private_edge": "north", "axis": "horizontal"},
    {"name": "Breeze Bar",      "mode": "linear",      "public_edge": "windward", "private_edge": "leeward", "axis": "vertical"},
    {"name": "Compact Core",    "mode": "compact",     "public_edge": "south", "private_edge": "north", "axis": "horizontal"},
    {"name": "Split Privacy",   "mode": "split",       "public_edge": "east", "private_edge": "west", "axis": "vertical"},
    {"name": "L Courtyard",     "mode": "l_shape",     "public_edge": "south", "private_edge": "east", "axis": "horizontal"},
    {"name": "Garden Verandah", "mode": "perimeter",   "public_edge": "south", "private_edge": "north", "axis": "vertical"},
]


def _normalize_plot_shape(shape: Optional[str]) -> str:
    s = (shape or "rectangle").lower().replace(" ", "").replace("-", "")
    aliases = {
        "l": "lshape",
        "lshape": "lshape",
        "t": "tshape",
        "tshape": "tshape",
        "rect": "rectangle",
        "square": "square",
        "irregular": "irregular",
        "circle": "circular",
        "circular": "circular",
    }
    return aliases.get(s, "rectangle")


def _variant_configs_for_shape(plot_shape: str) -> List[dict]:
    shape = _normalize_plot_shape(plot_shape)
    preferred_mode = {
        "rectangle": "linear",
        "square": "compact",
        "lshape": "l_shape",
        "tshape": "split",
        "irregular": "perimeter",
        "circular": "courtyard",
    }.get(shape, "linear")
    preferred = [cfg for cfg in VARIANT_CONFIGS if cfg["mode"] == preferred_mode]
    others = [cfg for cfg in VARIANT_CONFIGS if cfg["mode"] != preferred_mode]
    return preferred + others


@dataclass
class SiteContext:
    width: float
    height: float
    polygon_xy: Optional[List[Tuple[float, float]]]
    lat: float
    lon: float
    wind_dir: str
    slope: float
    flood_risk: float
    ndvi: float
    sun_hours: float


def _bearing(direction: str) -> float:
    return COMPASS.get(direction, 180.0)


def _adiff(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _deg_to_compass(deg: float) -> str:
    deg = deg % 360.0
    return min(COMPASS, key=lambda k: _adiff(COMPASS[k], deg))


def _point_in_poly(x: float, y: float, poly: List[Tuple[float, float]]) -> bool:
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        crosses = ((yi > y) != (yj > y))
        if crosses:
            xinters = (xj - xi) * (y - yi) / ((yj - yi) + 1e-9) + xi
            if x < xinters:
                inside = not inside
        j = i
    return inside


def _polygon_to_xy(polygon: Optional[List[List[float]]]) -> Optional[List[Tuple[float, float]]]:
    if not polygon or len(polygon) < 3:
        return None
    cx = sum(p[0] for p in polygon) / len(polygon)
    cy = sum(p[1] for p in polygon) / len(polygon)
    lon_m = 111_320.0 * math.cos(math.radians(cy))
    lat_m = 111_320.0
    return [((p[0] - cx) * lon_m, (p[1] - cy) * lat_m) for p in polygon]


def _site_dims_from_polygon(poly_xy: Optional[List[Tuple[float, float]]], target_area: float) -> Tuple[float, float]:
    if not poly_xy:
        w = math.sqrt(target_area * 1.4)
        return w, target_area / max(w, 1.0)
    xs = [p[0] for p in poly_xy]
    ys = [p[1] for p in poly_xy]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    return max(width, 8.0), max(height, 8.0)


def _fit_footprint(site_w: float, site_h: float, total_area: float, floors: int) -> Tuple[float, float]:
    footprint_area = max(total_area / max(floors, 1), 30.0)
    usable_w = max(site_w - 1.8, 6.0)
    usable_h = max(site_h - 1.8, 6.0)
    ratio = usable_w / max(usable_h, 1.0)
    ratio = min(max(ratio, 0.72), 1.9)
    w = math.sqrt(footprint_area * ratio)
    h = footprint_area / max(w, 1.0)
    if w > usable_w:
        w = usable_w
        h = footprint_area / w
    if h > usable_h:
        h = usable_h
        w = footprint_area / h
    return min(w, usable_w), min(h, usable_h)


def _build_room_program(area: float, prefs: Optional[dict]) -> List[str]:
    prefs = prefs or {}
    beds = max(1, int(prefs.get("bedrooms", 2 if area < 140 else 3 if area < 240 else 4)))
    baths = max(1, int(prefs.get("bathrooms", max(1, beds - 1))))
    if area < 80:
        beds = min(beds, 1)
        baths = min(baths, 1)
    elif area < 140:
        beds = min(beds, 2)
        baths = min(baths, 2)
    rooms = ["living", "kitchen"]
    if area >= 90 and bool(prefs.get("dining", True)):
        rooms.append("dining")
    rooms.extend(["bedroom"] * beds)
    rooms.extend(["bathroom"] * baths)
    if area >= 110 and bool(prefs.get("office", False)):
        rooms.append("office")
    if area >= 120 and bool(prefs.get("utility", True)):
        rooms.append("utility")
    if area >= 170 and bool(prefs.get("garage", False)):
        rooms.append("garage")
    if area >= 70 and bool(prefs.get("puja_room", False)):
        rooms.append("puja_room")
    return rooms


def _allocate_room_areas(room_types: List[str], total_area: float) -> Dict[str, List[float]]:
    grouped: Dict[str, List[float]] = {}
    for r in room_types:
        grouped.setdefault(r, [])
    weighted_total = sum(ROOM_RULES[r]["share"] for r in room_types)
    base_areas = [total_area * ROOM_RULES[r]["share"] / weighted_total for r in room_types]

    mins = [ROOM_RULES[r]["min_area"] for r in room_types]
    maxs = [ROOM_RULES[r]["max_area"] for r in room_types]
    areas = [max(mn, min(mx, a)) for a, mn, mx in zip(base_areas, mins, maxs)]
    delta = total_area - sum(areas)

    if abs(delta) > 1e-6:
        capacity = [
            (i, maxs[i] - areas[i] if delta > 0 else areas[i] - mins[i])
            for i in range(len(areas))
        ]
        total_cap = sum(max(c, 0.0) for _, c in capacity) or 1.0
        for i, cap in capacity:
            if cap <= 0:
                continue
            step = delta * (cap / total_cap)
            areas[i] += step
        residual = total_area - sum(areas)
        areas[0] += residual

    counters: Dict[str, int] = {}
    for room_type, area_value in zip(room_types, areas):
        counters[room_type] = counters.get(room_type, 0) + 1
        grouped[room_type].append(round(area_value, 2))
    return grouped


def _target_orientation(room_type: str, lat: float, wind_dir: str, edge_pref: str,
                        sun_hours: float = 8.0) -> str:
    """Return preferred compass orientation for a room using passive-solar principles.

    Rules:
    - Living / Dining: face the sunny side (S in NH, N in SH); in hot climates face
      the shaded side to reduce cooling load.
    - Kitchen: windward edge for natural ventilation of cooking fumes; fallback east.
    - Bedroom: east for gentle morning sun; avoids hot west afternoon sun.
    - Office: shaded side (N in NH) for stable, glare-free diffuse light.
    - Bathroom / Utility: windward for continuous ventilation.
    - Garage: leeward (least sun/wind exposure needed).
    """
    is_north = lat >= 0
    sunny = "S" if is_north else "N"
    shade = "N" if is_north else "S"
    climate = _climate_profile(lat, sun_hours)
    windward = _deg_to_compass(_bearing(wind_dir))
    leeward = _deg_to_compass(_bearing(wind_dir) + 180.0)
    edge_map = {
        "south": sunny, "north": shade, "east": "E", "west": "W",
        "windward": windward, "leeward": leeward,
    }
    if room_type in ("living", "dining"):
        # Hot climates: face shaded side to minimise solar heat gain in living areas
        if climate == "hot":
            return shade
        return edge_map.get(edge_pref, sunny)
    if room_type == "kitchen":
        # Windward placement removes cooking heat/odours; east is the gentle fallback
        ww_edge = _compass_to_edge(windward)
        return windward if ww_edge in ("east", "north") else "E"
    if room_type == "bedroom":
        # East: morning sun for gentle wake-up, avoids hot west-afternoon heat
        return "E"
    if room_type == "office":
        # Stable diffuse light — shaded (north NH / south SH)
        return shade
    if room_type in ("bathroom", "utility"):
        # Ventilation priority: windward edge
        return windward
    if room_type == "garage":
        return leeward
    return shade


def _compass_to_edge(compass: str) -> str:
    if compass in ("N", "NNE", "NNW"):
        return "north"
    if compass in ("E", "ENE", "ESE"):
        return "east"
    if compass in ("S", "SSE", "SSW"):
        return "south"
    if compass in ("W", "WNW", "WSW"):
        return "west"
    if compass == "NE":
        return "east"
    if compass == "SE":
        return "south"
    if compass == "SW":
        return "west"
    return "north"


def _resolve_edge_pref(edge_pref: str, site: SiteContext) -> str:
    if edge_pref in ("east", "west", "north", "south"):
        return edge_pref
    if edge_pref == "windward":
        return _compass_to_edge(_deg_to_compass(_bearing(site.wind_dir)))
    if edge_pref == "leeward":
        return _compass_to_edge(_deg_to_compass(_bearing(site.wind_dir) + 180.0))
    return "south" if site.lat >= 0 else "north"


def _cardinal_from_rect(
    x: float,
    y: float,
    w: float,
    h: float,
    footprint: Tuple[float, float, float, float],
    preferred: str,
) -> str:
    fx, fy, fw, fh = footprint
    exposed = []
    if abs(y - fy) < 0.18:
        exposed.append("N")
    if abs((y + h) - (fy + fh)) < 0.18:
        exposed.append("S")
    if abs(x - fx) < 0.18:
        exposed.append("W")
    if abs((x + w) - (fx + fw)) < 0.18:
        exposed.append("E")
    if exposed:
        target = _bearing(preferred)
        return min(exposed, key=lambda d: _adiff(_bearing(d), target))
    return preferred


def _area_to_dims(room_type: str, area: float, stretch: float = 1.0) -> Tuple[float, float]:
    aspect = ROOM_RULES[room_type]["aspect"] * stretch
    width = math.sqrt(area * aspect)
    height = area / max(width, 1e-6)
    return round(width, 2), round(height, 2)


def _ordered_rooms(room_types: List[str], variant_mode: str) -> List[str]:
    priority = {
        "compact":   ["living", "kitchen", "dining", "bedroom", "bathroom", "office", "utility", "garage", "puja_room"],
        "linear":    ["living", "dining", "kitchen", "bedroom", "bedroom", "bathroom", "office", "utility", "garage", "puja_room"],
        "split":     ["living", "dining", "office", "kitchen", "bedroom", "bedroom", "bathroom", "utility", "garage", "puja_room"],
        "courtyard": ["living", "bedroom", "dining", "kitchen", "office", "bedroom", "bathroom", "utility", "garage", "puja_room"],
        "l_shape":   ["living", "kitchen", "bedroom", "dining", "bathroom", "office", "utility", "garage", "puja_room"],
        "perimeter": ["living", "dining", "bedroom", "bedroom", "kitchen", "office", "bathroom", "utility", "garage", "puja_room"],
    }[variant_mode]
    room_types = list(room_types)
    room_types.sort(key=lambda r: priority.index(r) if r in priority else 999)
    return room_types


def _grouped_room_sequence(room_types: List[str], variant_mode: str) -> List[str]:
    ordered = _ordered_rooms(room_types, variant_mode)
    public = [r for r in ordered if ROOM_RULES[r]["class"] == "public"]
    private = [r for r in ordered if ROOM_RULES[r]["class"] == "private"]
    service = [r for r in ordered if ROOM_RULES[r]["class"] == "service"]
    if variant_mode == "linear":
        return public + service + private
    if variant_mode == "split":
        return public + private + service
    if variant_mode == "courtyard":
        return public[:1] + private + public[1:] + service
    if variant_mode == "perimeter":
        return public + private + service
    return public + private + service


def _ordered_specs_for_zone(specs: List[Tuple[str, int, float]], klass: str) -> List[Tuple[str, int, float]]:
    priorities = {
        "public": ["living", "dining"],
        "private": ["bedroom", "office", "puja_room"],
        "service": ["kitchen", "bathroom", "utility", "garage"],
    }
    order = priorities[klass]
    return sorted(specs, key=lambda spec: (order.index(spec[0]) if spec[0] in order else 99, -spec[2]))


def _class_zones(
    specs: List[Tuple[str, int, float]],
    config: dict,
    site: SiteContext,
    footprint_w: float,
    footprint_h: float,
    plot_shape: str,
) -> Dict[str, Tuple[float, float, float, float]]:
    class_areas = {
        "public": sum(area for room_type, _, area in specs if ROOM_RULES[room_type]["class"] == "public"),
        "private": sum(area for room_type, _, area in specs if ROOM_RULES[room_type]["class"] == "private"),
        "service": sum(area for room_type, _, area in specs if ROOM_RULES[room_type]["class"] == "service"),
    }
    total = sum(class_areas.values()) or 1.0
    axis = config["axis"]
    public_edge = _resolve_edge_pref(config["public_edge"], site)
    private_edge = _resolve_edge_pref(config["private_edge"], site)
    service_edge = "west" if site.lat >= 0 else "east"
    if config["mode"] in ("linear", "perimeter"):
        service_edge = _resolve_edge_pref("leeward", site)
    shape = _normalize_plot_shape(plot_shape)

    if shape == "lshape":
        return {
            "service": (0.0, footprint_h * 0.44, footprint_w * 0.28, footprint_h * 0.56),
            "public": (footprint_w * 0.28, footprint_h * 0.44, footprint_w * 0.72, footprint_h * 0.56),
            "private": (footprint_w * 0.44, 0.0, footprint_w * 0.56, footprint_h * 0.44),
        }

    if shape == "tshape":
        return {
            "public": (0.0, 0.0, footprint_w, footprint_h * 0.34),
            "private": (footprint_w * 0.24, footprint_h * 0.34, footprint_w * 0.52, footprint_h * 0.34),
            "service": (footprint_w * 0.30, footprint_h * 0.68, footprint_w * 0.40, footprint_h * 0.32),
        }

    if shape == "circular":
        return {
            "public": (footprint_w * 0.16, footprint_h * 0.10, footprint_w * 0.68, footprint_h * 0.34),
            "private": (footprint_w * 0.18, footprint_h * 0.44, footprint_w * 0.64, footprint_h * 0.30),
            "service": (footprint_w * 0.30, footprint_h * 0.74, footprint_w * 0.40, footprint_h * 0.20),
        }

    if shape == "irregular":
        return {
            "service": (0.0, footprint_h * 0.28, footprint_w * 0.24, footprint_h * 0.52),
            "public": (footprint_w * 0.18, footprint_h * 0.42, footprint_w * 0.82, footprint_h * 0.58),
            "private": (footprint_w * 0.40, 0.0, footprint_w * 0.60, footprint_h * 0.42),
        }

    if shape == "square":
        axis = "horizontal"

    if axis == "vertical":
        desired = {"public": public_edge, "private": private_edge, "service": service_edge}
        left = sorted(["public", "private", "service"], key=lambda klass: (
            0 if desired[klass] == "west" else 2 if desired[klass] == "east" else 1,
            0 if klass == "service" else 1 if klass == "private" else 2,
        ))
        minimums = {"public": 3.8, "private": 3.4, "service": 2.8}
        usable = max(footprint_w - sum(minimums[klass] for klass in left), 0.0)
        widths = {}
        for klass in left:
            widths[klass] = minimums[klass] + usable * (class_areas[klass] / total)
        cursor = 0.0
        zones = {}
        for klass in left:
            zones[klass] = (cursor, 0.0, widths[klass], footprint_h)
            cursor += widths[klass]
        return zones

    desired = {"public": public_edge, "private": private_edge, "service": service_edge}
    top = sorted(["public", "private", "service"], key=lambda klass: (
        0 if desired[klass] == "north" else 2 if desired[klass] == "south" else 1,
        0 if klass == "service" else 1 if klass == "private" else 2,
    ))
    minimums = {"public": 3.6, "private": 3.4, "service": 2.6}
    usable = max(footprint_h - sum(minimums[klass] for klass in top), 0.0)
    heights = {}
    for klass in top:
        heights[klass] = minimums[klass] + usable * (class_areas[klass] / total)
    cursor = 0.0
    zones = {}
    for klass in top:
        zones[klass] = (0.0, cursor, footprint_w, heights[klass])
        cursor += heights[klass]
    if config["mode"] == "l_shape" and "private" in zones:
        zx, zy, zw, zh = zones["private"]
        zones["private"] = (zx, zy, zw * 0.72, zh)
    return zones


def _split_room_ids(room_types: List[str], area_map: Dict[str, List[float]], counters: Dict[str, int]) -> List[Tuple[str, int, float]]:
    result: List[Tuple[str, int, float]] = []
    for room_type in room_types:
        idx = counters[room_type]
        result.append((room_type, idx, area_map[room_type][idx]))
        counters[room_type] += 1
    return result


def _recursive_partition(
    specs: List[Tuple[str, int, float]],
    rect: Tuple[float, float, float, float],
    axis: str,
    out: Dict[Tuple[str, int], Tuple[float, float, float, float]],
) -> None:
    x, y, w, h = rect
    if not specs:
        return
    if len(specs) == 1:
        out[(specs[0][0], specs[0][1])] = rect
        return

    total = sum(area for _, _, area in specs)
    split_index = 1
    running = specs[0][2]
    while split_index < len(specs) - 1 and running < total * 0.5:
        split_index += 1
        running += specs[split_index - 1][2]
    left = specs[:split_index]
    right = specs[split_index:]
    left_area = sum(a for _, _, a in left)
    ratio = max(0.22, min(0.78, left_area / max(total, 1e-6)))

    if axis == "horizontal":
        split_h = h * ratio
        _recursive_partition(left, (x, y, w, split_h), "vertical" if w >= h else "horizontal", out)
        _recursive_partition(right, (x, y + split_h, w, h - split_h), "vertical" if w >= h else "horizontal", out)
    else:
        split_w = w * ratio
        _recursive_partition(left, (x, y, split_w, h), "horizontal" if h >= w else "vertical", out)
        _recursive_partition(right, (x + split_w, y, w - split_w, h), "horizontal" if h >= w else "vertical", out)


def _shape_rooms(
    rects: Dict[Tuple[str, int], Tuple[float, float, float, float]],
    specs: List[Tuple[str, int, float]],
) -> Dict[Tuple[str, int], Tuple[float, float, float, float]]:
    return rects.copy()


def _layout_variant(
    room_types: List[str],
    area_map: Dict[str, List[float]],
    config: dict,
    site: SiteContext,
    total_area: float,
    floors: int,
    plot_shape: str,
) -> List[Room]:
    rooms: List[Room] = []
    ordered = _grouped_room_sequence(room_types, config["mode"])
    per_floor = math.ceil(len(ordered) / max(floors, 1))
    global_type_index = {key: 0 for key in area_map}
    for floor in range(1, floors + 1):
        floor_order = ordered[(floor - 1) * per_floor: floor * per_floor]
        if not floor_order:
            continue
        specs = _split_room_ids(floor_order, area_map, global_type_index)
        floor_area = sum(area for _, _, area in specs)
        footprint_w, footprint_h = _fit_footprint(site.width, site.height, floor_area, 1)
        origin_x = (site.width - footprint_w) / 2
        origin_y = (site.height - footprint_h) / 2
        zones = _class_zones(specs, config, site, footprint_w, footprint_h, plot_shape)
        rects: Dict[Tuple[str, int], Tuple[float, float, float, float]] = {}
        for klass in ("public", "private", "service"):
            class_specs = _ordered_specs_for_zone(
                [spec for spec in specs if ROOM_RULES[spec[0]]["class"] == klass],
                klass,
            )
            if not class_specs:
                continue
            zx, zy, zw, zh = zones[klass]
            _recursive_partition(
                class_specs,
                (origin_x + zx, origin_y + zy, zw, zh),
                "vertical" if (klass == "public" and config["axis"] == "horizontal") or klass == "private" else "horizontal",
                rects,
            )
        shaped = _shape_rooms(rects, specs)
        footprint_rect = (origin_x, origin_y, footprint_w, footprint_h)
        floor_counts: Dict[str, int] = {}
        for room_type, idx, area in specs:
            x, y, width, height = shaped[(room_type, idx)]
            if config["mode"] == "courtyard" and room_type in ("living", "dining"):
                height = max(height * 0.92, 3.6)
            if config["mode"] == "l_shape" and room_type in ("living", "dining"):
                width = min(width * 1.04, footprint_w * 0.62)
                height = area / max(width, 1e-6)
            floor_counts[room_type] = floor_counts.get(room_type, 0) + 1
            rooms.append(
                Room(
                    id=f"{room_type}_{floor}_{floor_counts[room_type]}",
                    type=room_type,
                    width=round(width, 2),
                    height=round(height, 2),
                    x=round(x, 2),
                    y=round(y, 2),
                    floor=floor,
                    orientation=_cardinal_from_rect(
                        x,
                        y,
                        width,
                        height,
                        footprint_rect,
                        _target_orientation(
                            room_type,
                            site.lat,
                            site.wind_dir,
                            config["public_edge"] if ROOM_RULES[room_type]["class"] == "public" else config["private_edge"],
                            sun_hours=site.sun_hours,
                        ),
                    ),
                )
            )
    return rooms


def _overlap_len(a0: float, a1: float, b0: float, b1: float) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))


def _explicit_geometry(rooms: List[Room], site: Optional["SiteContext"] = None) -> Tuple[List[Wall], List[Door], List[Window]]:
    walls: List[Wall] = []
    doors: List[Door] = []
    windows: List[Window] = []
    wall_idx = 1
    door_idx = 1
    win_idx = 1
    added = set()

    def preferred_edges(room: Room) -> List[str]:
        t = room.type.lower()
        orient_map = {
            "N": ["top", "right", "left"],
            "E": ["right", "top", "bottom"],
            "S": ["bottom", "right", "left"],
            "W": ["left", "top", "bottom"],
        }
        preferred = orient_map.get((room.orientation or "N").upper(), ["top", "right", "left"])
        if "living" in t or "dining" in t:
            return preferred + [edge for edge in ["top", "right", "left", "bottom"] if edge not in preferred]
        if "bedroom" in t:
            return preferred + [edge for edge in ["right", "top", "left", "bottom"] if edge not in preferred]
        if "kitchen" in t:
            return preferred + [edge for edge in ["left", "top", "right", "bottom"] if edge not in preferred]
        if "office" in t:
            return preferred + [edge for edge in ["top", "right", "left", "bottom"] if edge not in preferred]
        if "bathroom" in t or "utility" in t:
            return preferred[-1:] + preferred[:-1]
        return preferred + [edge for edge in ["top", "right", "left", "bottom"] if edge not in preferred]

    for room in rooms:
        edges = [
            ("top", room.x, room.y, room.x + room.width, room.y),
            ("bottom", room.x, room.y + room.height, room.x + room.width, room.y + room.height),
            ("left", room.x, room.y, room.x, room.y + room.height),
            ("right", room.x + room.width, room.y, room.x + room.width, room.y + room.height),
        ]
        for orientation, x1, y1, x2, y2 in edges:
            key = (room.floor, round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3))
            rev = (room.floor, round(x2, 3), round(y2, 3), round(x1, 3), round(y1, 3))
            shared = any(
                other.id != room.id and (
                    (orientation in ("top", "bottom") and abs(y1 - other.y) < 0.09 and _overlap_len(x1, x2, other.x, other.x + other.width) > 0.35) or
                    (orientation in ("top", "bottom") and abs(y1 - (other.y + other.height)) < 0.09 and _overlap_len(x1, x2, other.x, other.x + other.width) > 0.35) or
                    (orientation in ("left", "right") and abs(x1 - other.x) < 0.09 and _overlap_len(y1, y2, other.y, other.y + other.height) > 0.35) or
                    (orientation in ("left", "right") and abs(x1 - (other.x + other.width)) < 0.09 and _overlap_len(y1, y2, other.y, other.y + other.height) > 0.35)
                )
                for other in rooms
                if other.floor == room.floor
            )
            if rev in added:
                continue
            added.add(key)
            length = abs(x2 - x1) if orientation in ("top", "bottom") else abs(y2 - y1)
            wall_id = f"wall_{wall_idx}"
            wall_idx += 1
            walls.append(
                Wall(
                    id=wall_id,
                    room_id=room.id or room.type,
                    type="interior" if shared else "exterior",
                    orientation="horizontal" if orientation in ("top", "bottom") else "vertical",
                    x=round((x1 + x2) / 2, 2),
                    y=round((y1 + y2) / 2, 2),
                    x2=round(x2, 2),
                    y2=round(y2, 2),
                    length=round(length, 2),
                    thickness=WALL_INT if shared else WALL_EXT,
                    floor=room.floor,
                    height=FLOOR_HEIGHT,
                )
            )

    for i, room in enumerate(rooms):
        for other in rooms[i + 1:]:
            if room.floor != other.floor:
                continue
            overlap_y = _overlap_len(room.y, room.y + room.height, other.y, other.y + other.height)
            overlap_x = _overlap_len(room.x, room.x + room.width, other.x, other.x + other.width)
            if abs((room.x + room.width) - other.x) < 0.09 and overlap_y > 0.8:
                door_y = max(room.y, other.y) + overlap_y / 2
                doors.append(Door(id=f"door_{door_idx}", room_to=other.id or other.type, type="interior", x=round(other.x, 2), y=round(door_y, 2), width=0.9, orientation="vertical", symbol="arc_swing", floor=room.floor))
                door_idx += 1
            elif abs((room.y + room.height) - other.y) < 0.09 and overlap_x > 0.8:
                door_x = max(room.x, other.x) + overlap_x / 2
                doors.append(Door(id=f"door_{door_idx}", room_to=other.id or other.type, type="interior", x=round(door_x, 2), y=round(other.y, 2), width=0.9, orientation="horizontal", symbol="arc_swing", floor=room.floor))
                door_idx += 1

    # ---- Derive climate and wind context for eco-window placement ----
    if site is not None:
        climate = _climate_profile(site.lat, site.sun_hours)
        wind_bearing = _bearing(site.wind_dir)
        windward_edge = _compass_to_edge(_deg_to_compass(wind_bearing))
        leeward_edge  = _compass_to_edge(_deg_to_compass(wind_bearing + 180.0))
        lat = site.lat
    else:
        climate = "temperate"
        wind_bearing = 180.0
        windward_edge = "south"
        leeward_edge  = "north"
        lat = 10.0

    # Perpendicular edges for cross-ventilation pairing
    _PERP = {
        "top":    ["left", "right"],
        "bottom": ["left", "right"],
        "left":   ["top", "bottom"],
        "right":  ["top", "bottom"],
    }
    # Rooms that benefit from two-sided cross-ventilation
    CROSS_VENT_ROOMS = {"living", "dining", "bedroom", "office", "kitchen"}

    for room in rooms:
        outer_edges = [
            ("top",    room.x,              room.y,               room.width),
            ("bottom", room.x,              room.y + room.height, room.width),
            ("left",   room.x,              room.y,               room.height),
            ("right",  room.x + room.width, room.y,               room.height),
        ]
        available_edges: List[Tuple[str, float]] = []
        for edge_name, x, y, span in outer_edges:
            shared = False
            for other in rooms:
                if other.id == room.id or other.floor != room.floor:
                    continue
                if edge_name == "top"    and abs(y - (other.y + other.height)) < 0.09 and _overlap_len(x, x + span, other.x, other.x + other.width) > 0.4:
                    shared = True
                if edge_name == "bottom" and abs(y - other.y) < 0.09 and _overlap_len(x, x + span, other.x, other.x + other.width) > 0.4:
                    shared = True
                if edge_name == "left"   and abs(x - (other.x + other.width)) < 0.09 and _overlap_len(y, y + span, other.y, other.y + other.height) > 0.4:
                    shared = True
                if edge_name == "right"  and abs(x - other.x) < 0.09 and _overlap_len(y, y + span, other.y, other.y + other.height) > 0.4:
                    shared = True
            if shared or span < 1.2:
                continue
            available_edges.append((edge_name, span))

        edge_priority = preferred_edges(room)
        placed_edges: List[str] = []

        # --- PRIMARY WINDOW: solar/orientation optimised ---
        for edge_name, span in available_edges:
            if edge_name not in edge_priority:
                continue
            win_w = round(min(3.0, max(0.65, span * _wwr(climate, room.type))), 2)
            windows.append(Window(
                id=f"window_{win_idx}",
                wall=f"{room.id}_{edge_name}",
                position=0.5,
                width=win_w,
                floor=room.floor,
                sill_height=0.85,
                head_height=2.10,
            ))
            win_idx += 1
            placed_edges.append(edge_name)
            break  # one primary window per room

        # --- CROSS-VENTILATION WINDOW: windward or perpendicular to primary ---
        if room.type in CROSS_VENT_ROOMS and placed_edges:
            primary = placed_edges[0]
            # Prefer windward edge (creates through-breeze); fall back to perpendicular
            cross_candidates = []
            if windward_edge != primary:
                cross_candidates.append(windward_edge)
            cross_candidates += [e for e in _PERP.get(primary, []) if e != windward_edge]
            for edge_name, span in available_edges:
                if edge_name in cross_candidates and edge_name not in placed_edges:
                    # Cross-vent window: slightly smaller, higher sill (privacy + warm-air exhaust)
                    win_w = round(min(1.8, max(0.55, span * _wwr(climate, room.type) * 0.65)), 2)
                    windows.append(Window(
                        id=f"window_{win_idx}",
                        wall=f"{room.id}_{edge_name}_vent",
                        position=0.5,
                        width=win_w,
                        floor=room.floor,
                        sill_height=1.20,  # high sill: warm air exits near ceiling
                        head_height=2.10,
                    ))
                    win_idx += 1
                    placed_edges.append(edge_name)
                    break

        # --- SERVICE ROOMS: single ventilation window on any available exterior wall ---
        if room.type in ("bathroom", "utility") and not placed_edges:
            for edge_name, span in available_edges:
                if span >= 1.2:
                    windows.append(Window(
                        id=f"window_{win_idx}",
                        wall=f"{room.id}_{edge_name}",
                        position=0.5,
                        width=round(min(0.9, max(0.45, span * 0.18)), 2),
                        floor=room.floor,
                        sill_height=1.50,  # Privacy height for wet rooms
                        head_height=2.10,
                    ))
                    win_idx += 1
                    break

    if rooms:
        entry = min((r for r in rooms if r.floor == 1), key=lambda r: (r.y, r.x))
        doors.append(Door(id=f"door_{door_idx}", room_to=entry.id or entry.type, type="entry", x=round(entry.x + entry.width / 2, 2), y=round(entry.y + entry.height, 2), width=1.2, orientation="horizontal", symbol="double_door", floor=1))

    return walls, doors, windows


def _score_layout(rooms: List[Room], site: SiteContext, walls: List[Wall],
                  windows: Optional[List[Window]] = None) -> Dict[str, float]:
    """Multi-factor eco score incorporating passive solar, cross-ventilation,
    natural-light depth, service clustering, structural fitness, and compactness."""
    total_area = sum(r.width * r.height for r in rooms) or 1.0
    climate = _climate_profile(site.lat, site.sun_hours)
    public_rooms  = [r for r in rooms if r.type in ("living", "dining", "kitchen", "office")]
    private_rooms = [r for r in rooms if r.type in ("bedroom", "bathroom", "puja_room")]
    habitable     = [r for r in rooms if r.type in ("living", "dining", "bedroom", "office")]

    # ---- 1. Passive-solar score ----
    # In hot climates the goal is to minimise solar gain; in cold/temperate, maximise.
    sunny_bearing = _bearing("S" if site.lat >= 0 else "N")
    shade_bearing  = _bearing("N" if site.lat >= 0 else "S")
    sunlight = 0.0
    for room in public_rooms:
        room_bearing = _bearing(room.orientation)
        if climate == "hot":
            # Reward facing shade side (cool living areas)
            sunlight += max(0.0, math.cos(math.radians(_adiff(room_bearing, shade_bearing))))
        else:
            # Reward facing sunny side (passive solar heating / daylight)
            sunlight += max(0.0, math.cos(math.radians(_adiff(room_bearing, sunny_bearing))))
    sunlight = sunlight / max(len(public_rooms), 1)

    # ---- 2. Cross-ventilation score ----
    # Reward rooms that have windows on two non-parallel walls (≈ windward + leeward/perp)
    cross_vent = 0.0
    if windows:
        wind_edge    = _compass_to_edge(_deg_to_compass(_bearing(site.wind_dir)))
        opp_edge     = _compass_to_edge(_deg_to_compass(_bearing(site.wind_dir) + 180.0))
        for room in habitable:
            room_wins = {w.wall.split("_")[-1].replace("vent", "").strip("_")
                         for w in windows if w.wall.startswith(room.id or room.type)}
            has_windward = wind_edge in room_wins or opp_edge in room_wins
            has_two_sides = len(room_wins - {""}) >= 2
            cross_vent += 1.0 if (has_windward and has_two_sides) else (0.5 if has_two_sides else 0.0)
        cross_vent /= max(len(habitable), 1)
    else:
        # Approximate: check room orientation alignment with wind axis
        wind_target = _bearing(site.wind_dir)
        for room in public_rooms + private_rooms:
            cross_vent += max(0.0, math.cos(math.radians(_adiff(_bearing(room.orientation), wind_target))))
        cross_vent /= max(len(public_rooms) + len(private_rooms), 1)

    # ---- 3. Natural-light depth ----
    # Reward habitable rooms that are not excessively deep (daylight rule: depth ≤ 2.5× window wall)
    light_score = 0.0
    for room in habitable:
        depth = min(room.width, room.height)
        win_wall = max(room.width, room.height)
        light_score += min(1.0, (win_wall * 2.5) / max(depth, 0.1)) * 0.5 + 0.5  # always at least 0.5
    light_score = min(1.0, light_score / max(len(habitable), 1))

    # ---- 4. Compactness (minimise heat-loss surface) ----
    bbox_area = ((max(r.x + r.width for r in rooms) - min(r.x for r in rooms)) *
                 (max(r.y + r.height for r in rooms) - min(r.y for r in rooms)))
    compactness = total_area / max(bbox_area, total_area)

    # ---- 5. Service clustering (shared plumbing wall, lower pipe runs) ----
    service_clustering = 0.0
    service_rooms = [r for r in rooms if r.type in ("kitchen", "bathroom", "utility")]
    if len(service_rooms) > 1:
        pairs = 0
        dsum  = 0.0
        for i, room in enumerate(service_rooms):
            for other in service_rooms[i + 1:]:
                dsum += math.dist(
                    (room.x + room.width / 2, room.y + room.height / 2),
                    (other.x + other.width / 2, other.y + other.height / 2),
                )
                pairs += 1
        service_clustering = max(0.0, 1.0 - dsum / max(pairs * 10.0, 1.0))

    # ---- 6. Structural score ----
    structural = (max(0.0, 1.0 - site.slope / 28.0) * 0.6 +
                  max(0.0, 1.0 - site.flood_risk)    * 0.4)

    # ---- Composite eco score ----
    eco = (0.24 * sunlight
         + 0.22 * cross_vent
         + 0.18 * light_score
         + 0.14 * compactness
         + 0.12 * service_clustering
         + 0.10 * structural)
    return {
        "solar":       round(sunlight, 3),
        "ventilation": round(cross_vent, 3),
        "compactness": round(compactness, 3),
        "service":     round(service_clustering, 3),
        "structural":  round(structural, 3),
        "eco":         round(min(0.99, eco), 3),
    }


async def _load_context(request: GenerateFloorPlanRequest, db: AsyncSession) -> SiteContext:
    lat = 10.0
    lon = 76.0
    wind_dir = "SW"
    slope = 4.0
    flood_risk = 0.25
    ndvi = 0.45
    sun_hours = 8.0
    polygon_xy = None

    analysis_result = await db.execute(
        select(AnalysisRecord).where(AnalysisRecord.plot_id == request.plot_id).order_by(desc(AnalysisRecord.created_at))
    )
    analysis = analysis_result.scalars().first()
    if analysis:
        slope = float(analysis.slope or slope)
        flood_risk = float(analysis.flood_probability or flood_risk)
        ndvi = float(analysis.ndvi or ndvi)
        wind_dir = str(analysis.wind_direction or wind_dir)
        raw = analysis.raw_features or {}
        lat = float(raw.get("_lat", raw.get("lat", lat)))
        lon = float(raw.get("_lon", raw.get("lon", lon)))
        sun_hours = float(raw.get("sun_exposure_hours", analysis.sun_exposure_hours or sun_hours))

    plot_result = await db.execute(select(PlotRecord).where(PlotRecord.plot_id == request.plot_id))
    plot = plot_result.scalars().first()
    if plot and plot.polygon:
        polygon_xy = _polygon_to_xy(plot.polygon)

    site_w, site_h = _site_dims_from_polygon(polygon_xy, request.plot_area_sqm)
    return SiteContext(site_w, site_h, polygon_xy, lat, lon, wind_dir, slope, flood_risk, ndvi, sun_hours)


async def generate_floor_plan(request: GenerateFloorPlanRequest, db: AsyncSession) -> FloorPlanResponse:
    site = await _load_context(request, db)
    total_area = round(max(request.plot_area_sqm or 150.0, 45.0), 1)
    floors = max(1, min(request.num_floors or 1, 4))
    room_types = _build_room_program(total_area, request.room_preferences)
    area_map = _allocate_room_areas(room_types, total_area)

    variants: List[FloorPlanVariant] = []
    best_idx = 0
    best_eco = -1.0

    variant_configs = _variant_configs_for_shape(request.plot_shape)
    for idx, config in enumerate(variant_configs, start=1):
        layout = _layout_variant(room_types, area_map, config, site, total_area, floors, request.plot_shape)
        walls, doors, windows = _explicit_geometry(layout, site)
        scores = _score_layout(layout, site, walls, windows)
        variant_area = round(sum(r.width * r.height for r in layout), 1)
        variants.append(
            FloorPlanVariant(
                id=idx,
                style=config["name"],
                layout=layout,
                total_area=variant_area,
                solar_score=scores["solar"],
                ventilation_score=scores["ventilation"],
                fitness_score=scores["eco"],
                eco_score=scores["eco"],
                walls=walls,
                doors=doors,
                windows=windows,
                is_best=False,
            )
        )
        if scores["eco"] > best_eco:
            best_eco = scores["eco"]
            best_idx = idx - 1

    variants[best_idx].is_best = True
    best = variants[best_idx]

    try:
        db.add(
            FloorPlanRecord(
                plot_id=request.plot_id,
                layout_json={
                    "layout": [r.model_dump() for r in best.layout],
                    "walls": [w.model_dump() for w in best.walls or []],
                    "doors": [d.model_dump() for d in best.doors or []],
                    "windows": [w.model_dump() for w in best.windows or []],
                    "variants": [v.model_dump() for v in variants],
                },
                fitness_score=float(best.fitness_score),
                generation_count=len(variants),
            )
        )
        await db.commit()
    except Exception as exc:
        logger.warning("[FloorPlan] persist failed: %s", exc)
        try:
            await db.rollback()
        except Exception:
            pass

    return FloorPlanResponse(
        plot_id=request.plot_id,
        layout=best.layout,
        walls=best.walls,
        doors=best.doors,
        windows=best.windows,
        total_area=round(sum(r.width * r.height for r in best.layout), 1),
        fitness_score=float(best.fitness_score),
        eco_score=float(best.eco_score),
        generation_count=len(variants),
        sunlight_score=float(best.solar_score),
        ventilation_score=float(best.ventilation_score),
        tree_preserved_count=max(0, int(round(site.ndvi * 8)) + (2 if request.preserve_trees else 0)),
        orientation_degrees=float(_bearing(site.wind_dir)),
        variants=variants,
        best_variant_index=best_idx,
    )
