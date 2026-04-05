from __future__ import annotations

import concurrent.futures
import math
import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, TypedDict


class FitnessResult(TypedDict):
    solar_score: float
    ventilation_score: float
    structural_score: float
    flood_score: float
    tree_score: float
    eco_score: float
    buildability_bonus: float


@dataclass
class Room:
    id: str
    type: str
    x: float
    y: float
    width: float
    height: float
    floor: int
    orientation: str


@dataclass
class Chromosome:
    rooms: List[Room]
    orientation: float
    plot_w: float
    plot_h: float
    fitness: FitnessResult
    algorithm: str
    windows: List[Dict[str, Any]] = field(default_factory=list)
    eco_annotations: Dict[str, Any] = field(default_factory=dict)
    convergence_curve: List[float] = field(default_factory=list)
    generations_run: int = 0
    converged_early: bool = False
    runtime_ms: int = 0


COMPASS: Dict[str, float] = {
    "N": 0.0,
    "NNE": 22.5,
    "NE": 45.0,
    "ENE": 67.5,
    "E": 90.0,
    "ESE": 112.5,
    "SE": 135.0,
    "SSE": 157.5,
    "S": 180.0,
    "SSW": 202.5,
    "SW": 225.0,
    "WSW": 247.5,
    "W": 270.0,
    "WNW": 292.5,
    "NW": 315.0,
    "NNW": 337.5,
}

COMPASS_8 = {
    "N": 0.0,
    "NE": 45.0,
    "E": 90.0,
    "SE": 135.0,
    "S": 180.0,
    "SW": 225.0,
    "W": 270.0,
    "NW": 315.0,
}

HABITABLE_TYPES = {"living", "dining", "bedroom", "office"}
SERVICE_TYPES = {"kitchen", "bathroom", "utility"}

ROOM_FRACTIONS = {
    "living": 0.20,
    "dining": 0.10,
    "kitchen": 0.10,
    "bedroom": 0.15,
    "bathroom": 0.05,
    "office": 0.08,
    "utility": 0.05,
}

ROOM_MIN_DIMS: Dict[str, Tuple[float, float]] = {
    "living": (3.6, 3.0),
    "dining": (2.8, 2.5),
    "kitchen": (2.4, 2.2),
    "bedroom": (2.8, 2.8),
    "bathroom": (1.6, 1.6),
    "office": (2.5, 2.5),
    "utility": (2.0, 2.0),
}


def _clamp(value: float, low: float, high: float) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value


def _safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _compass_to_deg(direction: str) -> float:
    return COMPASS.get((direction or "S").upper(), 180.0)


def _room_bearing(room: Room) -> float:
    return COMPASS_8.get((room.orientation or "S").upper(), 180.0)


def _build_room_program(plot_area_sqm: float) -> List[Dict[str, Any]]:
    bedroom_count = 1 if plot_area_sqm < 90.0 else 2
    bathroom_count = 1 if plot_area_sqm < 85.0 else 2

    specs: List[Tuple[str, float]] = [
        ("living", ROOM_FRACTIONS["living"]),
        ("dining", ROOM_FRACTIONS["dining"]),
        ("kitchen", ROOM_FRACTIONS["kitchen"]),
    ]
    specs.extend(("bedroom", ROOM_FRACTIONS["bedroom"]) for _ in range(bedroom_count))
    specs.extend(("bathroom", ROOM_FRACTIONS["bathroom"]) for _ in range(bathroom_count))
    specs.append(("office", ROOM_FRACTIONS["office"]))
    specs.append(("utility", ROOM_FRACTIONS["utility"]))

    total = sum(frac for _, frac in specs)
    if total > 0.95:
        scale = 0.95 / total
        specs = [(t, f * scale) for t, f in specs]

    counters: Dict[str, int] = {}
    program: List[Dict[str, Any]] = []
    for room_type, fraction in specs:
        counters[room_type] = counters.get(room_type, 0) + 1
        rid = f"{room_type}_{counters[room_type]}"
        min_w, min_h = ROOM_MIN_DIMS.get(room_type, (2.4, 2.4))
        program.append(
            {
                "id": rid,
                "type": room_type,
                "fraction": fraction,
                "min_w": min_w,
                "min_h": min_h,
            }
        )
    return program


def _polygon_to_local_coords(polygon: List[List[float]], lat_hint: float) -> Tuple[List[Tuple[float, float]], Dict[str, float]]:
    if not polygon or len(polygon) < 3:
        return [], {}

    values = [pt for pt in polygon if isinstance(pt, (list, tuple)) and len(pt) >= 2]
    if len(values) < 3:
        return [], {}

    xs = [float(pt[0]) for pt in values]
    ys = [float(pt[1]) for pt in values]

    looks_geo = all(-180.0 <= x <= 180.0 for x in xs) and all(-90.0 <= y <= 90.0 for y in ys)
    if looks_geo:
        lon_min = min(xs)
        lat_min = min(ys)
        lat_ref = sum(ys) / max(len(ys), 1)
        m_lon = 111320.0 * math.cos(math.radians(lat_ref if abs(lat_ref) <= 90 else lat_hint))
        m_lat = 110540.0
        local = [((x - lon_min) * m_lon, (y - lat_min) * m_lat) for x, y in zip(xs, ys)]
        return local, {"lon_min": lon_min, "lat_min": lat_min, "m_lon": m_lon, "m_lat": m_lat}

    x_min = min(xs)
    y_min = min(ys)
    local_cart = [(x - x_min, y - y_min) for x, y in zip(xs, ys)]
    return local_cart, {}


def _normalize_env(env: Dict[str, Any]) -> Dict[str, Any]:
    lat = _safe_float(env.get("lat"), 0.0)
    lon = _safe_float(env.get("lon"), 0.0)
    plot_area = max(40.0, _safe_float(env.get("plot_area_sqm"), 180.0))

    polygon_raw = env.get("plot_polygon") if isinstance(env.get("plot_polygon"), list) else []
    polygon_local, transform = _polygon_to_local_coords(polygon_raw, lat)

    if polygon_local:
        px = [p[0] for p in polygon_local]
        py = [p[1] for p in polygon_local]
        poly_w = max(px) - min(px)
        poly_h = max(py) - min(py)
    else:
        poly_w = 0.0
        poly_h = 0.0

    base_w = _safe_float(env.get("plot_w"), 0.0)
    base_h = _safe_float(env.get("plot_h"), 0.0)
    if base_w <= 1e-6 or base_h <= 1e-6:
        if poly_w > 1.0 and poly_h > 1.0:
            base_w, base_h = poly_w, poly_h
        else:
            base_w = math.sqrt(plot_area * 1.4)
            base_h = plot_area / max(base_w, 1e-6)

    plot_w = max(base_w, 6.0)
    plot_h = max(base_h, 6.0)

    tree_coordinates = env.get("tree_coordinates") if isinstance(env.get("tree_coordinates"), list) else []
    tree_local: List[Dict[str, float]] = []
    for i, item in enumerate(tree_coordinates):
        if not isinstance(item, dict):
            continue
        radius = _safe_float(item.get("radius_m"), 1.5)
        confidence = _safe_float(item.get("confidence"), 0.8)
        if "x" in item and "y" in item:
            tx = _safe_float(item.get("x"), plot_w * 0.5)
            ty = _safe_float(item.get("y"), plot_h * 0.5)
            tree_local.append({"id": float(i), "x": tx, "y": ty, "radius_m": max(0.5, radius), "confidence": confidence})
            continue

        if transform and "lon" in item and "lat" in item:
            tx = (_safe_float(item.get("lon"), lon) - transform["lon_min"]) * transform["m_lon"]
            ty = (_safe_float(item.get("lat"), lat) - transform["lat_min"]) * transform["m_lat"]
            tree_local.append({"id": float(i), "x": tx, "y": ty, "radius_m": max(0.5, radius), "confidence": confidence})

    out = {
        "lat": lat,
        "lon": lon,
        "plot_area_sqm": plot_area,
        "plot_w": plot_w,
        "plot_h": plot_h,
        "plot_polygon": polygon_local,
        "flood_probability": _clamp(_safe_float(env.get("flood_probability"), 0.25), 0.0, 1.0),
        "buildability_score": _clamp(_safe_float(env.get("buildability_score"), 70.0), 1.0, 99.0),
        "slope": max(0.0, _safe_float(env.get("slope"), 5.0)),
        "elevation": _safe_float(env.get("elevation"), 120.0),
        "rainfall_mm": max(0.0, _safe_float(env.get("rainfall_mm"), 1200.0)),
        "wind_direction": str(env.get("wind_direction", "SW") or "SW").upper(),
        "sun_exposure_hours": max(0.0, _safe_float(env.get("sun_exposure_hours"), 6.0)),
        "ndvi": _clamp(_safe_float(env.get("ndvi"), 0.35), 0.0, 1.0),
        "clay_pct": _clamp(_safe_float(env.get("clay_pct"), 25.0), 0.0, 100.0),
        "solar_radiation": max(0.0, _safe_float(env.get("solar_radiation"), 5.2)),
        "tree_coordinates": tree_local,
        "room_program": _build_room_program(plot_area),
    }
    return out


def point_in_polygon(x: float, y: float, polygon: List[Tuple[float, float]]) -> bool:
    if not polygon or len(polygon) < 3:
        return True
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        intersects = ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def rooms_overlap(a: Room, b: Room) -> float:
    ox = max(0.0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x))
    oy = max(0.0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))
    return ox * oy


def _room_corners(room: Room) -> List[Tuple[float, float]]:
    return [
        (room.x, room.y),
        (room.x + room.width, room.y),
        (room.x, room.y + room.height),
        (room.x + room.width, room.y + room.height),
    ]


def _room_inside_polygon(room: Room, polygon: List[Tuple[float, float]]) -> bool:
    if not polygon:
        return True
    return all(point_in_polygon(x, y, polygon) for x, y in _room_corners(room))


def _fit_room_inside_polygon(room: Room, polygon: List[Tuple[float, float]], plot_w: float, plot_h: float) -> Room:
    if not polygon or _room_inside_polygon(room, polygon):
        return room

    min_w, min_h = ROOM_MIN_DIMS.get(room.type, (2.0, 2.0))
    scales = [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65]
    for scale in scales:
        cand_w = max(min_w, room.width * scale)
        cand_h = max(min_h, room.height * scale)
        max_x = max(plot_w - cand_w, 0.0)
        max_y = max(plot_h - cand_h, 0.0)

        # coarse search is enough and much faster than exhaustive checks
        for gy in range(9):
            y = max_y * gy / 8.0
            for gx in range(9):
                x = max_x * gx / 8.0
                cand = Room(
                    id=room.id,
                    type=room.type,
                    x=x,
                    y=y,
                    width=cand_w,
                    height=cand_h,
                    floor=room.floor,
                    orientation=room.orientation,
                )
                if _room_inside_polygon(cand, polygon):
                    return cand

    return Room(
        id=room.id,
        type=room.type,
        x=_clamp(room.x, 0.0, max(plot_w - min_w, 0.0)),
        y=_clamp(room.y, 0.0, max(plot_h - min_h, 0.0)),
        width=min_w,
        height=min_h,
        floor=room.floor,
        orientation=room.orientation,
    )


def _resolve_room_overlaps(rooms: List[Room], plot_w: float, plot_h: float, iterations: int = 4) -> List[Room]:
    mutable = [Room(**room.__dict__) for room in rooms]
    for _ in range(iterations):
        changed = False
        for i in range(len(mutable)):
            a = mutable[i]
            for j in range(i + 1, len(mutable)):
                b = mutable[j]
                overlap = rooms_overlap(a, b)
                if overlap <= 1e-6:
                    continue
                ox = min(a.x + a.width, b.x + b.width) - max(a.x, b.x)
                oy = min(a.y + a.height, b.y + b.height) - max(a.y, b.y)
                if ox <= 0.0 or oy <= 0.0:
                    continue

                if ox < oy:
                    shift = ox * 0.5 + 0.05
                    b.x = _clamp(b.x + shift, 0.0, max(plot_w - b.width, 0.0))
                else:
                    shift = oy * 0.5 + 0.05
                    b.y = _clamp(b.y + shift, 0.0, max(plot_h - b.height, 0.0))
                changed = True
        if not changed:
            break
    return mutable


def _decode_vector_to_rooms(vec: List[float], env: Dict[str, Any], strict: bool = True) -> List[Room]:
    plot_w = env["plot_w"]
    plot_h = env["plot_h"]
    plot_area = env["plot_area_sqm"]
    polygon = env["plot_polygon"]
    program = env["room_program"]

    needed = len(program) * 4
    padded = list(vec[:needed])
    if len(padded) < needed:
        padded.extend([0.5] * (needed - len(padded)))
    padded = [_clamp(v, 0.0, 1.0) for v in padded]

    rooms: List[Room] = []
    for i, spec in enumerate(program):
        g = padded[i * 4 : i * 4 + 4]
        x_n, y_n, w_n, h_n = g

        room_type = str(spec["type"])
        rid = str(spec["id"])
        fraction = float(spec["fraction"])
        min_w = float(spec["min_w"])
        min_h = float(spec["min_h"])

        target_area = max(min_w * min_h, plot_area * fraction)
        aspect = 0.8 + 1.4 * w_n
        width = max(min_w, math.sqrt(target_area * aspect))
        width = width * (0.8 + 0.4 * h_n)
        height = max(min_h, target_area / max(width, 1e-6))

        width = min(width, plot_w * 0.9)
        height = min(height, plot_h * 0.9)

        if room_type in {"living", "dining"}:
            y_n = 0.65 * y_n + 0.35
        elif room_type in {"bedroom", "office"}:
            y_n = 0.8 * y_n + 0.1

        x = _clamp(x_n * max(plot_w - width, 0.0), 0.0, max(plot_w - width, 0.0))
        y = _clamp(y_n * max(plot_h - height, 0.0), 0.0, max(plot_h - height, 0.0))

        rooms.append(
            Room(
                id=rid,
                type=room_type,
                x=x,
                y=y,
                width=width,
                height=height,
                floor=1,
                orientation="S",
            )
        )

    if strict:
        rooms = _resolve_room_overlaps(rooms, plot_w, plot_h, iterations=5)
        if polygon:
            rooms = [_fit_room_inside_polygon(room, polygon, plot_w, plot_h) for room in rooms]
        rooms = assign_orientations(rooms, plot_w, plot_h)

    return rooms


def decode_vector_to_rooms(vec: List[float], env: Dict[str, Any]) -> List[Room]:
    env_n = _normalize_env(env)
    return _decode_vector_to_rooms(vec, env_n, strict=True)


def encode_rooms_to_vector(rooms: List[Room], env: Dict[str, Any]) -> List[float]:
    env_n = _normalize_env(env)
    plot_w = env_n["plot_w"]
    plot_h = env_n["plot_h"]
    program = env_n["room_program"]

    room_by_id = {room.id: room for room in rooms}
    vec: List[float] = []
    for spec in program:
        room = room_by_id.get(spec["id"])
        min_w, min_h = ROOM_MIN_DIMS.get(spec["type"], (2.0, 2.0))
        if room is None:
            vec.extend([0.5, 0.5, 0.5, 0.5])
            continue

        x_n = room.x / max(plot_w - room.width, 1e-6)
        y_n = room.y / max(plot_h - room.height, 1e-6)
        w_n = (room.width / max(min_w, 1e-6) - 0.8) / 0.4
        h_n = (room.height / max(min_h, 1e-6) - 0.8) / 0.4
        vec.extend([
            _clamp(x_n, 0.0, 1.0),
            _clamp(y_n, 0.0, 1.0),
            _clamp(w_n, 0.0, 1.0),
            _clamp(h_n, 0.0, 1.0),
        ])

    return vec


def assign_orientations(rooms: List[Room], plot_w: float, plot_h: float) -> List[Room]:
    oriented: List[Room] = []
    for room in rooms:
        d_s = room.y
        d_n = plot_h - (room.y + room.height)
        d_w = room.x
        d_e = plot_w - (room.x + room.width)

        sorted_faces = sorted(
            [("S", d_s), ("N", d_n), ("W", d_w), ("E", d_e)],
            key=lambda it: it[1],
        )

        primary = sorted_faces[0][0]
        secondary = sorted_faces[1][0]
        if abs(sorted_faces[0][1] - sorted_faces[1][1]) < 0.3:
            combo = {primary, secondary}
            if combo == {"N", "E"}:
                ori = "NE"
            elif combo == {"N", "W"}:
                ori = "NW"
            elif combo == {"S", "E"}:
                ori = "SE"
            elif combo == {"S", "W"}:
                ori = "SW"
            else:
                ori = primary
        else:
            ori = primary

        oriented.append(
            Room(
                id=room.id,
                type=room.type,
                x=room.x,
                y=room.y,
                width=room.width,
                height=room.height,
                floor=room.floor,
                orientation=ori,
            )
        )
    return oriented


def _room_exterior_faces(room: Room, plot_w: float, plot_h: float, tol: float = 0.35) -> List[str]:
    faces: List[str] = []
    if room.y <= tol:
        faces.append("S")
    if (plot_h - (room.y + room.height)) <= tol:
        faces.append("N")
    if room.x <= tol:
        faces.append("W")
    if (plot_w - (room.x + room.width)) <= tol:
        faces.append("E")
    return faces


def _distance_point_to_rect(px: float, py: float, room: Room) -> float:
    dx = max(room.x - px, 0.0, px - (room.x + room.width))
    dy = max(room.y - py, 0.0, py - (room.y + room.height))
    return math.hypot(dx, dy)


def _rect_circle_overlap(room: Room, cx: float, cy: float, radius: float) -> bool:
    nx = _clamp(cx, room.x, room.x + room.width)
    ny = _clamp(cy, room.y, room.y + room.height)
    return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius ** 2


def _evaluate_rooms(rooms: List[Room], env: Dict[str, Any]) -> FitnessResult:
    lat = env["lat"]
    plot_w = env["plot_w"]
    plot_h = env["plot_h"]
    polygon = env["plot_polygon"]

    buildability_bonus = _clamp(env["buildability_score"] / 100.0, 0.0, 1.0)

    # Solar score
    sun_bearing = 180.0 if lat >= 0.0 else 0.0
    habitable_rooms = [room for room in rooms if room.type in HABITABLE_TYPES]
    if habitable_rooms:
        solar_total = 0.0
        for room in habitable_rooms:
            room_bearing = _room_bearing(room)
            alignment = math.cos(math.radians(_angle_diff(room_bearing, sun_bearing)))
            solar_total += max(0.0, alignment)
        solar_score = solar_total / len(habitable_rooms)
    else:
        solar_score = 0.5

    if env["solar_radiation"] > 6.0:
        solar_score = 1.0 - solar_score * 0.6
    solar_score = _clamp(solar_score, 0.0, 1.0)

    # Ventilation score
    wind_bearing = _compass_to_deg(env["wind_direction"])
    vent_contribs: List[float] = []
    cross_vent_bonus = 0.0
    for room in rooms:
        faces = _room_exterior_faces(room, plot_w, plot_h)
        if not faces:
            continue

        room_facing = _room_bearing(room)
        angle_diff = _angle_diff(room_facing, wind_bearing)
        vent_contribs.append(max(0.0, math.cos(math.radians(angle_diff))))

        face_bearings = [COMPASS_8.get(face, room_facing) for face in faces]
        has_windward = any(_angle_diff(face_bearing, wind_bearing) <= 60.0 for face_bearing in face_bearings)
        leeward = (wind_bearing + 180.0) % 360.0
        has_leeward = any(_angle_diff(face_bearing, leeward) <= 60.0 for face_bearing in face_bearings)
        if has_windward and has_leeward:
            cross_vent_bonus += 0.2

    ventilation_score = (sum(vent_contribs) / len(vent_contribs)) if vent_contribs else 0.4
    ventilation_score = _clamp(ventilation_score + cross_vent_bonus, 0.0, 1.0)

    # Structural score
    total_penalty = 0.0
    for i in range(len(rooms)):
        a = rooms[i]
        a_area = max(a.width * a.height, 1e-6)
        for j in range(i + 1, len(rooms)):
            b = rooms[j]
            overlap = rooms_overlap(a, b)
            if overlap > 1e-9:
                total_penalty += overlap / a_area

    for room in rooms:
        if polygon:
            if not _room_inside_polygon(room, polygon):
                total_penalty += 0.35
        else:
            inside_box = (
                room.x >= 0.0
                and room.y >= 0.0
                and room.x + room.width <= plot_w
                and room.y + room.height <= plot_h
            )
            if not inside_box:
                total_penalty += 0.35

        if "corridor" in room.type and min(room.width, room.height) < 0.9:
            total_penalty += 0.2

    structural_score = _clamp(max(0.0, 1.0 - total_penalty), 0.0, 1.0)

    # Flood score
    habitable_flood_rooms = [room for room in rooms if room.type in {"living", "bedroom", "dining"}]
    in_flood_zone = 0
    flood_probability = env["flood_probability"]
    if flood_probability > 0.4 and habitable_flood_rooms:
        flood_setback_m = flood_probability * 2.0
        for room in habitable_flood_rooms:
            if room.y < flood_setback_m:
                in_flood_zone += 1

    flood_score = 1.0
    if habitable_flood_rooms:
        flood_score = 1.0 - (in_flood_zone / len(habitable_flood_rooms))

    leeward = (_compass_to_deg(env["wind_direction"]) + 180.0) % 360.0
    service_rooms = [room for room in rooms if room.type in SERVICE_TYPES]
    if service_rooms:
        service_good = sum(1 for room in service_rooms if _angle_diff(_room_bearing(room), leeward) <= 70.0)
        if service_good / len(service_rooms) >= 0.5:
            flood_score += 0.15
    flood_score = _clamp(flood_score, 0.0, 1.0)

    # Tree score
    penalties = 0.0
    bonuses = 0.0
    for tree in env["tree_coordinates"]:
        tx = _safe_float(tree.get("x"), plot_w * 0.5)
        ty = _safe_float(tree.get("y"), plot_h * 0.5)
        radius = max(0.5, _safe_float(tree.get("radius_m"), 1.5))

        if any(_rect_circle_overlap(room, tx, ty, radius) for room in rooms):
            penalties += 0.25

        if any(_distance_point_to_rect(tx, ty, room) <= 3.0 for room in rooms):
            bonuses += 0.05

    tree_score = max(0.0, 1.0 - penalties + min(bonuses, 0.30))
    tree_score = _clamp(tree_score, 0.0, 1.0)

    eco_score = (
        0.28 * solar_score
        + 0.22 * ventilation_score
        + 0.20 * structural_score
        + 0.15 * flood_score
        + 0.10 * tree_score
        + 0.05 * buildability_bonus
    )
    eco_score = _clamp(eco_score, 0.0, 1.0)

    return {
        "solar_score": solar_score,
        "ventilation_score": ventilation_score,
        "structural_score": structural_score,
        "flood_score": flood_score,
        "tree_score": tree_score,
        "eco_score": eco_score,
        "buildability_bonus": buildability_bonus,
    }


def evaluate_chromosome(c: Chromosome, env: Dict[str, Any]) -> FitnessResult:
    env_n = _normalize_env(env)
    return _evaluate_rooms(c.rooms, env_n)


def _vector_to_chromosome(vec: List[float], env: Dict[str, Any], algorithm: str, strict: bool = False) -> Chromosome:
    rooms = _decode_vector_to_rooms(vec, env, strict=strict)
    if not strict:
        # Keep orientation consistent enough for fitness evaluation
        rooms = assign_orientations(rooms, env["plot_w"], env["plot_h"])
    building_orientation = 0.0
    if len(vec) > len(env["room_program"]) * 4:
        building_orientation = _clamp(vec[-1], 0.0, 1.0) * 360.0

    fitness = _evaluate_rooms(rooms, env)
    return Chromosome(
        rooms=rooms,
        orientation=building_orientation,
        plot_w=env["plot_w"],
        plot_h=env["plot_h"],
        fitness=fitness,
        algorithm=algorithm,
    )


def _random_vector(env: Dict[str, Any], rng: random.Random) -> List[float]:
    n = len(env["room_program"]) * 4 + 1
    return [rng.random() for _ in range(n)]


def _dominates(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    av = a["objectives"]
    bv = b["objectives"]
    return all(x >= y for x, y in zip(av, bv)) and any(x > y for x, y in zip(av, bv))


def fast_non_dominated_sort(population: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    if not population:
        return []

    domination_sets: Dict[int, List[int]] = {i: [] for i in range(len(population))}
    dominated_counts: Dict[int, int] = {i: 0 for i in range(len(population))}
    fronts: List[List[int]] = [[]]

    for p in range(len(population)):
        for q in range(len(population)):
            if p == q:
                continue
            if _dominates(population[p], population[q]):
                domination_sets[p].append(q)
            elif _dominates(population[q], population[p]):
                dominated_counts[p] += 1
        if dominated_counts[p] == 0:
            fronts[0].append(p)

    i = 0
    while i < len(fronts) and fronts[i]:
        next_front: List[int] = []
        for p in fronts[i]:
            for q in domination_sets[p]:
                dominated_counts[q] -= 1
                if dominated_counts[q] == 0:
                    next_front.append(q)
        if next_front:
            fronts.append(next_front)
        i += 1

    sorted_fronts: List[List[Dict[str, Any]]] = []
    for front_idx in fronts:
        if not front_idx:
            continue
        sorted_fronts.append([population[idx] for idx in front_idx])
    return sorted_fronts


def crowding_distance(front: List[Dict[str, Any]]) -> Dict[int, float]:
    if not front:
        return {}

    distance: Dict[int, float] = {id(ind): 0.0 for ind in front}
    objective_count = len(front[0]["objectives"])

    for m in range(objective_count):
        ordered = sorted(front, key=lambda ind: ind["objectives"][m])
        distance[id(ordered[0])] = float("inf")
        distance[id(ordered[-1])] = float("inf")

        min_obj = ordered[0]["objectives"][m]
        max_obj = ordered[-1]["objectives"][m]
        span = max(max_obj - min_obj, 1e-9)

        for i in range(1, len(ordered) - 1):
            prev_obj = ordered[i - 1]["objectives"][m]
            next_obj = ordered[i + 1]["objectives"][m]
            distance[id(ordered[i])] += (next_obj - prev_obj) / span

    return distance


def _sbx_gene(x1: float, x2: float, eta: float, rng: random.Random) -> Tuple[float, float]:
    if abs(x1 - x2) <= 1e-12:
        return x1, x2

    x_low = min(x1, x2)
    x_high = max(x1, x2)
    rand = rng.random()

    beta = 1.0 + (2.0 * (x_low - 0.0) / (x_high - x_low))
    alpha = 2.0 - beta ** (-(eta + 1.0))
    if rand <= 1.0 / alpha:
        betaq = (rand * alpha) ** (1.0 / (eta + 1.0))
    else:
        betaq = (1.0 / (2.0 - rand * alpha)) ** (1.0 / (eta + 1.0))
    c1 = 0.5 * ((x_low + x_high) - betaq * (x_high - x_low))

    beta = 1.0 + (2.0 * (1.0 - x_high) / (x_high - x_low))
    alpha = 2.0 - beta ** (-(eta + 1.0))
    if rand <= 1.0 / alpha:
        betaq = (rand * alpha) ** (1.0 / (eta + 1.0))
    else:
        betaq = (1.0 / (2.0 - rand * alpha)) ** (1.0 / (eta + 1.0))
    c2 = 0.5 * ((x_low + x_high) + betaq * (x_high - x_low))

    return _clamp(c1, 0.0, 1.0), _clamp(c2, 0.0, 1.0)


def sbx_crossover(p1: List[float], p2: List[float], eta: float = 20, rng: Optional[random.Random] = None) -> Tuple[List[float], List[float]]:
    rng = rng or random
    child1 = list(p1)
    child2 = list(p2)
    for i in range(min(len(child1), len(child2))):
        if rng.random() <= 0.5:
            c1, c2 = _sbx_gene(child1[i], child2[i], eta, rng)
            child1[i], child2[i] = c1, c2
    return child1, child2


def polynomial_mutation(individual: List[float], eta: float = 15, prob: float = 0.15, rng: Optional[random.Random] = None) -> List[float]:
    rng = rng or random
    mutant = list(individual)
    for i, x in enumerate(mutant):
        if rng.random() > prob:
            continue

        delta1 = x
        delta2 = 1.0 - x
        rnd = rng.random()
        mut_pow = 1.0 / (eta + 1.0)

        if rnd <= 0.5:
            xy = 1.0 - delta1
            val = 2.0 * rnd + (1.0 - 2.0 * rnd) * (xy ** (eta + 1.0))
            deltaq = val ** mut_pow - 1.0
        else:
            xy = 1.0 - delta2
            val = 2.0 * (1.0 - rnd) + 2.0 * (rnd - 0.5) * (xy ** (eta + 1.0))
            deltaq = 1.0 - val ** mut_pow

        mutant[i] = _clamp(x + deltaq, 0.0, 1.0)

    return mutant


def _evaluate_vector(vec: List[float], env: Dict[str, Any], algorithm: str, strict: bool = False) -> Dict[str, Any]:
    chrom = _vector_to_chromosome(vec, env, algorithm, strict=strict)
    fit = chrom.fitness
    objectives = [fit["solar_score"], fit["ventilation_score"], fit["structural_score"], fit["flood_score"]]
    return {
        "vector": list(vec),
        "chromosome": chrom,
        "fitness": fit,
        "objectives": objectives,
        "eco": fit["eco_score"],
    }


def _create_reference_points(m: int, divisions: int) -> List[List[float]]:
    points: List[List[float]] = []

    def recurse(remaining: int, depth: int, current: List[int]) -> None:
        if depth == m - 1:
            points.append([(value / divisions) for value in current + [remaining]])
            return
        for value in range(remaining + 1):
            recurse(remaining - value, depth + 1, current + [value])

    recurse(divisions, 0, [])
    return points


def _nearest_reference_index(objectives: List[float], refs: List[List[float]]) -> int:
    if not refs:
        return 0
    best_idx = 0
    best_dist = float("inf")
    for i, ref in enumerate(refs):
        d = math.sqrt(sum((a - b) ** 2 for a, b in zip(objectives, ref)))
        if d < best_dist:
            best_dist = d
            best_idx = i
    return best_idx


def _timed_out(stop_event: threading.Event, deadline: float) -> bool:
    if stop_event.is_set():
        return True
    if time.perf_counter() >= deadline:
        stop_event.set()
        return True
    return False


def _finalize_result(
    best_ind: Dict[str, Any],
    env: Dict[str, Any],
    algorithm: str,
    convergence_curve: List[float],
    generations_run: int,
    converged_early: bool,
    started_at: float,
) -> Chromosome:
    # Final strict decode guarantees final rooms respect polygon/boundary constraints.
    strict_chrom = _vector_to_chromosome(best_ind["vector"], env, algorithm, strict=True)
    strict_chrom.convergence_curve = list(convergence_curve)
    strict_chrom.generations_run = generations_run
    strict_chrom.converged_early = converged_early
    strict_chrom.runtime_ms = int((time.perf_counter() - started_at) * 1000)
    return strict_chrom


def _tournament(population: List[Dict[str, Any]], rank: Dict[int, int], crowding: Dict[int, float], rng: random.Random) -> Dict[str, Any]:
    a = rng.choice(population)
    b = rng.choice(population)
    ra = rank.get(id(a), 10**6)
    rb = rank.get(id(b), 10**6)
    if ra < rb:
        return a
    if rb < ra:
        return b
    ca = crowding.get(id(a), 0.0)
    cb = crowding.get(id(b), 0.0)
    if ca > cb:
        return a
    if cb > ca:
        return b
    return a if a["eco"] >= b["eco"] else b


def run_nsga3(env: Dict[str, Any], seed: int) -> Chromosome:
    warm_seed_raw = env.get("_warm_seed") if isinstance(env, dict) else None
    warm_elite_fraction = _safe_float((env.get("_warm_elite_fraction") if isinstance(env, dict) else None), 0.0)
    warm_generations = int(_safe_float((env.get("_max_generations") if isinstance(env, dict) else None), 100.0))

    env_n = _normalize_env(env)
    rng = random.Random(seed)
    stop_event = threading.Event()
    started_at = time.perf_counter()
    deadline = started_at + 7.5

    population_size = 80
    generations = max(10, min(warm_generations, 100))
    mutation_rate = 0.15

    warm_population: List[Dict[str, Any]] = []
    if isinstance(warm_seed_raw, list) and warm_seed_raw:
        clipped = [_clamp(_safe_float(value, 0.5), 0.0, 1.0) for value in warm_seed_raw]
        elite_count = int(population_size * max(0.0, min(1.0, warm_elite_fraction)))
        elite_count = max(1, min(population_size, elite_count))

        warm_population.append(_evaluate_vector(clipped, env_n, "NSGA-III", strict=False))
        for _ in range(elite_count - 1):
            jittered = [
                _clamp(value + rng.uniform(-0.03, 0.03), 0.0, 1.0)
                for value in clipped
            ]
            warm_population.append(_evaluate_vector(jittered, env_n, "NSGA-III", strict=False))

    population = list(warm_population)
    while len(population) < population_size:
        population.append(_evaluate_vector(_random_vector(env_n, rng), env_n, "NSGA-III", strict=False))

    refs = _create_reference_points(4, 6)
    convergence: List[float] = []
    best_ind = max(population, key=lambda ind: ind["eco"])
    best_eco = best_ind["eco"]
    stagnation = 0
    generations_run = 0
    converged_early = False

    for gen in range(generations):
        if _timed_out(stop_event, deadline):
            break

        fronts = fast_non_dominated_sort(population)
        rank: Dict[int, int] = {}
        crowding: Dict[int, float] = {}
        for rank_idx, front in enumerate(fronts):
            cd = crowding_distance(front)
            crowding.update(cd)
            for ind in front:
                rank[id(ind)] = rank_idx

        offspring: List[Dict[str, Any]] = []
        while len(offspring) < population_size:
            if _timed_out(stop_event, deadline):
                break
            p1 = _tournament(population, rank, crowding, rng)
            p2 = _tournament(population, rank, crowding, rng)
            c1, c2 = sbx_crossover(p1["vector"], p2["vector"], eta=20, rng=rng)
            c1 = polynomial_mutation(c1, eta=15, prob=mutation_rate, rng=rng)
            c2 = polynomial_mutation(c2, eta=15, prob=mutation_rate, rng=rng)
            offspring.append(_evaluate_vector(c1, env_n, "NSGA-III", strict=False))
            if len(offspring) < population_size:
                offspring.append(_evaluate_vector(c2, env_n, "NSGA-III", strict=False))

        combined = population + offspring
        fronts = fast_non_dominated_sort(combined)

        next_population: List[Dict[str, Any]] = []
        for front in fronts:
            if len(next_population) + len(front) <= population_size:
                next_population.extend(front)
                continue

            # NSGA-III inspired niche filling using generated reference points.
            need = population_size - len(next_population)
            cd = crowding_distance(front)
            assignments: Dict[int, int] = {}
            niche_count: Dict[int, int] = {}
            for ind in front:
                ref_idx = _nearest_reference_index(ind["objectives"], refs)
                assignments[id(ind)] = ref_idx
                niche_count[ref_idx] = niche_count.get(ref_idx, 0) + 1

            ordered_front = sorted(
                front,
                key=lambda ind: (
                    niche_count.get(assignments[id(ind)], 0),
                    -cd.get(id(ind), 0.0),
                    -ind["eco"],
                ),
            )
            next_population.extend(ordered_front[:need])
            break

        population = next_population if next_population else population

        gen_best = max(population, key=lambda ind: ind["eco"])
        convergence.append(gen_best["eco"])
        generations_run = gen + 1

        if gen_best["eco"] > best_eco + 0.001:
            best_eco = gen_best["eco"]
            best_ind = gen_best
            stagnation = 0
        else:
            stagnation += 1

        if stagnation >= 20:
            converged_early = True
            break

    fronts = fast_non_dominated_sort(population)
    if fronts:
        pareto = fronts[0]
        best_ind = max(pareto, key=lambda ind: ind["eco"])

    return _finalize_result(
        best_ind,
        env_n,
        "NSGA-III",
        convergence,
        generations_run,
        converged_early,
        started_at,
    )


def tchebycheff(f_vec: List[float], weights: List[float], ideal: List[float]) -> float:
    return max(w * abs(f - z) for f, w, z in zip(f_vec, weights, ideal))


def generate_weight_vectors(env: Dict[str, Any], N: int) -> List[List[float]]:
    env_n = _normalize_env(env)

    solar = max(env_n["solar_radiation"], 1e-6)
    rainfall_norm = _clamp(env_n["rainfall_mm"] / 3000.0, 0.0, 1.0)
    wind_norm = _clamp(abs(math.sin(math.radians(_compass_to_deg(env_n["wind_direction"])))) + 0.2, 0.0, 1.0)
    flood_norm = _clamp(env_n["flood_probability"], 0.0, 1.0)

    base = [
        solar,
        wind_norm,
        max(1e-6, 1.0 - env_n["flood_probability"]),
        max(1e-6, flood_norm),
    ]
    denom = sum(base) or 1.0
    base = [b / denom for b in base]

    rng_seed = int((env_n["lat"] + 90.0) * 1000 + (env_n["lon"] + 180.0) * 1000)
    rng = random.Random(rng_seed)

    vectors: List[List[float]] = []
    for _ in range(N):
        jittered = [max(0.01, b * (0.75 + 0.5 * rng.random())) for b in base]
        total = sum(jittered)
        vectors.append([v / total for v in jittered])

    return vectors


def run_moead(env: Dict[str, Any], seed: int) -> Chromosome:
    env_n = _normalize_env(env)
    rng = random.Random(seed)
    stop_event = threading.Event()
    started_at = time.perf_counter()
    deadline = started_at + 7.5

    population_size = 60
    generations = 120
    neighborhood_size = 10
    delta = 0.9
    mutation_rate = 0.20

    weights = generate_weight_vectors(env_n, population_size)
    population = [_evaluate_vector(_random_vector(env_n, rng), env_n, "MOEA-D", strict=False) for _ in range(population_size)]

    distances: List[List[int]] = []
    for i in range(population_size):
        ds = []
        for j in range(population_size):
            d = math.sqrt(sum((weights[i][k] - weights[j][k]) ** 2 for k in range(4)))
            ds.append((d, j))
        ds.sort(key=lambda x: x[0])
        distances.append([idx for _, idx in ds[:neighborhood_size]])

    ideal = [max(ind["objectives"][i] for ind in population) for i in range(4)]

    convergence: List[float] = []
    best_ind = max(population, key=lambda ind: ind["eco"])
    best_eco = best_ind["eco"]
    stagnation = 0
    generations_run = 0
    converged_early = False

    for gen in range(generations):
        if _timed_out(stop_event, deadline):
            break

        for i in range(population_size):
            if _timed_out(stop_event, deadline):
                break

            if rng.random() < delta:
                pool_idx = distances[i]
            else:
                pool_idx = list(range(population_size))

            if len(pool_idx) < 3:
                pool_idx = list(range(population_size))

            a_idx, b_idx, c_idx = rng.sample(pool_idx, 3)
            a = population[a_idx]["vector"]
            b = population[b_idx]["vector"]
            c = population[c_idx]["vector"]

            mutant = [
                _clamp(a[d] + 0.5 * (b[d] - c[d]), 0.0, 1.0)
                for d in range(len(a))
            ]

            target = population[i]["vector"]
            trial = []
            j_rand = rng.randrange(len(target))
            for d in range(len(target)):
                if rng.random() < 0.9 or d == j_rand:
                    val = mutant[d]
                else:
                    val = target[d]
                if rng.random() < mutation_rate:
                    val = _clamp(val + rng.uniform(-0.12, 0.12), 0.0, 1.0)
                trial.append(val)

            child = _evaluate_vector(trial, env_n, "MOEA-D", strict=False)

            for m in range(4):
                ideal[m] = max(ideal[m], child["objectives"][m])

            for j in distances[i]:
                current_val = tchebycheff(population[j]["objectives"], weights[j], ideal)
                child_val = tchebycheff(child["objectives"], weights[j], ideal)
                if child_val <= current_val:
                    population[j] = child

        gen_best = max(population, key=lambda ind: ind["eco"])
        convergence.append(gen_best["eco"])
        generations_run = gen + 1

        if gen_best["eco"] > best_eco + 0.001:
            best_eco = gen_best["eco"]
            best_ind = gen_best
            stagnation = 0
        else:
            stagnation += 1

        if stagnation >= 20:
            converged_early = True
            break

    _best_tch_idx, best_tch = min(
        enumerate(population),
        key=lambda item: tchebycheff(item[1]["objectives"], weights[item[0]], ideal),
    )
    if best_tch["eco"] > best_ind["eco"]:
        best_ind = best_tch

    return _finalize_result(
        best_ind,
        env_n,
        "MOEA-D",
        convergence,
        generations_run,
        converged_early,
        started_at,
    )


def shade_mutation(
    pop: List[Dict[str, Any]],
    archive: List[List[float]],
    F: float,
    CR: float,
    p: float = 0.11,
    rng: Optional[random.Random] = None,
    idx: Optional[int] = None,
) -> List[float]:
    rng = rng or random
    if not pop:
        return []

    if idx is None:
        idx = rng.randrange(len(pop))

    current = pop[idx]["vector"]
    ranked = sorted(pop, key=lambda ind: ind["eco"], reverse=True)
    p_count = max(2, int(math.ceil(p * len(ranked))))
    pbest = rng.choice(ranked[:p_count])["vector"]

    idx_pool = [i for i in range(len(pop)) if i != idx]
    r1_idx = rng.choice(idx_pool) if idx_pool else idx
    r1 = pop[r1_idx]["vector"]

    merged_pool = [ind["vector"] for ind in pop] + list(archive)
    r2 = rng.choice(merged_pool)

    mutant = [
        _clamp(current[d] + F * (pbest[d] - current[d]) + F * (r1[d] - r2[d]), 0.0, 1.0)
        for d in range(len(current))
    ]

    trial = []
    j_rand = rng.randrange(len(current))
    for d in range(len(current)):
        if rng.random() < CR or d == j_rand:
            trial.append(mutant[d])
        else:
            trial.append(current[d])

    return trial


def lehmer_mean(values: List[float]) -> float:
    if not values:
        return 0.5
    num = sum(v * v for v in values)
    den = sum(values)
    if abs(den) <= 1e-12:
        return 0.5
    return num / den


def _sample_cauchy(loc: float, scale: float, rng: random.Random) -> float:
    u = rng.random() - 0.5
    return loc + scale * math.tan(math.pi * u)


def run_shade(env: Dict[str, Any], seed: int) -> Chromosome:
    env_n = _normalize_env(env)
    rng = random.Random(seed)
    stop_event = threading.Event()
    started_at = time.perf_counter()
    deadline = started_at + 7.5

    pop_size = 50
    generations = 150
    H = 50
    p = 0.11
    archive_size = 50

    M_F = [0.5 for _ in range(H)]
    M_CR = [0.5 for _ in range(H)]
    k = 0

    population = [_evaluate_vector(_random_vector(env_n, rng), env_n, "SHADE", strict=False) for _ in range(pop_size)]
    archive: List[List[float]] = []

    convergence: List[float] = []
    best_ind = max(population, key=lambda ind: ind["eco"])
    best_eco = best_ind["eco"]
    stagnation = 0
    generations_run = 0
    converged_early = False

    for gen in range(generations):
        if _timed_out(stop_event, deadline):
            break

        success_F: List[float] = []
        success_CR: List[float] = []
        success_df: List[float] = []

        for i in range(pop_size):
            if _timed_out(stop_event, deadline):
                break

            r = rng.randrange(H)
            F = _sample_cauchy(M_F[r], 0.1, rng)
            attempts = 0
            while F <= 0.0 and attempts < 8:
                F = _sample_cauchy(M_F[r], 0.1, rng)
                attempts += 1
            F = _clamp(F if F > 0.0 else 0.5, 1e-4, 1.0)
            CR = _clamp(rng.gauss(M_CR[r], 0.1), 0.0, 1.0)

            trial_vec = shade_mutation(population, archive, F, CR, p=p, rng=rng, idx=i)
            trial = _evaluate_vector(trial_vec, env_n, "SHADE", strict=False)

            if trial["eco"] > population[i]["eco"]:
                success_F.append(F)
                success_CR.append(CR)
                success_df.append(trial["eco"] - population[i]["eco"])
                archive.append(population[i]["vector"])
                population[i] = trial

        if len(archive) > archive_size:
            archive = archive[-archive_size:]

        if success_F:
            weight_sum = sum(success_df) or 1.0
            weights = [df / weight_sum for df in success_df]
            weighted_F = sum(w * f for w, f in zip(weights, success_F))
            weighted_CR = sum(w * cr for w, cr in zip(weights, success_CR))
            M_F[k] = _clamp((lehmer_mean(success_F) + weighted_F) * 0.5, 0.05, 1.0)
            M_CR[k] = _clamp((lehmer_mean(success_CR) + weighted_CR) * 0.5, 0.0, 1.0)
            k = (k + 1) % H

        gen_best = max(population, key=lambda ind: ind["eco"])
        convergence.append(gen_best["eco"])
        generations_run = gen + 1

        if gen_best["eco"] > best_eco + 0.001:
            best_eco = gen_best["eco"]
            best_ind = gen_best
            stagnation = 0
        else:
            stagnation += 1

        if stagnation >= 20:
            converged_early = True
            break

    return _finalize_result(
        best_ind,
        env_n,
        "SHADE",
        convergence,
        generations_run,
        converged_early,
        started_at,
    )


def _topology_seed_vector(island_id: int, env: Dict[str, Any], rng: random.Random) -> List[float]:
    vec = _random_vector(env, rng)
    program = env["room_program"]

    for idx, spec in enumerate(program):
        room_type = spec["type"]
        base = idx * 4

        if island_id == 0:  # solar court
            if room_type in {"living", "dining"}:
                vec[base + 1] = _clamp(0.65 + 0.35 * rng.random(), 0.0, 1.0)
            else:
                vec[base + 1] = _clamp(0.2 + 0.55 * rng.random(), 0.0, 1.0)

        elif island_id == 1:  # breeze bar
            col = rng.choice([0.15, 0.5, 0.82])
            vec[base] = _clamp(col + rng.uniform(-0.08, 0.08), 0.0, 1.0)
            vec[base + 1] = _clamp(rng.random(), 0.0, 1.0)

        elif island_id == 2:  # compact core
            qx = rng.choice([0.2, 0.65])
            qy = rng.choice([0.2, 0.65])
            vec[base] = _clamp(qx + rng.uniform(-0.1, 0.1), 0.0, 1.0)
            vec[base + 1] = _clamp(qy + rng.uniform(-0.1, 0.1), 0.0, 1.0)
            vec[base + 2] = _clamp(0.45 + 0.2 * rng.random(), 0.0, 1.0)
            vec[base + 3] = _clamp(0.45 + 0.2 * rng.random(), 0.0, 1.0)

        elif island_id == 3:  # split privacy
            if room_type in {"living", "dining", "kitchen"}:
                vec[base + 1] = _clamp(0.05 + 0.35 * rng.random(), 0.0, 1.0)
            else:
                vec[base + 1] = _clamp(0.55 + 0.4 * rng.random(), 0.0, 1.0)

        elif island_id == 4:  # L-courtyard
            x = rng.random()
            y = rng.random()
            if x > 0.68 and y > 0.68:
                if rng.random() < 0.5:
                    x *= 0.6
                else:
                    y *= 0.6
            vec[base] = _clamp(x, 0.0, 1.0)
            vec[base + 1] = _clamp(y, 0.0, 1.0)

    return vec


def init_island(island_id: int, pop_size: int, env: Dict[str, Any]) -> List[Chromosome]:
    env_n = _normalize_env(env)
    rng = random.Random(1000 + island_id)
    out: List[Chromosome] = []
    for _ in range(pop_size):
        vec = _topology_seed_vector(island_id, env_n, rng)
        chrom = _vector_to_chromosome(vec, env_n, "Island-GA", strict=True)
        out.append(chrom)
    return out


def migrate(islands: List[List[Dict[str, Any]]], rate: float) -> List[List[Dict[str, Any]]]:
    if not islands:
        return islands

    n = len(islands)
    migrants_per_island = [max(1, int(len(pop) * rate)) for pop in islands]
    migrants: List[List[Dict[str, Any]]] = []

    for i, pop in enumerate(islands):
        ranked = sorted(pop, key=lambda ind: ind["eco"], reverse=True)
        k = min(migrants_per_island[i], len(ranked))
        migrants.append([ranked[j] for j in range(k)])

    for i in range(n):
        dst = (i + 1) % n
        dst_ranked = sorted(islands[dst], key=lambda ind: ind["eco"])
        k = min(len(dst_ranked), len(migrants[i]))
        for j in range(k):
            replace_target = dst_ranked[j]
            islands[dst].remove(replace_target)
            islands[dst].append(migrants[i][j])

    return islands


def run_island_ga(env: Dict[str, Any], seed: int) -> Chromosome:
    env_n = _normalize_env(env)
    rng = random.Random(seed)
    stop_event = threading.Event()
    started_at = time.perf_counter()
    deadline = started_at + 7.5

    island_count = 5
    pop_size = 20
    generations = 80
    migration_interval = 20
    migration_rate = 0.15
    crossover_rate = 0.85
    mutation_rate = 0.10

    islands: List[List[Dict[str, Any]]] = []
    for i in range(island_count):
        island_pop = []
        for _ in range(pop_size):
            vec = _topology_seed_vector(i, env_n, rng)
            island_pop.append(_evaluate_vector(vec, env_n, "Island-GA", strict=False))
        islands.append(island_pop)

    convergence: List[float] = []
    best_ind = max((ind for pop in islands for ind in pop), key=lambda ind: ind["eco"])
    best_eco = best_ind["eco"]
    stagnation = 0
    generations_run = 0
    converged_early = False

    for gen in range(generations):
        if _timed_out(stop_event, deadline):
            break

        new_islands: List[List[Dict[str, Any]]] = []
        for island_id, pop in enumerate(islands):
            ranked = sorted(pop, key=lambda ind: ind["eco"], reverse=True)
            elite_count = 2
            next_pop = ranked[:elite_count]

            while len(next_pop) < pop_size:
                if _timed_out(stop_event, deadline):
                    break

                p1 = rng.choice(ranked[: max(4, pop_size // 2)])
                p2 = rng.choice(ranked[: max(4, pop_size // 2)])

                if rng.random() < crossover_rate:
                    child_vec = [p1["vector"][d] if rng.random() < 0.5 else p2["vector"][d] for d in range(len(p1["vector"]))]
                else:
                    child_vec = list(p1["vector"])

                for d in range(len(child_vec)):
                    if rng.random() < mutation_rate:
                        child_vec[d] = _clamp(child_vec[d] + rng.uniform(-0.12, 0.12), 0.0, 1.0)

                if island_id == 4:
                    # L-shape mask: avoid the top-right corner of normalized space.
                    for ridx in range(len(env_n["room_program"])):
                        gx = ridx * 4
                        if child_vec[gx] > 0.68 and child_vec[gx + 1] > 0.68:
                            if rng.random() < 0.5:
                                child_vec[gx] *= 0.6
                            else:
                                child_vec[gx + 1] *= 0.6

                next_pop.append(_evaluate_vector(child_vec, env_n, "Island-GA", strict=False))

            new_islands.append(next_pop)

        islands = new_islands

        if (gen + 1) % migration_interval == 0:
            islands = migrate(islands, migration_rate)

        gen_best = max((ind for pop in islands for ind in pop), key=lambda ind: ind["eco"])
        convergence.append(gen_best["eco"])
        generations_run = gen + 1

        if gen_best["eco"] > best_eco + 0.001:
            best_eco = gen_best["eco"]
            best_ind = gen_best
            stagnation = 0
        else:
            stagnation += 1

        if stagnation >= 20:
            converged_early = True
            break

    return _finalize_result(
        best_ind,
        env_n,
        "Island-GA",
        convergence,
        generations_run,
        converged_early,
        started_at,
    )


def _identity_matrix(n: int) -> List[List[float]]:
    return [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]


def _cholesky(matrix: List[List[float]]) -> List[List[float]]:
    n = len(matrix)
    L = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = sum(L[i][k] * L[j][k] for k in range(j))
            if i == j:
                val = matrix[i][i] - s
                if val <= 1e-12:
                    val = 1e-12
                L[i][j] = math.sqrt(val)
            else:
                if abs(L[j][j]) <= 1e-12:
                    L[i][j] = 0.0
                else:
                    L[i][j] = (matrix[i][j] - s) / L[j][j]
    return L


def _mat_vec_mul(matrix: List[List[float]], vector: List[float]) -> List[float]:
    return [sum(row[j] * vector[j] for j in range(len(vector))) for row in matrix]


def _vec_add(a: List[float], b: List[float]) -> List[float]:
    return [x + y for x, y in zip(a, b)]


def _vec_sub(a: List[float], b: List[float]) -> List[float]:
    return [x - y for x, y in zip(a, b)]


def _vec_scale(a: List[float], scalar: float) -> List[float]:
    return [x * scalar for x in a]


def _vec_norm(a: List[float]) -> float:
    return math.sqrt(sum(x * x for x in a))


def _outer(a: List[float], b: List[float]) -> List[List[float]]:
    n = len(a)
    return [[a[i] * b[j] for j in range(n)] for i in range(n)]


def _matrix_add(a: List[List[float]], b: List[List[float]]) -> List[List[float]]:
    return [[a[i][j] + b[i][j] for j in range(len(a))] for i in range(len(a))]


def _matrix_scale(a: List[List[float]], s: float) -> List[List[float]]:
    return [[v * s for v in row] for row in a]


def _solve_lower_triangular(L: List[List[float]], b: List[float]) -> List[float]:
    n = len(L)
    y = [0.0] * n
    for i in range(n):
        s = sum(L[i][j] * y[j] for j in range(i))
        denom = L[i][i] if abs(L[i][i]) > 1e-12 else 1e-12
        y[i] = (b[i] - s) / denom
    return y


def _has_polygon_violation(rooms: List[Room], env: Dict[str, Any]) -> bool:
    polygon = env.get("plot_polygon", [])
    if not polygon:
        return False
    return any(not _room_inside_polygon(room, polygon) for room in rooms)


def sample_multivariate_normal(
    mean: List[float],
    C: List[List[float]],
    sigma: float,
    n: int,
    rng: Optional[random.Random] = None,
) -> List[float]:
    rng = rng or random
    L = _cholesky(C)
    z = [rng.gauss(0.0, 1.0) for _ in range(n)]
    y = _mat_vec_mul(L, z)
    return [mean[i] + sigma * y[i] for i in range(n)]


def update_cma_parameters(
    mean: List[float],
    C: List[List[float]],
    sigma: float,
    ps: List[float],
    pc: List[float],
    selected: List[List[float]],
    weights: List[float],
    mueff: float,
    cc: float,
    cs: float,
    c1: float,
    cmu: float,
    damps: float,
    n: int,
) -> Tuple[List[float], List[List[float]], float, List[float], List[float]]:
    old_mean = list(mean)
    mean_new = [sum(weights[i] * selected[i][d] for i in range(len(selected))) for d in range(n)]

    y_w = _vec_scale(_vec_sub(mean_new, old_mean), 1.0 / max(sigma, 1e-12))

    L = _cholesky(C)
    inv_sqrt_y = _solve_lower_triangular(L, y_w)
    ps_new = _vec_add(_vec_scale(ps, 1.0 - cs), _vec_scale(inv_sqrt_y, math.sqrt(cs * (2.0 - cs) * mueff)))

    chi_n = math.sqrt(n) * (1.0 - 1.0 / (4.0 * n) + 1.0 / (21.0 * n * n))
    norm_ps = _vec_norm(ps_new)
    hsig = 1.0 if norm_ps / max(chi_n, 1e-12) < (1.4 + 2.0 / (n + 1.0)) else 0.0

    pc_new = _vec_add(_vec_scale(pc, 1.0 - cc), _vec_scale(y_w, hsig * math.sqrt(cc * (2.0 - cc) * mueff)))

    rank_one = _outer(pc_new, pc_new)

    rank_mu = [[0.0] * n for _ in range(n)]
    for i, x in enumerate(selected):
        y_i = _vec_scale(_vec_sub(x, old_mean), 1.0 / max(sigma, 1e-12))
        outer_i = _outer(y_i, y_i)
        rank_mu = _matrix_add(rank_mu, _matrix_scale(outer_i, weights[i]))

    c_scale = 1.0 - c1 - cmu + (1.0 - hsig) * c1 * cc * (2.0 - cc)
    C_new = _matrix_add(
        _matrix_add(_matrix_scale(C, c_scale), _matrix_scale(rank_one, c1)),
        _matrix_scale(rank_mu, cmu),
    )

    # keep covariance symmetric and numerically stable
    for i in range(n):
        for j in range(i + 1, n):
            v = 0.5 * (C_new[i][j] + C_new[j][i])
            C_new[i][j] = v
            C_new[j][i] = v
        C_new[i][i] = max(C_new[i][i], 1e-10)

    sigma_new = sigma * math.exp((cs / max(damps, 1e-12)) * (norm_ps / max(chi_n, 1e-12) - 1.0))
    sigma_new = _clamp(sigma_new, 1e-4, 2.5)

    return mean_new, C_new, sigma_new, ps_new, pc_new


def run_cma_es(env: Dict[str, Any], seed: int) -> Chromosome:
    env_n = _normalize_env(env)
    rng = random.Random(seed)
    stop_event = threading.Event()
    started_at = time.perf_counter()
    deadline = started_at + 7.5

    n = len(env_n["room_program"]) * 4 + 1
    lambda_ = 4 + int(math.floor(3.0 * math.log(n)))
    mu = max(2, lambda_ // 2)
    sigma = 0.3
    max_generations = 200

    weights = [math.log(mu + 0.5) - math.log(i) for i in range(1, mu + 1)]
    w_sum = sum(weights) or 1.0
    weights = [w / w_sum for w in weights]
    mueff = 1.0 / max(sum(w * w for w in weights), 1e-12)

    cc = (4.0 + mueff / n) / (n + 4.0 + 2.0 * mueff / n)
    cs = (mueff + 2.0) / (n + mueff + 5.0)
    c1 = 2.0 / (((n + 1.3) ** 2) + mueff)
    cmu = min(1.0 - c1, 2.0 * (mueff - 2.0 + 1.0 / mueff) / (((n + 2.0) ** 2) + mueff))
    damps = 1.0 + 2.0 * max(0.0, math.sqrt((mueff - 1.0) / (n + 1.0)) - 1.0) + cs

    mean = [0.5 for _ in range(n)]
    C = _identity_matrix(n)
    ps = [0.0 for _ in range(n)]
    pc = [0.0 for _ in range(n)]

    convergence: List[float] = []
    best_ind: Optional[Dict[str, Any]] = None
    best_eco = -1.0
    stagnation = 0
    generations_run = 0
    converged_early = False

    for gen in range(max_generations):
        if _timed_out(stop_event, deadline):
            break

        sampled: List[Dict[str, Any]] = []
        for _ in range(lambda_):
            if _timed_out(stop_event, deadline):
                break
            x = sample_multivariate_normal(mean, C, sigma, n, rng=rng)
            x = [_clamp(v, 0.0, 1.0) for v in x]
            evaluated = _evaluate_vector(x, env_n, "CMA-ES", strict=False)
            penalty = -1000.0 if _has_polygon_violation(evaluated["chromosome"].rooms, env_n) else 0.0
            score = evaluated["eco"] + penalty
            sampled.append({"vector": x, "evaluated": evaluated, "score": score})

        if not sampled:
            break

        sampled.sort(key=lambda item: item["score"], reverse=True)

        selected_vectors = [sampled[i]["vector"] for i in range(min(mu, len(sampled)))]
        if len(selected_vectors) < mu:
            selected_vectors.extend([selected_vectors[-1]] * (mu - len(selected_vectors)))

        mean, C, sigma, ps, pc = update_cma_parameters(
            mean,
            C,
            sigma,
            ps,
            pc,
            selected_vectors,
            weights,
            mueff,
            cc,
            cs,
            c1,
            cmu,
            damps,
            n,
        )

        gen_best = max(sampled, key=lambda item: item["evaluated"]["eco"])
        gen_eco = gen_best["evaluated"]["eco"]
        convergence.append(gen_eco)
        generations_run = gen + 1

        if gen_eco > best_eco + 0.001:
            best_eco = gen_eco
            best_ind = gen_best["evaluated"]
            stagnation = 0
        else:
            stagnation += 1

        if stagnation >= 20:
            converged_early = True
            break

    if best_ind is None:
        best_ind = _evaluate_vector(mean, env_n, "CMA-ES", strict=False)

    return _finalize_result(
        best_ind,
        env_n,
        "CMA-ES",
        convergence,
        generations_run,
        converged_early,
        started_at,
    )


def _fallback_seed_vector(env: Dict[str, Any], algo_name: str) -> List[float]:
    env_n = _normalize_env(env)
    rng = random.Random(sum(ord(c) for c in algo_name) + 2026)

    if algo_name == "Island-GA":
        return _topology_seed_vector(4, env_n, rng)
    if algo_name == "MOEA-D":
        return _topology_seed_vector(1, env_n, rng)
    if algo_name == "NSGA-III":
        return _topology_seed_vector(0, env_n, rng)
    if algo_name == "SHADE":
        return _topology_seed_vector(2, env_n, rng)
    return _topology_seed_vector(3, env_n, rng)


def make_fallback_chromosome(env: Dict[str, Any], algo_name: str) -> Chromosome:
    env_n = _normalize_env(env)
    vec = _fallback_seed_vector(env_n, algo_name)
    chrom = _vector_to_chromosome(vec, env_n, algo_name, strict=True)
    chrom.convergence_curve = [chrom.fitness["eco_score"]]
    chrom.generations_run = 1
    chrom.converged_early = True
    chrom.runtime_ms = 0
    return chrom


def run_all_algorithms(env: Dict[str, Any]) -> List[Chromosome]:
    env_n = _normalize_env(env)

    runners = [
        ("NSGA-III", run_nsga3, 42),
        ("MOEA-D", run_moead, 137),
        ("SHADE", run_shade, 271),
        ("Island-GA", run_island_ga, 314),
        ("CMA-ES", run_cma_es, 999),
    ]

    results: List[Chromosome] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(fn, env_n, seed): algo_name
            for algo_name, fn, seed in runners
        }
        for future in concurrent.futures.as_completed(futures):
            algo_name = futures[future]
            try:
                result = future.result(timeout=8.0)
            except Exception:
                result = make_fallback_chromosome(env_n, algo_name)
            results.append(result)

    existing = {item.algorithm for item in results}
    for algo_name, _, _ in runners:
        if algo_name not in existing:
            results.append(make_fallback_chromosome(env_n, algo_name))

    results.sort(key=lambda chrom: chrom.fitness["eco_score"], reverse=True)
    return results[:5]
