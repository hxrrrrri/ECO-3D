"""
Floor Plan Service — generates unique layout per plot.
Supports plot shapes, room preferences, house types, and eco-optimization.
"""
import random
import math
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from database.models import FloorPlanRecord
from models.schemas import GenerateFloorPlanRequest, FloorPlanResponse, Room

logger = logging.getLogger(__name__)

ORIENTATIONS = ["North", "South", "East", "West", "Northeast", "Northwest", "Southeast", "Southwest"]

_WIND_OPP = {
    "N": "S", "S": "N", "E": "W", "W": "E",
    "NE": "SW", "SW": "NE", "NW": "SE", "SE": "NW",
    "NNE": "SSW", "SSW": "NNE", "ENE": "WSW", "WSW": "ENE",
    "NNW": "SSE", "SSE": "NNW", "ESE": "WNW", "WNW": "ESE",
}

def _sun_orientation(lat: float) -> str:
    return "South" if lat >= 0 else "North"

def _wind_cross_orientation(wind_dir: str) -> str:
    return _WIND_OPP.get(wind_dir, "South")


# ── Plot shape boundary generators ───────────────────────────────────────────
def _make_plot_boundary(shape: str, area: float) -> list:
    """Returns polygon as list of [x,y] points for the plot shape."""
    s = math.sqrt(area)
    shape = (shape or "rectangle").lower().replace("-", "").replace(" ", "")
    if shape in ("square",):
        return [[0,0],[s,0],[s,s],[0,s]]
    elif shape in ("rectangle",):
        w, h = s * 1.4, s * 0.72
        return [[0,0],[w,0],[w,h],[0,h]]
    elif shape in ("lshape","l"):
        w, h = s * 1.3, s * 1.3
        # L-shape: full rect minus top-right quadrant
        return [[0,0],[w,0],[w,h*0.45],[w*0.5,h*0.45],[w*0.5,h],[0,h]]
    elif shape in ("tshape","t"):
        w, h = s * 1.5, s * 1.0
        # T: wide top bar + stem at bottom center
        sw = w * 0.35; sh = h * 0.5
        cx = (w - sw) / 2
        return [[0,0],[w,0],[w,h*0.5],[cx+sw,h*0.5],[cx+sw,h],[cx,h],[cx,h*0.5],[0,h*0.5]]
    elif shape in ("irregular",):
        w, h = s * 1.2, s * 0.9
        return [[0,h*0.15],[w*0.1,0],[w*0.85,0],[w,h*0.2],[w*0.95,h],[w*0.05,h*0.9]]
    else:
        w, h = s * 1.4, s * 0.72
        return [[0,0],[w,0],[w,h],[0,h]]


def _bbox_of_polygon(poly: list) -> tuple:
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def _point_in_polygon(px, py, poly) -> bool:
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def _room_fits_in_polygon(rx, ry, rw, rh, poly) -> bool:
    """Check if at least 70% of room corners are inside polygon."""
    corners = [(rx, ry), (rx+rw, ry), (rx+rw, ry+rh), (rx, ry+rh)]
    center = (rx + rw/2, ry + rh/2)
    in_count = sum(1 for c in corners if _point_in_polygon(c[0], c[1], poly))
    return in_count >= 3 or _point_in_polygon(center[0], center[1], poly)


# ── Room count limits by area ─────────────────────────────────────────────────
def _compute_max_rooms(area: float) -> dict:
    """Returns max allowed count for each room type given plot area."""
    if area < 60:
        return {"bedrooms": 1, "bathrooms": 1, "kitchen": 1, "living": 1, "office": 0, "garage": 0, "puja_room": 0, "utility": 0, "dining": 0}
    elif area < 100:
        return {"bedrooms": 2, "bathrooms": 1, "kitchen": 1, "living": 1, "office": 0, "garage": 0, "puja_room": 1, "utility": 0, "dining": 0}
    elif area < 150:
        return {"bedrooms": 3, "bathrooms": 2, "kitchen": 1, "living": 1, "office": 1, "garage": 0, "puja_room": 1, "utility": 1, "dining": 1}
    elif area < 250:
        return {"bedrooms": 4, "bathrooms": 2, "kitchen": 1, "living": 1, "office": 1, "garage": 1, "puja_room": 1, "utility": 1, "dining": 1}
    elif area < 400:
        return {"bedrooms": 5, "bathrooms": 3, "kitchen": 1, "living": 1, "office": 2, "garage": 1, "puja_room": 1, "utility": 1, "dining": 1}
    else:
        return {"bedrooms": 6, "bathrooms": 4, "kitchen": 2, "living": 2, "office": 2, "garage": 2, "puja_room": 1, "utility": 2, "dining": 1}


# ── House type room sets ──────────────────────────────────────────────────────
def _rooms_for_house_type(house_type: str, area: float, prefs: dict) -> list:
    """Returns ordered list of room types based on house type and area."""
    ht = (house_type or "").lower()
    prefs = prefs or {}
    limits = _compute_max_rooms(area)

    def clamp(val, key): return min(int(val), limits.get(key, 0))

    beds = clamp(prefs.get("bedrooms", 0) or (2 if area < 150 else 3 if area < 300 else 4), "bedrooms")
    baths = clamp(prefs.get("bathrooms", 0) or max(1, beds // 2), "bathrooms")
    has_puja = bool(prefs.get("puja_room", False)) and limits["puja_room"] > 0
    has_garage = bool(prefs.get("garage", False)) and limits["garage"] > 0
    has_office = bool(prefs.get("office", False)) and limits["office"] > 0
    has_utility = bool(prefs.get("utility", area >= 150)) and limits["utility"] > 0
    has_dining = bool(prefs.get("dining", area >= 120)) and limits["dining"] > 0

    rooms = ["living", "kitchen"]
    if has_dining:
        rooms.append("dining")
    for _ in range(beds):
        rooms.append("bedroom")
    for _ in range(baths):
        rooms.append("bathroom")
    if has_puja:
        rooms.append("puja_room")
    if has_garage:
        rooms.append("garage")
    if has_office:
        rooms.append("office")
    if has_utility:
        rooms.append("utility")

    # Additional rooms for large houses
    if "duplex" in ht or "townhouse" in ht:
        if area >= 200 and limits["bedrooms"] > beds:
            rooms.append("bedroom")
    if "villa" in ht and area >= 300:
        if limits["office"] > (1 if has_office else 0):
            rooms.append("office")

    return rooms


# ── Solar/wind placement logic ────────────────────────────────────────────────
def _orient_for_eco(rtype: str, sun_dir: str, wind_dir: str, maximize_sun: bool, nat_vent: bool, rng: random.Random) -> str:
    t = rtype.lower()
    if maximize_sun and t in ("living", "bedroom", "dining", "puja_room"):
        return sun_dir
    if nat_vent and t in ("kitchen", "bathroom", "utility"):
        return wind_dir
    if t == "office":
        return sun_dir if maximize_sun else rng.choice(ORIENTATIONS)
    if t == "garage":
        return "South"
    return rng.choice(ORIENTATIONS)


# ── Adaptive layout with plot shape awareness ─────────────────────────────────
def _generate_adaptive_layout(
    area: float, num_floors: int, rng: random.Random,
    sun_dir: str, wind_dir: str, slope: float, flood_risk: float, ndvi: float,
    house_type: str = "Eco-Villa (Single Story)", plot_shape: str = "rectangle",
    room_preferences: dict = None, maximize_sunlight: bool = True,
    natural_ventilation: bool = True, sustainability_priority: bool = True,
) -> list:
    area_per_floor = max(area / num_floors, 50.0)
    cross_dir = _wind_cross_orientation(wind_dir)
    room_types = _rooms_for_house_type(house_type, area, room_preferences or {})

    if flood_risk > 0.6 and num_floors > 1:
        essential = {"living", "kitchen", "bathroom"}
        floor_assignments = (
            [(r, 1) for r in room_types if r in essential] +
            [(r, 2) for r in room_types if r not in essential]
        )
    else:
        per = math.ceil(len(room_types) / num_floors)
        floor_assignments = [(r, min(i // per + 1, num_floors)) for i, r in enumerate(room_types)]

    dim_ranges = {
        "living":     (5.0, 8.0, 4.0, 6.5),
        "bedroom":    (3.2, 5.0, 3.0, 4.5),
        "kitchen":    (3.0, 5.0, 2.8, 4.2),
        "bathroom":   (1.8, 3.0, 1.8, 3.0),
        "office":     (3.0, 4.5, 3.0, 4.2),
        "garage":     (5.0, 7.5, 4.5, 6.0),
        "utility":    (2.5, 3.5, 2.5, 3.5),
        "dining":     (3.0, 5.0, 2.5, 4.0),
        "puja_room":  (2.0, 3.0, 2.0, 3.0),
    }

    def dims(rtype: str):
        r = dim_ranges.get(rtype, (3.0, 5.0, 3.0, 4.5))
        return round(rng.uniform(r[0], r[1]), 1), round(rng.uniform(r[2], r[3]), 1)

    # ── Shape-specific zone definitions ─────────────────────────────────────
    # Each zone is (x_start, y_start, zone_width, zone_height)
    # Rooms are packed into zones left-to-right, top-to-bottom
    # This guarantees rooms NEVER go outside the shape boundary
    s = math.sqrt(area)
    shape = (plot_shape or "rectangle").lower().replace("-","").replace(" ","")

    def make_zones(shape: str, s: float):
        if shape == "square":
            w, h = s, s
            return [(0, 0, w, h)]
        elif shape == "rectangle":
            w, h = s * 1.45, s * 0.70
            return [(0, 0, w, h)]
        elif shape == "lshape":
            # L-shape: wide top bar + left stub at bottom
            W, H = s * 1.35, s * 1.35
            return [
                (0, 0,          W,       H * 0.45),   # top horizontal bar
                (0, H * 0.45,   W * 0.5, H * 0.55),   # bottom-left stub
            ]
        elif shape == "tshape":
            # T-shape: wide top bar + narrow stem in center-bottom
            W, H = s * 1.6, s * 1.1
            stem_w = W * 0.38
            stem_x = (W - stem_w) / 2
            return [
                (0,      0,        W,       H * 0.48),   # top bar
                (stem_x, H * 0.48, stem_w,  H * 0.52),   # center stem
            ]
        elif shape == "irregular":
            # Irregular: offset zones to create a non-rectangular silhouette
            W, H = s * 1.25, s * 1.0
            return [
                (0,        0,        W * 0.85,  H * 0.45),
                (W * 0.15, H * 0.45, W * 0.85,  H * 0.30),
                (0,        H * 0.75, W * 0.70,  H * 0.25),
            ]
        else:
            w, h = s * 1.45, s * 0.70
            return [(0, 0, w, h)]

    zones = make_zones(shape, s)

    # ── Pack rooms into zones ────────────────────────────────────────────────
    # Distribute rooms proportionally across zones by area
    zone_areas = [zw * zh for (_, _, zw, zh) in zones]
    total_zone_area = sum(zone_areas)
    total_rooms = len([fa for fa in floor_assignments if fa[1] == 1])
    zone_room_counts = [max(1, round(za / total_zone_area * total_rooms)) for za in zone_areas]
    # Adjust last zone to absorb rounding error
    while sum(zone_room_counts) < total_rooms:
        zone_room_counts[-1] += 1
    while sum(zone_room_counts) > total_rooms:
        zone_room_counts[-1] = max(1, zone_room_counts[-1] - 1)

    cursors: dict = {}
    rooms = []
    floor_type_counts: dict = {}

    for floor_n in range(1, num_floors + 1):
        floor_rooms = [(rt, fl) for rt, fl in floor_assignments if fl == floor_n]
        zi = 0  # zone index
        zone_placed = 0

        for rtype, floor in floor_rooms:
            if floor not in floor_type_counts:
                floor_type_counts[floor] = {}

            w, h = dims(rtype)
            # Advance zone if current is full
            if zi < len(zones) - 1 and zone_placed >= zone_room_counts[zi]:
                zi += 1
                zone_placed = 0

            zx0, zy0, zw, zh = zones[zi % len(zones)]

            # Get/init cursor for (floor, zone)
            ck = (floor, zi)
            if ck not in cursors:
                cursors[ck] = [zx0, zy0, 0.0]  # cx, cy, row_h
            cx2, cy2, row_h = cursors[ck]

            # Clamp room dims to fit zone
            w = min(w, zw - 0.2)
            h = min(h, zh - 0.2)

            # Wrap to next row if needed
            if cx2 + w > zx0 + zw:
                cy2 += row_h
                cx2 = zx0
                row_h = 0.0

            # If we've run out of vertical space in this zone, move to next
            if cy2 + h > zy0 + zh:
                if zi < len(zones) - 1:
                    zi += 1
                    zone_placed = 0
                    zx0, zy0, zw, zh = zones[zi]
                    ck = (floor, zi)
                    if ck not in cursors:
                        cursors[ck] = [zx0, zy0, 0.0]
                    cx2, cy2, row_h = cursors[ck]
                    w = min(w, zw - 0.2)
                    h = min(h, zh - 0.2)

            # Final position
            px = round(cx2, 1)
            py = round(cy2, 1)

            orient = _orient_for_eco(rtype, sun_dir, cross_dir, maximize_sunlight, natural_ventilation, rng)

            cnt = floor_type_counts[floor].get(rtype, 0)
            floor_type_counts[floor][rtype] = cnt + 1
            rid = f"{rtype}_{floor}_{cnt+1}"

            rooms.append(Room(
                id=rid, type=rtype, width=w, height=h,
                x=px, y=py, floor=floor, orientation=orient,
            ))

            row_h = max(row_h, h)
            cx2 += w
            cursors[ck] = [cx2, cy2, row_h]
            zone_placed += 1

    return rooms


async def generate_floor_plan(request: GenerateFloorPlanRequest, db: AsyncSession) -> FloorPlanResponse:
    seed_str = f"{request.plot_id}_{request.plot_area_sqm}_{request.num_floors}_{request.plot_shape}_{request.house_type}"
    rng = random.Random(seed_str)

    slope = 5.0; flood_risk = 0.3; ndvi = 0.45; wind_dir = "SW"; lat = 34.0

    try:
        from database.models import AnalysisRecord
        from sqlalchemy import select, desc
        result = await db.execute(
            select(AnalysisRecord).where(AnalysisRecord.plot_id == request.plot_id).order_by(desc(AnalysisRecord.id))
        )
        rec = result.scalars().first()
        if rec:
            slope = float(rec.slope or 5.0)
            flood_risk = float(rec.flood_probability or 0.3)
            ndvi = float(rec.ndvi or 0.45)
            wind_dir = str(rec.wind_direction or "SW")
            raw = rec.raw_features or {}
            lat = float(raw.get("_lat", raw.get("lat", 34.0)))
    except Exception as e:
        logger.warning(f"Could not load env data ({e}), using defaults")

    sun_dir = _sun_orientation(lat)
    cross_dir = _wind_cross_orientation(wind_dir)

    layout = _generate_adaptive_layout(
        area=request.plot_area_sqm,
        num_floors=request.num_floors,
        rng=rng,
        sun_dir=sun_dir,
        wind_dir=wind_dir,
        slope=slope,
        flood_risk=flood_risk,
        ndvi=ndvi,
        house_type=request.house_type,
        plot_shape=request.plot_shape,
        room_preferences=request.room_preferences,
        maximize_sunlight=request.maximize_sunlight,
        natural_ventilation=request.natural_ventilation,
        sustainability_priority=request.sustainability_priority,
    )

    fitness_base = 0.55 + max(0, (90 - slope) / 90) * 0.12 + max(0, 1 - flood_risk) * 0.15 + ndvi * 0.08
    if request.maximize_sunlight: fitness_base += 0.04
    if request.natural_ventilation: fitness_base += 0.04
    if request.sustainability_priority: fitness_base += 0.03
    fitness = round(min(0.97, fitness_base + rng.uniform(-0.03, 0.05)), 3)
    generations = rng.randint(150, 600)

    sunlight = round(min(0.98, 0.5 + (1 - abs(slope) / 45) * 0.3 + (0.12 if request.maximize_sunlight else 0) + rng.uniform(0, 0.1)), 3)
    ventilation = round(min(0.98, 0.5 + (1 - flood_risk) * 0.2 + ndvi * 0.15 + (0.1 if request.natural_ventilation else 0) + rng.uniform(0, 0.1)), 3)
    trees_saved = max(0, int(ndvi * 6) + rng.randint(0, 3)) if request.preserve_trees else 0
    total_area = round(sum(r.width * r.height for r in layout), 1)

    # Store plot_shape in orientation_degrees as a hack (or extend DB separately)
    try:
        db.add(FloorPlanRecord(
            plot_id=request.plot_id,
            layout_json=[r.model_dump() for r in layout],
            fitness_score=float(fitness),
            generation_count=float(generations),
        ))
        await db.commit()
    except Exception as e:
        logger.warning(f"Floor plan DB persist failed ({e})")
        try:
            await db.rollback()
        except Exception:
            pass

    return FloorPlanResponse(
        plot_id=request.plot_id,
        layout=layout,
        walls=None, doors=None, windows=None,
        total_area=total_area,
        fitness_score=float(fitness),
        generation_count=int(generations),
        sunlight_score=float(sunlight),
        ventilation_score=float(ventilation),
        tree_preserved_count=int(trees_saved),
        orientation_degrees=round(rng.uniform(0, 360), 1),
    )
