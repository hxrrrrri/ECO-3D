from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

from .eco_validator import CriterionResult
from .ga_engine import Chromosome, Room

HABITABLE_TYPES = {"living", "dining", "bedroom", "office"}
SERVICE_TYPES = {"kitchen", "bathroom", "utility", "garage", "storage"}
WET_TYPES = {"kitchen", "bathroom", "utility"}

COMPASS_BEARINGS: Dict[str, float] = {
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

EDGE_TO_CARDINAL = {
    "top": "N",
    "bottom": "S",
    "left": "W",
    "right": "E",
}
CARDINAL_TO_EDGE = {
    "N": "top",
    "S": "bottom",
    "E": "right",
    "W": "left",
}
OPPOSITE_EDGE = {
    "top": "bottom",
    "bottom": "top",
    "left": "right",
    "right": "left",
}


@dataclass
class RoomMutation:
    room_id: str
    mutation_type: str
    old_value: dict
    new_value: dict
    criterion_id: int
    reason: str
    confidence: float


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return float(default)
        return float(value)
    except Exception:
        return float(default)


def _value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _room_id(room: Room, fallback_index: int) -> str:
    rid = str(getattr(room, "id", "") or "").strip()
    return rid if rid else f"room_{fallback_index + 1}"


def _room_type(room: Room) -> str:
    return str(getattr(room, "type", "") or "").strip().lower()


def _bounds(rooms: Sequence[Room]) -> Tuple[float, float, float, float]:
    if not rooms:
        return (0.0, 0.0, 0.0, 0.0)
    min_x = min(r.x for r in rooms)
    min_y = min(r.y for r in rooms)
    max_x = max(r.x + r.width for r in rooms)
    max_y = max(r.y + r.height for r in rooms)
    return (min_x, min_y, max_x, max_y)


def _center(room: Room) -> Tuple[float, float]:
    return (room.x + room.width * 0.5, room.y + room.height * 0.5)


def _distance(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _angle_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _orientation_bearing(room: Room) -> float:
    ori = str(getattr(room, "orientation", "S") or "S").upper()
    return COMPASS_BEARINGS.get(ori, 180.0)


def _bearing_to_cardinal(bearing: float) -> str:
    candidates = {"N": 0.0, "E": 90.0, "S": 180.0, "W": 270.0}
    best = "N"
    best_diff = 9999.0
    for name, value in candidates.items():
        diff = _angle_diff(value, bearing)
        if diff < best_diff:
            best_diff = diff
            best = name
    return best


def _bearing_to_octant(bearing: float) -> str:
    octants = [
        "N",
        "NE",
        "E",
        "SE",
        "S",
        "SW",
        "W",
        "NW",
    ]
    idx = int(((bearing % 360.0) + 22.5) // 45.0) % 8
    return octants[idx]


def _windward_edge(env: dict) -> str:
    wd = str(env.get("wind_direction", "SW") or "SW").upper()
    bearing = COMPASS_BEARINGS.get(wd, 225.0)
    return CARDINAL_TO_EDGE[_bearing_to_cardinal(bearing)]


def _leeward_edge(env: dict) -> str:
    return OPPOSITE_EDGE[_windward_edge(env)]


def _solar_face_edge(env: dict) -> str:
    lat = _safe_float(env.get("lat"), 0.0)
    return "bottom" if lat >= 0 else "top"


def _climate(env: dict) -> str:
    solar = _safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0)
    if solar > 5.5:
        return "hot"
    if solar < 3.5:
        return "cold"
    return "temperate"


def _sub_score(audit_result: CriterionResult, key: str, default: float = 100.0) -> float:
    sub = getattr(audit_result, "sub_scores", {}) or {}
    if key in sub:
        return _safe_float(sub.get(key), default)
    upper = key.upper()
    if upper in sub:
        return _safe_float(sub.get(upper), default)
    lower = key.lower()
    if lower in sub:
        return _safe_float(sub.get(lower), default)
    return default


def _findings_text(audit_result: CriterionResult) -> str:
    findings = getattr(audit_result, "findings", []) or []
    return " ".join(str(item).lower() for item in findings)


def _has_finding(audit_result: CriterionResult, *terms: str) -> bool:
    text = _findings_text(audit_result)
    return any(term.lower() in text for term in terms)


def _room_touches_edge(room: Room, bounds: Tuple[float, float, float, float], edge: str, tol: float = 0.35) -> bool:
    min_x, min_y, max_x, max_y = bounds
    if edge == "top":
        return room.y <= min_y + tol
    if edge == "bottom":
        return room.y + room.height >= max_y - tol
    if edge == "left":
        return room.x <= min_x + tol
    if edge == "right":
        return room.x + room.width >= max_x - tol
    return False


def _move_toward_edge(room: Room, bounds: Tuple[float, float, float, float], edge: str, distance: float) -> Tuple[float, float]:
    min_x, min_y, max_x, max_y = bounds
    step = max(0.0, min(2.0, distance))

    nx, ny = room.x, room.y
    if edge == "top":
        gap = max(0.0, room.y - min_y)
        ny = room.y - min(step, gap)
    elif edge == "bottom":
        gap = max(0.0, max_y - (room.y + room.height))
        ny = room.y + min(step, gap)
    elif edge == "left":
        gap = max(0.0, room.x - min_x)
        nx = room.x - min(step, gap)
    elif edge == "right":
        gap = max(0.0, max_x - (room.x + room.width))
        nx = room.x + min(step, gap)

    return (round(nx, 3), round(ny, 3))


def _parse_window_wall(wall_id: str) -> Tuple[str, str]:
    text = str(wall_id or "")
    parts = text.split("_") if text else []
    if not parts:
        return ("", "")

    if parts[-1] == "vent" and len(parts) >= 2:
        room_id = "_".join(parts[:-2])
        raw_edge = parts[-2].lower()
    else:
        room_id = "_".join(parts[:-1])
        raw_edge = parts[-1].lower()

    if raw_edge in {"north", "n"}:
        edge = "top"
    elif raw_edge in {"south", "s"}:
        edge = "bottom"
    elif raw_edge in {"west", "w"}:
        edge = "left"
    elif raw_edge in {"east", "e"}:
        edge = "right"
    elif raw_edge in {"top", "bottom", "left", "right"}:
        edge = raw_edge
    else:
        edge = ""

    return (room_id, edge)


def _windows_by_room(chromosome: Chromosome) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for w in list(getattr(chromosome, "windows", []) or []):
        wall = _value(w, "wall", "")
        room_id, edge = _parse_window_wall(str(wall))
        if not room_id:
            continue
        rec = {
            "edge": edge,
            "width": _safe_float(_value(w, "width", 1.0), 1.0),
            "sill_height": _safe_float(_value(w, "sill_height", 0.9), 0.9),
            "head_height": _safe_float(_value(w, "head_height", 2.1), 2.1),
        }
        out.setdefault(room_id, []).append(rec)
    return out


def _window_faces(room_id: str, windows_by_room: Dict[str, List[Dict[str, Any]]]) -> List[str]:
    return [w.get("edge", "") for w in windows_by_room.get(room_id, []) if w.get("edge")]


def _room_window_area(room_id: str, windows_by_room: Dict[str, List[Dict[str, Any]]]) -> float:
    total = 0.0
    for w in windows_by_room.get(room_id, []):
        width = _safe_float(w.get("width"), 0.0)
        sill = _safe_float(w.get("sill_height"), 0.9)
        head = _safe_float(w.get("head_height"), 2.1)
        total += max(0.0, width * max(0.0, head - sill))
    return total


def _rooms_adjacent(a: Room, b: Room, tol: float = 0.12) -> bool:
    overlap_x = max(0.0, min(a.x + a.width, b.x + b.width) - max(a.x, b.x))
    overlap_y = max(0.0, min(a.y + a.height, b.y + b.height) - max(a.y, b.y))

    vertical_touch = (abs((a.x + a.width) - b.x) <= tol or abs((b.x + b.width) - a.x) <= tol) and overlap_y > 0.15
    horizontal_touch = (abs((a.y + a.height) - b.y) <= tol or abs((b.y + b.height) - a.y) <= tol) and overlap_x > 0.15
    return vertical_touch or horizontal_touch


def _boundary_adjacent(room: Room, bounds: Tuple[float, float, float, float], tol: float = 0.35) -> bool:
    return any(_room_touches_edge(room, bounds, edge, tol=tol) for edge in ("top", "bottom", "left", "right"))


def _collect_tree_points(env: dict, bounds: Tuple[float, float, float, float]) -> List[Dict[str, float]]:
    trees = env.get("tree_coordinates") if isinstance(env.get("tree_coordinates"), list) else []
    if not trees:
        return []

    points: List[Dict[str, float]] = []
    min_x, min_y, max_x, max_y = bounds

    latlon = [t for t in trees if isinstance(t, dict) and "lat" in t and "lon" in t]
    has_xy = any(isinstance(t, dict) and "x" in t and "y" in t for t in trees)

    if has_xy:
        for t in trees:
            if not isinstance(t, dict) or "x" not in t or "y" not in t:
                continue
            points.append(
                {
                    "x": _safe_float(t.get("x"), min_x),
                    "y": _safe_float(t.get("y"), min_y),
                    "radius_m": max(0.8, _safe_float(t.get("radius_m", 1.8), 1.8)),
                    "confidence": _safe_float(t.get("confidence", 0.8), 0.8),
                }
            )
        return points

    if latlon:
        lats = [_safe_float(t.get("lat"), 0.0) for t in latlon]
        lons = [_safe_float(t.get("lon"), 0.0) for t in latlon]
        lat_min, lat_max = min(lats), max(lats)
        lon_min, lon_max = min(lons), max(lons)
        lat_span = max(1e-6, lat_max - lat_min)
        lon_span = max(1e-6, lon_max - lon_min)

        for t in latlon:
            tx = min_x + ((_safe_float(t.get("lon"), lon_min) - lon_min) / lon_span) * max(1e-6, (max_x - min_x))
            ty = max_y - ((_safe_float(t.get("lat"), lat_min) - lat_min) / lat_span) * max(1e-6, (max_y - min_y))
            points.append(
                {
                    "x": tx,
                    "y": ty,
                    "radius_m": max(0.8, _safe_float(t.get("radius_m", 1.8), 1.8)),
                    "confidence": _safe_float(t.get("confidence", 0.8), 0.8),
                }
            )

    return points


def _room_circle_overlap(room: Room, cx: float, cy: float, radius: float) -> bool:
    nx = min(max(cx, room.x), room.x + room.width)
    ny = min(max(cy, room.y), room.y + room.height)
    return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius ** 2


def _midpoint(bounds: Tuple[float, float, float, float]) -> Tuple[float, float]:
    min_x, min_y, max_x, max_y = bounds
    return ((min_x + max_x) * 0.5, (min_y + max_y) * 0.5)


def _annotation_mutation(
    room_id: str,
    criterion_id: int,
    reason: str,
    confidence: float,
    annotations: Dict[str, Any],
    room: Room,
) -> RoomMutation:
    return RoomMutation(
        room_id=room_id,
        mutation_type="move",
        old_value={"x": room.x, "y": room.y},
        new_value={"x": room.x, "y": room.y, "_annotations": annotations},
        criterion_id=criterion_id,
        reason=reason,
        confidence=confidence,
    )


# ---------------------------------------------------------------------------
# Strategy 1: Passive Solar Orientation
# ---------------------------------------------------------------------------

def correct_criterion_1(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(65.0, _safe_float(getattr(audit_result, "pass_threshold", 65.0), 65.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "alignment", "axis")
    fail_b = sub_b < threshold or _has_finding(audit_result, "orientation compliance", "habitable")
    fail_c = sub_c < threshold or _has_finding(audit_result, "glazing", "facade")

    bounds = _bounds(rooms)
    min_x, min_y, max_x, max_y = bounds
    climate = _climate(env)
    solar_bearing = 180.0 if _safe_float(env.get("lat"), 0.0) >= 0 else 0.0
    target_bearing = (solar_bearing + 180.0) % 360.0 if climate == "hot" else solar_bearing

    mutations: List[RoomMutation] = []

    if fail_a:
        axis_bearing = 90.0 if (max_x - min_x) >= (max_y - min_y) else 0.0
        delta = ((target_bearing - axis_bearing + 540.0) % 360.0) - 180.0
        if abs(delta) > 1.0:
            anchor = _room_id(rooms[0], 0)
            mutations.append(
                RoomMutation(
                    room_id=anchor,
                    mutation_type="reorient",
                    old_value={"orientation_delta_deg": 0.0},
                    new_value={"orientation_delta_deg": round(delta, 2), "all_rooms": True},
                    criterion_id=1,
                    reason="Rotate plan axis toward climate-correct solar-noon alignment.",
                    confidence=0.92,
                )
            )

    if fail_b:
        solar_face = _solar_face_edge(env)
        for idx, room in enumerate(rooms):
            rtype = _room_type(room)
            if rtype not in HABITABLE_TYPES:
                continue
            bearing = _orientation_bearing(room)
            if _angle_diff(bearing, target_bearing) <= 45.0:
                continue
            nx, ny = _move_toward_edge(room, bounds, solar_face, 2.0)
            if abs(nx - room.x) < 1e-6 and abs(ny - room.y) < 1e-6:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="move",
                    old_value={"x": room.x, "y": room.y},
                    new_value={"x": nx, "y": ny},
                    criterion_id=1,
                    reason="Move habitable room toward solar face to improve passive gain compliance.",
                    confidence=0.84,
                )
            )

    windows_by_room = _windows_by_room(chromosome)
    if fail_c:
        solar_face = _solar_face_edge(env)
        non_solar_face = OPPOSITE_EDGE[solar_face]
        for idx, room in enumerate(rooms):
            rid = _room_id(room, idx)
            faces = _window_faces(rid, windows_by_room)
            touches_solar = _room_touches_edge(room, bounds, solar_face)
            if touches_solar and solar_face not in faces:
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="add_window",
                        old_value={"wall_face": solar_face},
                        new_value={
                            "wall_face": solar_face,
                            "width": 1.2,
                            "sill_height": 0.9,
                            "head_height": 2.1,
                        },
                        criterion_id=1,
                        reason="Add glazing on solar-facing facade where insufficient window area was detected.",
                        confidence=0.9,
                    )
                )
            if climate == "hot" and non_solar_face in faces and faces.count(non_solar_face) > 1:
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="remove_window",
                        old_value={"wall_face": non_solar_face},
                        new_value={"wall_face": non_solar_face},
                        criterion_id=1,
                        reason="Reduce excess non-solar glazing on hot-climate facade to limit overheating.",
                        confidence=0.76,
                    )
                )

    if climate == "hot":
        east_target = max(min_x + 0.2, ((min_x + max_x) * 0.5) + 0.2)
        for idx, room in enumerate(rooms):
            if _room_type(room) != "bedroom":
                continue
            if _angle_diff(_orientation_bearing(room), 270.0) > 45.0:
                continue
            nx = min(max_x - room.width - 0.2, east_target)
            if nx > room.x + 0.05:
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, idx),
                        mutation_type="move",
                        old_value={"x": room.x, "y": room.y},
                        new_value={"x": round(nx, 3), "y": round(room.y, 3)},
                        criterion_id=1,
                        reason="Relocate west-facing bedroom toward cooler east-half zone in hot climate.",
                        confidence=0.88,
                    )
                )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 2: Natural Cross-Ventilation
# ---------------------------------------------------------------------------

def correct_criterion_2(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(60.0, _safe_float(getattr(audit_result, "pass_threshold", 60.0), 60.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "cross", "perpendicular")
    fail_b = sub_b < threshold or _has_finding(audit_result, "windward")
    fail_c = sub_c < threshold or _has_finding(audit_result, "high", "leeward")

    bounds = _bounds(rooms)
    windward = _windward_edge(env)
    leeward = _leeward_edge(env)
    windows_by_room = _windows_by_room(chromosome)

    mutations: List[RoomMutation] = []

    for idx, room in enumerate(rooms):
        rtype = _room_type(room)
        if rtype not in HABITABLE_TYPES:
            continue
        rid = _room_id(room, idx)
        faces = _window_faces(rid, windows_by_room)

        if fail_a and len(set(faces)) <= 1:
            base_face = faces[0] if faces else windward
            opposite = OPPOSITE_EDGE.get(base_face, leeward)
            mutations.append(
                RoomMutation(
                    room_id=rid,
                    mutation_type="add_window",
                    old_value={"wall_face": opposite},
                    new_value={
                        "wall_face": opposite,
                        "width": 1.2,
                        "sill_height": 0.9,
                        "head_height": 2.1,
                    },
                    criterion_id=2,
                    reason="Add opposite-face opening to establish cross-ventilation path.",
                    confidence=0.86,
                )
            )

        if fail_b and windward not in faces:
            mutations.append(
                RoomMutation(
                    room_id=rid,
                    mutation_type="add_window",
                    old_value={"wall_face": windward},
                    new_value={
                        "wall_face": windward,
                        "width": 1.2,
                        "sill_height": 0.9,
                        "head_height": 2.1,
                    },
                    criterion_id=2,
                    reason="Introduce windward intake opening where missing.",
                    confidence=0.88,
                )
            )
            if not _room_touches_edge(room, bounds, windward):
                nx, ny = _move_toward_edge(room, bounds, windward, 1.5)
                if abs(nx - room.x) > 1e-6 or abs(ny - room.y) > 1e-6:
                    mutations.append(
                        RoomMutation(
                            room_id=rid,
                            mutation_type="move",
                            old_value={"x": room.x, "y": room.y},
                            new_value={"x": nx, "y": ny},
                            criterion_id=2,
                            reason="Shift room to gain windward exterior wall access.",
                            confidence=0.72,
                        )
                    )

        if fail_c:
            has_high_vent = False
            for w in windows_by_room.get(rid, []):
                if w.get("edge") == leeward and _safe_float(w.get("sill_height"), 0.0) >= 1.8:
                    has_high_vent = True
                    break
            if not has_high_vent:
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="add_window",
                        old_value={"wall_face": leeward},
                        new_value={
                            "wall_face": leeward,
                            "width": 0.6,
                            "sill_height": 1.8,
                            "head_height": 2.2,
                        },
                        criterion_id=2,
                        reason="Add high-level leeward exhaust vent for stack-assisted air purge.",
                        confidence=0.8,
                    )
                )

    wind_speed = _safe_float(env.get("wind_speed_ms"), 0.0)
    if wind_speed > 6.0:
        windbreak = next((r for r in rooms if _room_type(r) in {"utility", "garage"}), None)
        if windbreak is not None and not _room_touches_edge(windbreak, bounds, windward):
            nx, ny = _move_toward_edge(windbreak, bounds, windward, 2.0)
            mutations.append(
                RoomMutation(
                    room_id=str(windbreak.id),
                    mutation_type="move",
                    old_value={"x": windbreak.x, "y": windbreak.y},
                    new_value={"x": nx, "y": ny},
                    criterion_id=2,
                    reason="Relocate service volume to windward edge as a protective windbreak.",
                    confidence=0.75,
                )
            )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 3: Building Compactness
# ---------------------------------------------------------------------------

def correct_criterion_3(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(55.0, _safe_float(getattr(audit_result, "pass_threshold", 55.0), 55.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "compactness")
    fail_b = sub_b < threshold or _has_finding(audit_result, "corner", "stub")
    fail_c = sub_c < threshold or _has_finding(audit_result, "utilization", "ratio")

    bounds = _bounds(rooms)
    min_x, min_y, max_x, max_y = bounds
    cx, cy = _midpoint(bounds)

    mutations: List[RoomMutation] = []

    if fail_a:
        by_distance = sorted(rooms, key=lambda r: _distance(_center(r), (cx, cy)), reverse=True)
        for idx, room in enumerate(by_distance[: max(2, len(by_distance) // 3)]):
            rcx, rcy = _center(room)
            vx = cx - rcx
            vy = cy - rcy
            length = max(1e-6, math.hypot(vx, vy))
            nx = room.x + 1.5 * (vx / length)
            ny = room.y + 1.5 * (vy / length)
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="move",
                    old_value={"x": room.x, "y": room.y},
                    new_value={"x": round(nx, 3), "y": round(ny, 3)},
                    criterion_id=3,
                    reason="Pull outlier room inward toward centroid to improve compactness ratio.",
                    confidence=0.8,
                )
            )

    if fail_b:
        inner_min_x = min_x + 0.1 * (max_x - min_x)
        inner_max_x = max_x - 0.1 * (max_x - min_x)
        inner_min_y = min_y + 0.1 * (max_y - min_y)
        inner_max_y = max_y - 0.1 * (max_y - min_y)
        for idx, room in enumerate(rooms):
            if room.x >= inner_min_x and room.x + room.width <= inner_max_x and room.y >= inner_min_y and room.y + room.height <= inner_max_y:
                continue
            nx = min(max(room.x, inner_min_x), max(inner_min_x, inner_max_x - room.width))
            ny = min(max(room.y, inner_min_y), max(inner_min_y, inner_max_y - room.height))
            if abs(nx - room.x) < 1e-6 and abs(ny - room.y) < 1e-6:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="move",
                    old_value={"x": room.x, "y": room.y},
                    new_value={"x": round(nx, 3), "y": round(ny, 3)},
                    criterion_id=3,
                    reason="Re-seat stubbed room inside the main rectangle to reduce exterior corner count.",
                    confidence=0.72,
                )
            )

    if fail_c:
        floor_area = sum(room.width * room.height for room in rooms)
        footprint = max(1e-6, (max_x - min_x) * (max_y - min_y))
        ratio = floor_area / footprint
        habitable = [r for r in rooms if _room_type(r) in HABITABLE_TYPES]
        if ratio < 0.65:
            for idx, room in enumerate(habitable):
                axis = "width" if room.width < room.height else "height"
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, idx),
                        mutation_type="resize",
                        old_value={"width": room.width, "height": room.height},
                        new_value={"scale_factor": 1.05, "axis": axis},
                        criterion_id=3,
                        reason="Expand minor room dimension to recover under-utilized floor area.",
                        confidence=0.7,
                    )
                )
        elif ratio > 0.75:
            for idx, room in enumerate(habitable):
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, idx),
                        mutation_type="resize",
                        old_value={"width": room.width, "height": room.height},
                        new_value={"scale_factor": 0.97, "axis": "both"},
                        criterion_id=3,
                        reason="Slightly reduce room area to free circulation space in over-packed footprint.",
                        confidence=0.68,
                    )
                )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 4: Thermal Zoning
# ---------------------------------------------------------------------------

def correct_criterion_4(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(60.0, _safe_float(getattr(audit_result, "pass_threshold", 60.0), 60.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "service", "face")
    fail_b = sub_b < threshold or _has_finding(audit_result, "wet", "cluster")
    fail_c = sub_c < threshold or _has_finding(audit_result, "noise", "buffer")

    bounds = _bounds(rooms)
    min_x, min_y, max_x, max_y = bounds
    climate = _climate(env)
    leeward = _leeward_edge(env)

    mutations: List[RoomMutation] = []

    if fail_a:
        service_rooms = [r for r in rooms if _room_type(r) in SERVICE_TYPES]
        for idx, room in enumerate(service_rooms):
            rid = _room_id(room, idx)
            if climate == "cold":
                target_y = min_y
                if room.y > target_y + 0.01:
                    mutations.append(
                        RoomMutation(
                            room_id=rid,
                            mutation_type="move",
                            old_value={"x": room.x, "y": room.y},
                            new_value={"x": room.x, "y": round(target_y, 3)},
                            criterion_id=4,
                            reason="Place service room on north buffer edge for cold-climate thermal zoning.",
                            confidence=0.82,
                        )
                    )
            elif climate == "hot":
                target_x = max_x - room.width
                if abs(room.x - target_x) > 0.01:
                    mutations.append(
                        RoomMutation(
                            room_id=rid,
                            mutation_type="move",
                            old_value={"x": room.x, "y": room.y},
                            new_value={"x": round(target_x, 3), "y": room.y},
                            criterion_id=4,
                            reason="Shift service room to west thermal buffer in hot climate.",
                            confidence=0.82,
                        )
                    )
            else:
                nx, ny = _move_toward_edge(room, bounds, leeward, 2.0)
                if abs(nx - room.x) > 1e-6 or abs(ny - room.y) > 1e-6:
                    mutations.append(
                        RoomMutation(
                            room_id=rid,
                            mutation_type="move",
                            old_value={"x": room.x, "y": room.y},
                            new_value={"x": nx, "y": ny},
                            criterion_id=4,
                            reason="Move service room toward leeward side to reinforce thermal buffer zoning.",
                            confidence=0.76,
                        )
                    )

    if fail_b:
        wet_rooms = [r for r in rooms if _room_type(r) in WET_TYPES]
        if wet_rooms:
            wx = sum(_center(r)[0] for r in wet_rooms) / len(wet_rooms)
            wy = sum(_center(r)[1] for r in wet_rooms) / len(wet_rooms)
            for idx, room in enumerate(wet_rooms):
                cx, cy = _center(room)
                nx = room.x + 0.5 * (wx - cx) + idx * 0.12
                ny = room.y + 0.5 * (wy - cy) + idx * 0.12
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, idx),
                        mutation_type="move",
                        old_value={"x": room.x, "y": room.y},
                        new_value={"x": round(nx, 3), "y": round(ny, 3)},
                        criterion_id=4,
                        reason="Cluster wet rooms to shorten plumbing runs and improve service zoning.",
                        confidence=0.8,
                    )
                )

    if fail_c:
        bedrooms = [r for r in rooms if _room_type(r) == "bedroom"]
        noisy = [r for r in rooms if _room_type(r) in {"living", "kitchen"}]
        buffers = [r for r in rooms if _room_type(r) not in HABITABLE_TYPES]
        for b_idx, bedroom in enumerate(bedrooms):
            adjacent_noisy = any(_rooms_adjacent(bedroom, noisy_room) for noisy_room in noisy)
            if not adjacent_noisy:
                continue
            swap = None
            for buf in buffers:
                if _rooms_adjacent(bedroom, buf):
                    swap = buf
                    break
            if swap is None:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(bedroom, b_idx),
                    mutation_type="move",
                    old_value={"x": bedroom.x, "y": bedroom.y},
                    new_value={"x": round(swap.x, 3), "y": round(swap.y, 3)},
                    criterion_id=4,
                    reason="Swap bedroom away from noisy zone to create a service-room acoustic buffer.",
                    confidence=0.78,
                )
            )
            mutations.append(
                RoomMutation(
                    room_id=str(swap.id),
                    mutation_type="move",
                    old_value={"x": swap.x, "y": swap.y},
                    new_value={"x": round(bedroom.x, 3), "y": round(bedroom.y, 3)},
                    criterion_id=4,
                    reason="Complete bedroom-buffer swap for thermal/acoustic separation.",
                    confidence=0.78,
                )
            )

    bathrooms = [r for r in rooms if _room_type(r) == "bathroom"]
    dining_rooms = [r for r in rooms if _room_type(r) == "dining"]
    for idx, bath in enumerate(bathrooms):
        if not any(_rooms_adjacent(bath, d_room) for d_room in dining_rooms):
            continue
        nx = bath.x + min(1.5, max_x - (bath.x + bath.width))
        ny = bath.y + min(1.5, max_y - (bath.y + bath.height))
        if abs(nx - bath.x) < 0.05 and abs(ny - bath.y) < 0.05:
            nx = max(min_x, bath.x - 1.0)
        mutations.append(
            RoomMutation(
                room_id=_room_id(bath, idx),
                mutation_type="move",
                old_value={"x": bath.x, "y": bath.y},
                new_value={"x": round(nx, 3), "y": round(ny, 3)},
                criterion_id=4,
                reason="Move bathroom away from dining-room shared wall adjacency.",
                confidence=0.74,
            )
        )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 5: Flood Resilience
# ---------------------------------------------------------------------------

def correct_criterion_5(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    flood_probability = _safe_float(env.get("flood_probability"), 0.25)
    elevation = _safe_float(env.get("elevation"), 120.0)
    rainfall_mm = _safe_float(env.get("rainfall_mm"), 1200.0)

    mutations: List[RoomMutation] = []

    if flood_probability > 0.60:
        for idx, room in enumerate(rooms):
            if _room_type(room) not in HABITABLE_TYPES:
                continue
            if int(getattr(room, "floor", 1) or 1) > 1:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="elevate_floor",
                    old_value={"floor": int(room.floor)},
                    new_value={"floor": 2},
                    criterion_id=5,
                    reason=f"flood_probability={flood_probability:.2f} exceeds HIGH threshold 0.60",
                    confidence=0.96,
                )
            )

    elif 0.30 <= flood_probability <= 0.60:
        for idx, room in enumerate(rooms):
            if _room_type(room) != "bedroom":
                continue
            if int(getattr(room, "floor", 1) or 1) > 1:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="elevate_floor",
                    old_value={"floor": int(room.floor)},
                    new_value={"floor": 2},
                    criterion_id=5,
                    reason="Elevate bedrooms for moderate flood-risk scenario.",
                    confidence=0.9,
                )
            )
        anchor = rooms[0]
        mutations.append(
            _annotation_mutation(
                room_id=_room_id(anchor, 0),
                criterion_id=5,
                reason="Annotate plinth height of 0.6 m for moderate flood resilience.",
                confidence=0.72,
                annotations={"plinth_height_m": 0.6},
                room=anchor,
            )
        )

    elevated_bedrooms = [r for r in rooms if _room_type(r) == "bedroom" and int(getattr(r, "floor", 1) or 1) > 1]
    if elevation < 3.0 and not elevated_bedrooms:
        for idx, room in enumerate(rooms):
            if _room_type(room) != "bedroom":
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="elevate_floor",
                    old_value={"floor": int(room.floor)},
                    new_value={"floor": 2},
                    criterion_id=5,
                    reason="elevation < 3m AMSL - force-bedroom elevation for low-lying context",
                    confidence=0.95,
                )
            )

    has_courtyard = any(_room_type(room) == "courtyard" for room in rooms)
    if rainfall_mm > 2500.0 and not has_courtyard:
        cx, cy = _midpoint(_bounds(rooms))
        mutations.append(
            RoomMutation(
                room_id="courtyard_seed",
                mutation_type="add_room",
                old_value={},
                new_value={
                    "type": "courtyard",
                    "x": round(cx - 1.0, 3),
                    "y": round(cy - 1.0, 3),
                    "width": 2.0,
                    "height": 2.0,
                    "floor": 1,
                    "orientation": "N",
                },
                criterion_id=5,
                reason="Add drainage courtyard void for high-rainfall context.",
                confidence=0.78,
            )
        )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 6: Natural Daylighting
# ---------------------------------------------------------------------------

def correct_criterion_6(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(65.0, _safe_float(getattr(audit_result, "pass_threshold", 65.0), 65.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "deep", "penetration")
    fail_b = sub_b < threshold or _has_finding(audit_result, "wfr", "window")
    fail_c = sub_c < threshold or _has_finding(audit_result, "bilateral", "perpendicular")

    climate = _climate(env)
    windows_by_room = _windows_by_room(chromosome)
    bounds = _bounds(rooms)

    mutations: List[RoomMutation] = []

    for idx, room in enumerate(rooms):
        rid = _room_id(room, idx)
        faces = _window_faces(rid, windows_by_room)
        room_area = max(1e-6, room.width * room.height)
        window_area = _room_window_area(rid, windows_by_room)
        wfr = window_area / room_area

        depth = max(room.width, room.height)
        room_windows = windows_by_room.get(rid, [])
        head_h = max([_safe_float(w.get("head_height"), 2.1) for w in room_windows] + [2.1])

        if fail_a and depth > 2.5 * head_h:
            target_head = depth / 2.5
            if target_head - head_h < 0.5:
                face = faces[0] if faces else ("right" if _room_touches_edge(room, bounds, "right") else "left")
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="add_window",
                        old_value={"wall_face": face},
                        new_value={
                            "wall_face": face,
                            "width": 1.0,
                            "sill_height": 0.9,
                            "head_height": round(target_head, 3),
                        },
                        criterion_id=6,
                        reason="Increase window head height to improve daylight penetration depth.",
                        confidence=0.82,
                    )
                )
            else:
                target_depth = max(2.5 * head_h, 1.0)
                current_depth = max(depth, 1e-6)
                scale_factor = max(0.75, min(1.0, target_depth / current_depth))
                axis = "width" if room.width >= room.height else "height"
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="resize",
                        old_value={"width": room.width, "height": room.height},
                        new_value={"scale_factor": round(scale_factor, 3), "axis": axis},
                        criterion_id=6,
                        reason="Reduce excessive room depth where daylight penetration is insufficient.",
                        confidence=0.76,
                    )
                )

        if fail_b:
            if wfr < 0.15:
                target_area = 0.15 * room_area
                deficit = max(0.2, target_area - window_area)
                width = max(0.45, min(3.0, deficit / 1.2))
                face = faces[0] if faces else "right"
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="add_window",
                        old_value={"wall_face": face},
                        new_value={"wall_face": face, "width": round(width, 3), "sill_height": 0.9, "head_height": 2.1},
                        criterion_id=6,
                        reason="Increase room window-to-floor ratio toward 0.15 minimum daylight target.",
                        confidence=0.84,
                    )
                )
            elif climate == "hot" and wfr > 0.40 and faces:
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="remove_window",
                        old_value={"wall_face": faces[0]},
                        new_value={"wall_face": faces[0]},
                        criterion_id=6,
                        reason="Trim excess glazing in hot climate to keep daylight gain within thermal comfort range.",
                        confidence=0.68,
                    )
                )

        if fail_c and len(set(faces)) == 1:
            primary = faces[0]
            if primary in {"top", "bottom"}:
                secondary = "right"
            else:
                secondary = "top"
            mutations.append(
                RoomMutation(
                    room_id=rid,
                    mutation_type="add_window",
                    old_value={"wall_face": secondary},
                    new_value={"wall_face": secondary, "width": 0.6, "sill_height": 1.0, "head_height": 2.1},
                    criterion_id=6,
                    reason="Add perpendicular-face aperture to achieve bilateral daylighting.",
                    confidence=0.74,
                )
            )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 7: Tree Preservation
# ---------------------------------------------------------------------------

def correct_criterion_7(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(55.0, _safe_float(getattr(audit_result, "pass_threshold", 55.0), 55.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "canopy", "overlap")
    fail_b = sub_b < threshold or _has_finding(audit_result, "west", "shade")
    fail_c = sub_c < threshold or _has_finding(audit_result, "green ratio")

    bounds = _bounds(rooms)
    trees = _collect_tree_points(env, bounds)

    mutations: List[RoomMutation] = []

    if fail_a and trees:
        for r_idx, room in enumerate(rooms):
            for tree in trees:
                if tree["confidence"] <= 0.5:
                    continue
                if not _room_circle_overlap(room, tree["x"], tree["y"], tree["radius_m"]):
                    continue
                rcx, rcy = _center(room)
                vx = rcx - tree["x"]
                vy = rcy - tree["y"]
                length = max(1e-6, math.hypot(vx, vy))
                shift = tree["radius_m"] + 0.25
                nx = room.x + (vx / length) * shift
                ny = room.y + (vy / length) * shift
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, r_idx),
                        mutation_type="move",
                        old_value={"x": room.x, "y": room.y},
                        new_value={"x": round(nx, 3), "y": round(ny, 3)},
                        criterion_id=7,
                        reason=f"moved to avoid tree canopy at ({tree['x']:.2f},{tree['y']:.2f})",
                        confidence=0.9,
                    )
                )
                break

    if fail_b and _climate(env) == "hot":
        cx, cy = _midpoint(bounds)
        nearest = None
        nearest_distance = float("inf")
        for tree in trees:
            dist = _distance((tree["x"], tree["y"]), (cx, cy))
            if dist < nearest_distance:
                nearest_distance = dist
                nearest = tree

        if nearest is not None and nearest_distance <= 10.0:
            dx = nearest["x"] - cx
            dy = nearest["y"] - cy
            bearing = (math.degrees(math.atan2(dx, -dy)) + 360.0) % 360.0
            delta = ((270.0 - bearing + 540.0) % 360.0) - 180.0
            anchor = _room_id(rooms[0], 0)
            mutations.append(
                RoomMutation(
                    room_id=anchor,
                    mutation_type="reorient",
                    old_value={"orientation_delta_deg": 0.0},
                    new_value={"orientation_delta_deg": round(delta, 2), "all_rooms": True},
                    criterion_id=7,
                    reason="Rotate plan so existing nearby tree falls on west facade for shading benefit.",
                    confidence=0.72,
                )
            )
        else:
            anchor = rooms[0]
            mutations.append(
                _annotation_mutation(
                    room_id=_room_id(anchor, 0),
                    criterion_id=7,
                    reason="No west-side tree within 10m; annotate external green-buffer recommendation.",
                    confidence=0.62,
                    annotations={"green_buffer_recommendation": "Provide west facade shade planting"},
                    room=anchor,
                )
            )

    if fail_c:
        for idx, room in enumerate(rooms):
            if not _boundary_adjacent(room, bounds):
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="resize",
                    old_value={"width": room.width, "height": room.height},
                    new_value={"scale_factor": 0.90, "axis": "both"},
                    criterion_id=7,
                    reason="Shrink boundary-adjacent room footprint to restore green coverage ratio.",
                    confidence=0.72,
                )
            )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 8: Soil & Foundation
# ---------------------------------------------------------------------------

def correct_criterion_8(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(50.0, _safe_float(getattr(audit_result, "pass_threshold", 50.0), 50.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "clay", "foundation")
    fail_b = sub_b < threshold or _has_finding(audit_result, "slope")
    fail_c = sub_c < threshold or _has_finding(audit_result, "soil", "chemistry", "ph")

    clay_pct = _safe_float(env.get("clay_pct"), 25.0)
    slope = _safe_float(env.get("slope"), 5.0)
    soil_ph = _safe_float(env.get("soil_ph"), 6.8)

    mutations: List[RoomMutation] = []

    if fail_a:
        foundation_type = None
        if clay_pct > 45.0:
            foundation_type = "raft"
        elif 25.0 <= clay_pct <= 45.0:
            foundation_type = "strip_with_drainage"

        if foundation_type is not None:
            anchor = rooms[0]
            mutations.append(
                _annotation_mutation(
                    room_id=_room_id(anchor, 0),
                    criterion_id=8,
                    reason=f"Set foundation_type={foundation_type} for clay={clay_pct:.1f}%.",
                    confidence=0.9,
                    annotations={"foundation_type": foundation_type},
                    room=anchor,
                )
            )

        for idx, room in enumerate(rooms):
            if int(getattr(room, "floor", 1) or 1) != 1:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="resize",
                    old_value={"width": room.width, "height": room.height},
                    new_value={"scale_factor": 0.92, "axis": "both"},
                    criterion_id=8,
                    reason=f"reduce footprint on expansive clay soil (clay={clay_pct:.1f}%)",
                    confidence=0.84,
                )
            )

    if fail_b:
        if 5.0 <= slope <= 12.0:
            ordered = sorted(rooms, key=lambda r: _center(r)[1], reverse=True)
            half = max(1, len(ordered) // 2)
            for idx, room in enumerate(ordered[:half]):
                if int(getattr(room, "floor", 1) or 1) > 1:
                    continue
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, idx),
                        mutation_type="elevate_floor",
                        old_value={"floor": int(room.floor)},
                        new_value={"floor": 2},
                        criterion_id=8,
                        reason="Promote downhill-side rooms to split-level arrangement for moderate slope.",
                        confidence=0.8,
                    )
                )
        elif slope > 12.0:
            anchor = rooms[0]
            mutations.append(
                _annotation_mutation(
                    room_id=_room_id(anchor, 0),
                    criterion_id=8,
                    reason="Add stilt/pillar recommendation for steep slope foundation.",
                    confidence=0.88,
                    annotations={"foundation_support": "stilt_or_pillar"},
                    room=anchor,
                )
            )
            for idx, room in enumerate(rooms):
                if _room_type(room) not in HABITABLE_TYPES:
                    continue
                if int(getattr(room, "floor", 1) or 1) > 1:
                    continue
                mutations.append(
                    RoomMutation(
                        room_id=_room_id(room, idx),
                        mutation_type="elevate_floor",
                        old_value={"floor": int(room.floor)},
                        new_value={"floor": 2},
                        criterion_id=8,
                        reason="Move habitable rooms off steep ground-contact level for slope resilience.",
                        confidence=0.86,
                    )
                )

    if fail_c and not (6.0 <= soil_ph <= 7.5):
        note = (
            f"Soil pH {soil_ph:.2f} - specify conventional concrete foundation. "
            "Avoid rammed earth, adobe, or stabilized earth blocks."
        )
        anchor = rooms[0]
        mutations.append(
            _annotation_mutation(
                room_id=_room_id(anchor, 0),
                criterion_id=8,
                reason="Annotate material restrictions for out-of-range soil pH.",
                confidence=0.77,
                annotations={"soil_material_note": note},
                room=anchor,
            )
        )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 9: Renewable Readiness
# ---------------------------------------------------------------------------

def correct_criterion_9(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(45.0, _safe_float(getattr(audit_result, "pass_threshold", 45.0), 45.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "roof", "solar")
    fail_b = sub_b < threshold or _has_finding(audit_result, "axis", "pv")
    fail_c = sub_c < threshold or _has_finding(audit_result, "rainwater", "harvesting")

    bounds = _bounds(rooms)
    min_x, min_y, max_x, max_y = bounds

    mutations: List[RoomMutation] = []

    if fail_a:
        elevated_any = False
        for idx, room in enumerate(rooms):
            if _room_type(room) != "bedroom":
                continue
            if int(getattr(room, "floor", 1) or 1) > 1:
                continue
            mutations.append(
                RoomMutation(
                    room_id=_room_id(room, idx),
                    mutation_type="elevate_floor",
                    old_value={"floor": int(room.floor)},
                    new_value={"floor": 2},
                    criterion_id=9,
                    reason="increase net top-floor area for PV installation",
                    confidence=0.84,
                )
            )
            elevated_any = True
            break
        if not elevated_any:
            anchor = rooms[0]
            mutations.append(
                _annotation_mutation(
                    room_id=_room_id(anchor, 0),
                    criterion_id=9,
                    reason="Annotate PV-ready roof reserve where no bedroom elevation candidate exists.",
                    confidence=0.68,
                    annotations={"pv_ready": True},
                    room=anchor,
                )
            )

    strategy1_applied = bool(env.get("_strategy1_applied", False))
    if fail_b and not strategy1_applied:
        axis_bearing = 90.0 if (max_x - min_x) >= (max_y - min_y) else 0.0
        target = 90.0 if _angle_diff(axis_bearing, 90.0) <= _angle_diff(axis_bearing, 270.0) else 270.0
        delta = ((target - axis_bearing + 540.0) % 360.0) - 180.0
        if abs(delta) > 30.0:
            delta = 30.0 if delta > 0 else -30.0
        if abs(delta) > 1.0:
            anchor = _room_id(rooms[0], 0)
            mutations.append(
                RoomMutation(
                    room_id=anchor,
                    mutation_type="reorient",
                    old_value={"orientation_delta_deg": 0.0},
                    new_value={"orientation_delta_deg": round(delta, 2), "all_rooms": True},
                    criterion_id=9,
                    reason="Rotate building axis toward east-west orientation for PV efficiency.",
                    confidence=0.74,
                )
            )

    if fail_c:
        rainfall_mm = _safe_float(env.get("rainfall_mm"), 1200.0)
        plot_area = _safe_float(env.get("plot_area_sqm"), 220.0)
        required_liters = max(1200.0, rainfall_mm * plot_area * 0.001 * 0.35)
        tank_area = float(math.ceil((required_liters / 1000.0) / 1.5))

        service_zone_x = max(min_x, max_x - 2.2)
        service_zone_y = max(min_y, min_y + 0.2)

        mutations.append(
            RoomMutation(
                room_id="rwh_tank",
                mutation_type="add_room",
                old_value={},
                new_value={
                    "type": "utility",
                    "label": "RWH Tank",
                    "x": round(service_zone_x, 3),
                    "y": round(service_zone_y, 3),
                    "width": max(1.5, round(math.sqrt(max(tank_area, 1.5)), 3)),
                    "height": max(1.5, round(math.sqrt(max(tank_area, 1.5)), 3)),
                    "floor": 1,
                    "orientation": "N",
                },
                criterion_id=9,
                reason="Place utility tank room to satisfy rainwater harvesting capacity.",
                confidence=0.8,
            )
        )

        anchor = rooms[0]
        mutations.append(
            _annotation_mutation(
                room_id=_room_id(anchor, 0),
                criterion_id=9,
                reason="Annotate computed rainwater storage area requirement.",
                confidence=0.73,
                annotations={"rainwater_tank_sqm": tank_area, "required_tank_volume_l": round(required_liters, 1)},
                room=anchor,
            )
        )

    return mutations


# ---------------------------------------------------------------------------
# Strategy 10: Indoor Air Quality & Biophilic Design
# ---------------------------------------------------------------------------

def correct_criterion_10(chromosome: Chromosome, audit_result: CriterionResult, env: dict) -> List[RoomMutation]:
    rooms = list(getattr(chromosome, "rooms", []) or [])
    if not rooms:
        return []

    threshold = max(50.0, _safe_float(getattr(audit_result, "pass_threshold", 50.0), 50.0))
    sub_a = _sub_score(audit_result, "A", 100.0)
    sub_b = _sub_score(audit_result, "B", 100.0)
    sub_c = _sub_score(audit_result, "C", 100.0)

    fail_a = sub_a < threshold or _has_finding(audit_result, "no openable", "no window")
    fail_b = sub_b < threshold or _has_finding(audit_result, "ratio", "window area")
    fail_c = sub_c < threshold or _has_finding(audit_result, "biophilic", "vegetation", "water")

    bounds = _bounds(rooms)
    windows_by_room = _windows_by_room(chromosome)

    mutations: List[RoomMutation] = []

    if fail_a:
        for idx, room in enumerate(rooms):
            rid = _room_id(room, idx)
            faces = _window_faces(rid, windows_by_room)
            if faces:
                continue
            preferred_edge = None
            for edge in ("right", "left", "top", "bottom"):
                if _room_touches_edge(room, bounds, edge):
                    preferred_edge = edge
                    break
            if preferred_edge is None:
                preferred_edge = "right"

            width = 1.2
            sill = 0.9
            head = 2.1
            reason = "Add operable window for room without ventilation opening."
            confidence = 0.82

            if _room_type(room) == "bedroom":
                reason = "Building code violation: habitable room without window"
                confidence = 1.0
            elif _room_type(room) == "bathroom":
                width = 0.45
                sill = 1.6
                head = 2.0
                reason = "Moisture and IAQ - bathroom requires ventilation opening"
                confidence = 0.95

            mutations.append(
                RoomMutation(
                    room_id=rid,
                    mutation_type="add_window",
                    old_value={"wall_face": preferred_edge},
                    new_value={"wall_face": preferred_edge, "width": width, "sill_height": sill, "head_height": head},
                    criterion_id=10,
                    reason=reason,
                    confidence=confidence,
                )
            )

    if fail_b:
        total_window_area = sum(_room_window_area(_room_id(room, idx), windows_by_room) for idx, room in enumerate(rooms))
        total_floor_area = max(1e-6, sum(room.width * room.height for room in rooms))
        current_ratio = total_window_area / total_floor_area
        target_ratio = 0.10
        if current_ratio < target_ratio:
            scale = min(1.3, target_ratio / max(current_ratio, 0.01))
            for idx, room in enumerate(rooms):
                rid = _room_id(room, idx)
                room_area = max(1e-6, room.width * room.height)
                room_wfr = _room_window_area(rid, windows_by_room) / room_area
                if room_wfr >= 0.12:
                    continue
                face = "right" if _room_touches_edge(room, bounds, "right") else "left"
                width = max(0.6, min(2.4, 1.0 * scale))
                mutations.append(
                    RoomMutation(
                        room_id=rid,
                        mutation_type="add_window",
                        old_value={"wall_face": face},
                        new_value={"wall_face": face, "width": round(width, 3), "sill_height": 0.9, "head_height": 2.1},
                        criterion_id=10,
                        reason="Increase operable window area to raise whole-plan IAQ ratio.",
                        confidence=0.75,
                    )
                )

    if fail_c:
        living = next((room for room in rooms if _room_type(room) == "living"), None)
        if living is not None:
            trees = _collect_tree_points(env, bounds)
            if trees:
                lc = _center(living)
                best_tree = max(trees, key=lambda t: t.get("confidence", 0.0))
                dx = best_tree["x"] - lc[0]
                dy = best_tree["y"] - lc[1]
                bearing = (math.degrees(math.atan2(dx, -dy)) + 360.0) % 360.0
                orientation = _bearing_to_octant(bearing)
            else:
                orientation = "E"

            mutations.append(
                RoomMutation(
                    room_id=str(living.id),
                    mutation_type="reorient",
                    old_value={"orientation": living.orientation},
                    new_value={"orientation": orientation, "all_rooms": False},
                    criterion_id=10,
                    reason="orient living room toward highest vegetation density",
                    confidence=0.7,
                )
            )

    return mutations
