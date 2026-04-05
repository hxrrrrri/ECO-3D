"""Eco-friendliness validator for generated floor plan variants.

This module is intentionally pure-stdlib and avoids any ML dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


COMPASS_BEARINGS: Dict[str, float] = {
    "N": 0,
    "NNE": 22.5,
    "NE": 45,
    "ENE": 67.5,
    "E": 90,
    "ESE": 112.5,
    "SE": 135,
    "SSE": 157.5,
    "S": 180,
    "SSW": 202.5,
    "SW": 225,
    "WSW": 247.5,
    "W": 270,
    "WNW": 292.5,
    "NW": 315,
    "NNW": 337.5,
}

CARDINAL_BEARINGS: Dict[str, float] = {
    "N": 0.0,
    "E": 90.0,
    "S": 180.0,
    "W": 270.0,
}

HABITABLE_TYPES = {"living", "dining", "bedroom", "office"}
SERVICE_TYPES = {"kitchen", "bathroom", "utility", "garage", "storage"}
WET_TYPES = {"kitchen", "bathroom", "utility"}


@dataclass
class CriterionResult:
    criterion_id: int
    criterion_name: str
    score: float
    weight: float
    weighted_score: float
    passed: bool
    pass_threshold: float
    sub_scores: dict
    findings: list[str]
    penalties_applied: list[str]
    bonuses_applied: list[str]
    recommendations: list[str]
    data_sources: list[str]
    standard_ref: str


@dataclass
class EcoAuditReport:
    variant_id: int
    algorithm: str
    timestamp: str
    criteria: list[CriterionResult]
    composite_eco_score: float
    grade: str
    overall_passed: bool
    n_criteria_passed: int
    n_criteria_failed: int
    critical_failures: list[str]
    top_strengths: list[str]
    top_weaknesses: list[str]
    priority_fixes: list[str]
    climate_context: str
    site_risk_level: str
    compliance_citations: list[str]
    data_quality: dict


CRITERION_WEIGHTS: Dict[int, float] = {
    1: 0.18,
    2: 0.16,
    3: 0.12,
    4: 0.12,
    5: 0.10,
    6: 0.10,
    7: 0.08,
    8: 0.06,
    9: 0.05,
    10: 0.03,
}


def get_wind_bearing(wind_direction: str) -> float:
    return COMPASS_BEARINGS.get((wind_direction or "").upper(), 225.0)


def get_solar_noon_azimuth(lat: float) -> float:
    return 180.0 if lat >= 0 else 0.0


def classify_climate(solar_radiation_kwh: float) -> str:
    if solar_radiation_kwh > 5.5:
        return "hot"
    if solar_radiation_kwh < 3.5:
        return "cold"
    return "temperate"


def get_room_compass_bearing(room: Any, plot_w: float, plot_h: float) -> float:
    """Return the compass bearing of the room's primary exterior facade."""
    orientation_map = {
        "N": 0,
        "NE": 45,
        "E": 90,
        "SE": 135,
        "S": 180,
        "SW": 225,
        "W": 270,
        "NW": 315,
        "NNE": 22.5,
        "ENE": 67.5,
        "ESE": 112.5,
        "SSE": 157.5,
        "SSW": 202.5,
        "WSW": 247.5,
        "WNW": 292.5,
        "NNW": 337.5,
    }
    orientation = str(_value(room, "orientation", "S") or "S").upper()
    return orientation_map.get(orientation, 180.0)


def angle_diff(a: float, b: float) -> float:
    """Absolute angular difference, always 0-180."""
    d = abs(a - b) % 360
    return min(d, 360 - d)


def room_window_area(room: Any, windows: Sequence[Any]) -> float:
    """Total glass area for a given room from its Window objects."""
    room_id = _room_id(room)
    total = 0.0
    for w in windows:
        wrid, _ = _parse_window_wall(str(_value(w, "wall", "")))
        if room_id and wrid == room_id:
            total += max(0.0, _window_area(w))
    return total


def room_has_window_on_face(room: Any, windows: Sequence[Any], face: str) -> bool:
    """Check if room has a window on a specific face: top/bottom/left/right or N/E/S/W."""
    room_id = _room_id(room)
    wanted = _normalize_face(face)
    for w in windows:
        wrid, wface = _parse_window_wall(str(_value(w, "wall", "")))
        if room_id and wrid == room_id and _normalize_face(wface) == wanted:
            return True
    return False


def building_footprint_area(rooms: Sequence[Any]) -> float:
    """Bounding box area of all floor-1 rooms."""
    floor_rooms = [r for r in rooms if int(_value(r, "floor", 1) or 1) == 1]
    if not floor_rooms:
        return 0.0
    min_x, min_y, max_x, max_y = _bounds(floor_rooms)
    return max(0.0, (max_x - min_x) * (max_y - min_y))


def building_perimeter(rooms: Sequence[Any]) -> float:
    """Approximate perimeter of bounding box."""
    floor_rooms = [r for r in rooms if int(_value(r, "floor", 1) or 1) == 1]
    if not floor_rooms:
        return 0.0
    min_x, min_y, max_x, max_y = _bounds(floor_rooms)
    return max(0.0, 2.0 * ((max_x - min_x) + (max_y - min_y)))


def verify_live_data(env: dict) -> dict:
    """Check each environmental field for signs of fallback/synthetic data."""
    quality: Dict[str, Any] = {}

    wind_direction = str(env.get("wind_direction", "") or "").upper()
    wind_speed = _safe_float(env.get("wind_speed_ms"), 0.0)
    quality["wind"] = not (
        wind_direction == "SW" and abs(wind_speed % 1.0) < 1e-9
    )

    clay = _safe_float(env.get("clay_pct"), 0.0)
    soil_ph = _safe_float(env.get("soil_ph"), 0.0)
    quality["soil"] = (abs(clay % 1.0) > 1e-9) or (abs(soil_ph % 1.0) > 1e-9)

    ndvi = _safe_float(env.get("ndvi"), 0.45)
    quality["ndvi"] = abs(ndvi - 0.45) > 1e-9

    flood_probability = _safe_float(env.get("flood_probability"), 0.25)
    quality["flood"] = abs(flood_probability - 0.25) > 1e-9

    elevation = _safe_float(env.get("elevation"), 14.0)
    quality["elevation"] = elevation not in (14.0, 52.0, 0.0)

    bool_fields = [
        bool(quality["wind"]),
        bool(quality["soil"]),
        bool(quality["ndvi"]),
        bool(quality["flood"]),
        bool(quality["elevation"]),
    ]
    quality["is_fully_live"] = all(bool_fields)
    quality["live_field_count"] = sum(1 for v in bool_fields if v)
    quality["fallback_field_count"] = 5 - quality["live_field_count"]
    return quality


def check_passive_solar_orientation(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 1 - ASHRAE 55 + LEED BD&C v4 IEQ"""
    weight = CRITERION_WEIGHTS[1]
    threshold = 65.0
    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    lat = _safe_float(env.get("lat"), 0.0)
    solar_kwh = _safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0)
    climate = classify_climate(solar_kwh)
    solar_noon = get_solar_noon_azimuth(lat)
    wind_bearing = get_wind_bearing(str(env.get("wind_direction", "SW") or "SW"))

    min_x, min_y, max_x, max_y = _bounds(rooms)
    width = max(0.0, max_x - min_x)
    height = max(0.0, max_y - min_y)
    axis_bearing = 90.0 if width >= height else 0.0

    axis_diff = angle_diff(axis_bearing, solar_noon)
    a_norm = (math.cos(math.radians(axis_diff)) + 1.0) / 2.0
    if climate == "hot":
        a_norm = 1.0 - a_norm
    score_a = _clamp(a_norm * 100.0, 0.0, 100.0)

    habitable_rooms = [r for r in rooms if _room_type(r) in HABITABLE_TYPES]
    if habitable_rooms:
        b_ok = 0
        for room in habitable_rooms:
            rb = get_room_compass_bearing(room, width, height)
            diff = angle_diff(rb, solar_noon)
            if climate == "hot":
                if diff >= 120.0:
                    b_ok += 1
            else:
                if diff <= 45.0:
                    b_ok += 1
        score_b = 100.0 * b_ok / len(habitable_rooms)
    else:
        score_b = 60.0

    facade_lengths = {
        "N": width,
        "S": width,
        "E": height,
        "W": height,
    }
    facade_area = {k: max(1e-6, v * 3.0) for k, v in facade_lengths.items()}
    window_by_face = _window_area_by_cardinal_face(windows)

    solar_face = "S" if lat >= 0 else "N"
    poleward_face = "N" if lat >= 0 else "S"

    solar_ratio = window_by_face.get(solar_face, 0.0) / facade_area[solar_face]
    pole_ratio = window_by_face.get(poleward_face, 0.0) / facade_area[poleward_face]

    if climate == "hot":
        if solar_ratio <= 0.15:
            solar_face_score = 100.0
        else:
            solar_face_score = _clamp(100.0 - (solar_ratio - 0.15) * 400.0, 0.0, 100.0)
    else:
        solar_face_score = _clamp((solar_ratio / 0.25) * 100.0, 0.0, 100.0)

    pole_face_score = 100.0 if pole_ratio <= 0.10 else _clamp(100.0 - (pole_ratio - 0.10) * 500.0, 0.0, 100.0)
    score_c = 0.5 * solar_face_score + 0.5 * pole_face_score

    raw_score = 0.40 * score_a + 0.35 * score_b + 0.25 * score_c

    warm_or_hot = climate == "hot" or solar_kwh >= 5.0
    bedrooms = [r for r in rooms if _room_type(r) == "bedroom"]
    if warm_or_hot and bedrooms:
        primary = max(bedrooms, key=_room_area)
        if angle_diff(get_room_compass_bearing(primary, width, height), 270.0) <= 45.0:
            raw_score -= 15.0
            penalties.append("Primary bedroom faces west in warm/hot climate (-15)")
            recs.append("Reorient the primary bedroom away from the west facade to reduce overheating.")

    kitchens = [r for r in rooms if _room_type(r) == "kitchen"]
    windward_face = _bearing_to_cardinal(wind_bearing)
    kitchen_ok = False
    for k_room in kitchens:
        faces = _room_window_faces(k_room, windows)
        if "E" in faces or windward_face in faces:
            kitchen_ok = True
            break
    if kitchens and not kitchen_ok:
        raw_score -= 10.0
        penalties.append("Kitchen lacks east-facing or windward-facing window (-10)")
        recs.append("Add an east or windward window to the kitchen for morning light and passive ventilation.")

    if climate == "cold":
        living_rooms = [r for r in rooms if _room_type(r) == "living"]
        has_solar_exposure = False
        for l_room in living_rooms:
            faces = _room_window_faces(l_room, windows)
            if solar_face in faces:
                has_solar_exposure = True
                break
        if living_rooms and not has_solar_exposure:
            raw_score -= 20.0
            penalties.append("Living room lacks southern solar exposure in cold climate (-20)")
            recs.append("Increase solar-side glazing for the living room to improve winter passive gain.")

    score = _clamp(raw_score, 0.0, 100.0)
    findings.append(f"Primary-axis solar alignment sub-score: {score_a:.1f}")
    findings.append(f"Habitable room orientation compliance: {score_b:.1f}")
    findings.append(f"Facade glazing compliance score: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Align the building long axis closer to the climate-appropriate solar orientation.")
    if score_b < 60.0:
        recs.append("Rotate habitable rooms to meet solar-facing rules for the local climate.")
    if score_c < 60.0:
        recs.append("Rebalance glazing between solar and poleward facades to meet thresholds.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=1,
        name="Passive Solar Orientation",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["lat", "solar_radiation_kwh", "wind_direction", "windows", "room orientation"],
        standard_ref="ASHRAE 55 + LEED BD&C v4 IEQ",
    )


def check_natural_ventilation(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 2 - NBC India Part 8 Section 1"""
    weight = CRITERION_WEIGHTS[2]
    threshold = 60.0
    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    wind_bearing = get_wind_bearing(str(env.get("wind_direction", "SW") or "SW"))
    wind_speed = _safe_float(env.get("wind_speed_ms"), 0.0)

    habitable_rooms = [r for r in rooms if _room_type(r) in HABITABLE_TYPES]
    windward_faces = _faces_within_bearing(wind_bearing, 60.0)
    leeward_faces = _faces_within_bearing((wind_bearing + 180.0) % 360.0, 60.0)

    cross_ok = 0
    windward_ok = 0
    leeward_ok = 0

    for room in habitable_rooms:
        faces = _room_window_faces(room, windows)
        room_windows = _room_windows(room, windows)

        has_perp = _has_perpendicular_faces(faces)
        has_wind_cross = bool(faces & windward_faces and faces & leeward_faces)
        has_cross = has_perp or has_wind_cross
        if has_cross:
            cross_ok += 1

        if faces & windward_faces:
            windward_ok += 1

        has_high_leeward = any(
            _normalize_face(_parse_window_wall(str(_value(w, "wall", "")))[1]) in leeward_faces
            and _safe_float(_value(w, "sill_height", 0.0), 0.0) >= 1.8
            for w in room_windows
        )
        if has_high_leeward:
            leeward_ok += 1

    denom = max(1, len(habitable_rooms))
    score_a = 100.0 * cross_ok / denom
    score_b = 100.0 * windward_ok / denom
    score_c = 100.0 * leeward_ok / denom

    raw_score = 0.50 * score_a + 0.30 * score_b + 0.20 * score_c

    courtyard_void = _courtyard_or_void_area(rooms) > 4.0
    if courtyard_void:
        raw_score += 10.0
        bonuses.append("Courtyard/internal void detected (>4 m2): thermal chimney bonus (+10)")

    kitchens = [r for r in rooms if _room_type(r) == "kitchen"]
    kitchen_windward = any(_room_on_any_face(k, windward_faces, rooms) for k in kitchens)
    if kitchen_windward:
        raw_score += 5.0
        bonuses.append("Kitchen located on windward edge (+5)")

    bedrooms = [r for r in rooms if _room_type(r) == "bedroom"]
    bedroom_single_window_issue = False
    for b_room in bedrooms:
        room_windows = _room_windows(b_room, windows)
        faces = _room_window_faces(b_room, windows)
        has_cross = _has_perpendicular_faces(faces) or bool(faces & windward_faces and faces & leeward_faces)
        if len(room_windows) <= 1 and not has_cross:
            bedroom_single_window_issue = True
            break
    if bedroom_single_window_issue:
        raw_score -= 15.0
        penalties.append("At least one bedroom has no cross-ventilation path (-15)")
        recs.append("Add a second opening on a perpendicular or leeward wall in bedrooms.")

    service_rooms = [r for r in rooms if _room_type(r) in {"utility", "garage", "bathroom", "kitchen"}]
    has_windbreak = any(_room_on_any_face(s, windward_faces, rooms) for s in service_rooms)
    if wind_speed > 6.0 and not has_windbreak:
        raw_score -= 20.0
        penalties.append("High wind site without windbreak/service buffering on windward edge (-20)")
        recs.append("Place utility/service rooms on the windward edge as a windbreak buffer.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Cross-ventilated habitable room ratio: {score_a:.1f}")
    findings.append(f"Windward opening compliance: {score_b:.1f}")
    findings.append(f"High-sill leeward exhaust compliance: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Provide windows on two non-parallel faces in habitable rooms.")
    if score_b < 60.0:
        recs.append("Align at least one opening within +/-60 degrees of prevailing wind.")
    if score_c < 60.0:
        recs.append("Add high leeward vents (sill >= 1.8 m) for stack-assisted exhaust.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=2,
        name="Natural Cross-Ventilation",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["wind_direction", "wind_speed_ms", "windows", "room geometry"],
        standard_ref="NBC India Part 8 Section 1",
    )


def check_building_compactness(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 3 - LEED BD&C v4 Optimize Energy + Passive House"""
    weight = CRITERION_WEIGHTS[3]
    threshold = 55.0
    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    total_floor_area = sum(_room_area(r) for r in rooms)
    perimeter_m = _estimated_external_perimeter(rooms)
    if perimeter_m <= 1e-6:
        perimeter_m = building_perimeter(rooms)
    external_wall_surface = max(1e-6, perimeter_m * 3.0)

    compactness = total_floor_area / external_wall_surface
    score_a = _clamp(min(1.0, compactness / 0.55) * 100.0, 0.0, 100.0)

    n_corners = _estimated_external_corners(rooms)
    score_b = _clamp(100.0 - max(0, n_corners - 4) * 8.0, 0.0, 100.0)

    habitable_area = sum(_room_area(r) for r in rooms if _room_type(r) in HABITABLE_TYPES)
    usable_ratio = habitable_area / max(total_floor_area, 1e-6)
    if 0.65 <= usable_ratio <= 0.75:
        score_c = 100.0
    else:
        score_c = _clamp(100.0 - abs(usable_ratio - 0.70) * 300.0, 0.0, 100.0)

    raw_score = 0.50 * score_a + 0.30 * score_b + 0.20 * score_c

    plot_area = _safe_float(env.get("plot_area_sqm"), 0.0)
    footprint = building_footprint_area(rooms)
    if plot_area > 0 and plot_area < 200.0 and footprint < 0.60 * plot_area:
        raw_score += 10.0
        bonuses.append("Compact footprint on small plot preserves green buffer (+10)")

    max_floor = max((int(_value(r, "floor", 1) or 1) for r in rooms), default=1)
    if len(rooms) > 12 and max_floor == 1:
        raw_score -= 10.0
        penalties.append("Sprawling single-story layout with >12 rooms (-10)")
        recs.append("Distribute rooms across more floors to reduce sprawl and envelope load.")

    if any(min(_safe_float(_value(r, "width", 0.0), 0.0), _safe_float(_value(r, "height", 0.0), 0.0)) < 2.4 for r in rooms):
        raw_score -= 15.0
        penalties.append("At least one room dimension is below 2.4 m (-15)")
        recs.append("Increase narrow room dimensions to at least 2.4 m.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Compactness ratio: {compactness:.3f} (sub-score {score_a:.1f})")
    findings.append(f"Estimated exterior corner count: {n_corners} (sub-score {score_b:.1f})")
    findings.append(f"Habitable/total area ratio: {usable_ratio:.3f} (sub-score {score_c:.1f})")

    if score_a < 60.0:
        recs.append("Reduce exposed perimeter relative to floor area for better compactness.")
    if score_b < 60.0:
        recs.append("Simplify plan articulation to reduce unnecessary corners.")
    if score_c < 60.0:
        recs.append("Increase habitable area share and reduce circulation waste.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=3,
        name="Building Compactness & Efficiency",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["plot_area_sqm", "rooms", "walls"],
        standard_ref="LEED BD&C v4 Optimize Energy Performance + Passive House",
    )


def check_thermal_zoning(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 4 - ASHRAE 90.1 + PassivHaus zoning"""
    weight = CRITERION_WEIGHTS[4]
    threshold = 60.0
    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    lat = _safe_float(env.get("lat"), 0.0)
    climate = classify_climate(_safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0))
    wind_bearing = get_wind_bearing(str(env.get("wind_direction", "SW") or "SW"))

    service_rooms = [r for r in rooms if _room_type(r) in SERVICE_TYPES]
    if climate == "cold":
        target_face = "N" if lat >= 0 else "S"
    elif climate == "hot":
        target_face = "W"
    else:
        target_face = _bearing_to_cardinal((wind_bearing + 180.0) % 360.0)

    if service_rooms:
        target_set = {target_face}
        positioned = sum(1 for r in service_rooms if _room_on_any_face(r, target_set, rooms) or angle_diff(get_room_compass_bearing(r, 0.0, 0.0), CARDINAL_BEARINGS[target_face]) <= 50.0)
        score_a = 100.0 * positioned / len(service_rooms)
    else:
        score_a = 80.0

    wet_rooms = [r for r in rooms if _room_type(r) in WET_TYPES]
    if len(wet_rooms) <= 1:
        max_dist = 0.0
        score_b = 100.0
    else:
        max_dist = 0.0
        for i in range(len(wet_rooms)):
            for j in range(i + 1, len(wet_rooms)):
                d = _distance(_room_centroid(wet_rooms[i]), _room_centroid(wet_rooms[j]))
                if d > max_dist:
                    max_dist = d
        score_b = 100.0 if max_dist <= 5.0 else _clamp(100.0 - (max_dist - 5.0) * 12.0, 0.0, 100.0)

    bedrooms = [r for r in rooms if _room_type(r) == "bedroom"]
    noisy = [r for r in rooms if _room_type(r) in {"living", "kitchen"}]
    if bedrooms:
        separated = 0
        for b in bedrooms:
            if any(_rooms_adjacent(b, n) for n in noisy):
                continue
            separated += 1
        score_c = 100.0 * separated / len(bedrooms)
    else:
        score_c = 100.0

    raw_score = 0.40 * score_a + 0.35 * score_b + 0.25 * score_c

    bathrooms = [r for r in rooms if _room_type(r) == "bathroom"]
    dining_rooms = [r for r in rooms if _room_type(r) == "dining"]
    if any(_rooms_adjacent(b, d) for b in bathrooms for d in dining_rooms):
        raw_score -= 20.0
        penalties.append("Bathroom directly adjacent to dining room (-20)")
        recs.append("Separate bathrooms from dining walls using buffer/corridor placement.")

    garages = [r for r in rooms if _room_type(r) == "garage"]
    living_rooms = [r for r in rooms if _room_type(r) == "living"]
    solar_face = "S" if lat >= 0 else "N"
    if garages and living_rooms and _garage_blocks_solar(garages, living_rooms, rooms, solar_face):
        raw_score -= 15.0
        penalties.append("Garage placement blocks living-room solar facade access (-15)")
        recs.append("Move the garage away from the primary solar facade.")

    if climate == "hot":
        utilities = [r for r in rooms if _room_type(r) == "utility"]
        if any(_room_on_any_face(u, {"E"}, rooms) for u in utilities):
            raw_score -= 10.0
            penalties.append("Utility room on east facade in hot climate (-10)")
            recs.append("Relocate utility spaces away from the east facade in hot climates.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Service/buffer room face compliance: {score_a:.1f}")
    findings.append(f"Wet-area clustering max centroid distance: {max_dist:.2f} m (sub-score {score_b:.1f})")
    findings.append(f"Bedroom privacy zoning compliance: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Place service rooms on climate-appropriate buffer facades.")
    if score_b < 60.0:
        recs.append("Cluster kitchen, bathrooms, and utility rooms within ~5 m for thermal/plumbing efficiency.")
    if score_c < 60.0:
        recs.append("Increase separation between bedrooms and public/noisy zones.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=4,
        name="Thermal Zoning & Buffer Layout",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["solar_radiation_kwh", "wind_direction", "rooms"],
        standard_ref="ASHRAE 90.1 Building Envelope + PassivHaus Zoning",
    )


def check_flood_resilience(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 5 - FEMA Hazard Mitigation + NBC India Flood Zones"""
    weight = CRITERION_WEIGHTS[5]

    flood_p = _safe_float(env.get("flood_probability"), 0.3)
    elevation = _safe_float(env.get("elevation"), 0.0)
    rainfall = _safe_float(env.get("rainfall_mm"), 0.0)

    if flood_p > 0.60:
        risk = "high"
        threshold = 70.0
    elif flood_p >= 0.30:
        risk = "moderate"
        threshold = 55.0
    else:
        risk = "low"
        threshold = 40.0

    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    habitable = [r for r in rooms if _room_type(r) in HABITABLE_TYPES]
    bedrooms = [r for r in rooms if _room_type(r) == "bedroom"]
    services = [r for r in rooms if _room_type(r) in {"utility", "garage", "kitchen", "storage"}]

    if risk == "high":
        if habitable:
            elevated_hab = sum(1 for r in habitable if int(_value(r, "floor", 1) or 1) >= 2)
            score_a = 100.0 * elevated_hab / len(habitable)
        else:
            score_a = 100.0
    elif risk == "moderate":
        if bedrooms:
            low_bed = sum(1 for r in bedrooms if _safe_float(_value(r, "y", 0.0), 0.0) < 0.6)
            score_a = _clamp(100.0 - (low_bed / len(bedrooms)) * 40.0, 0.0, 100.0)
        else:
            score_a = 100.0
    else:
        score_a = 100.0

    if risk == "high":
        compliant = 0
        for r in services:
            r_type = _room_type(r)
            floor = int(_value(r, "floor", 1) or 1)
            if r_type == "kitchen":
                compliant += 1 if floor >= 2 else 0
            else:
                compliant += 1
        score_b = 100.0 * compliant / max(1, len(services))
    else:
        score_b = 100.0

    courtyard_void = _courtyard_or_void_area(rooms) > 4.0
    if risk == "high":
        sacrificial = any(_room_type(r) in {"utility", "storage"} and int(_value(r, "floor", 1) or 1) == 1 for r in rooms)
        if sacrificial:
            bonuses.append("Ground-floor sacrificial utility/storage space detected (+10)")
        mech_rooms = [r for r in rooms if _room_type(r) in {"utility", "storage"}]
        mech_up = sum(1 for r in mech_rooms if int(_value(r, "floor", 1) or 1) >= 2)
        mech_ratio = mech_up / max(1, len(mech_rooms))
        score_c = _clamp(60.0 * mech_ratio + (40.0 if sacrificial else 20.0), 0.0, 100.0)
    elif risk == "moderate":
        score_c = 90.0 if courtyard_void else 75.0
    else:
        score_c = 100.0

    raw_score = 0.50 * score_a + 0.30 * score_b + 0.20 * score_c

    if flood_p > 0.60 and any(int(_value(r, "floor", 1) or 1) <= 1 for r in bedrooms):
        raw_score -= 30.0
        penalties.append("High flood probability with bedroom(s) on floor 1 (-30)")
        recs.append("Move bedrooms/living spaces to upper floors in high flood zones.")

    elevated_config = any(int(_value(r, "floor", 1) or 1) >= 2 for r in rooms)
    if elevation < 3.0 and not elevated_config:
        raw_score -= 20.0
        penalties.append("Very low elevation without elevated room configuration (-20)")
        recs.append("Adopt elevated plinth or split-level layout for low-elevation sites.")

    if rainfall > 2500.0 and not courtyard_void:
        raw_score -= 10.0
        penalties.append("High rainfall site lacks drainage courtyard/void feature (-10)")
        recs.append("Add a courtyard/drainage void to improve stormwater handling.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Flood risk tier: {risk.upper()} (p={flood_p:.2f})")
    findings.append(f"Habitable room flood-placement score: {score_a:.1f}")
    findings.append(f"Service-room flood positioning score: {score_b:.1f}")
    findings.append(f"Flood-resilient feature score: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Increase vertical separation between habitable zones and flood-exposed levels.")
    if score_b < 60.0:
        recs.append("Elevate kitchens in high-risk plots and reserve ground floor for service uses.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=5,
        name="Flood Resilience & Elevation",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["flood_probability", "elevation", "rainfall_mm", "room floor"],
        standard_ref="FEMA Hazard Mitigation Standards + NBC India Flood Zone Guidelines",
    )


def check_natural_daylighting(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 6 - LEED BD&C v4 Daylight Credit (sDA 300/50%)"""
    weight = CRITERION_WEIGHTS[6]
    threshold = 65.0

    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    sun_hours = _safe_float(env.get("sun_exposure_hours"), 8.0)
    climate = classify_climate(_safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0))

    habitable = [r for r in rooms if _room_type(r) in HABITABLE_TYPES]
    if habitable:
        daylit_count = 0
        bilateral_count = 0
        room_wfr_scores: List[float] = []

        bedroom_dark = False
        living_overglazed_hot = False

        for room in habitable:
            r_windows = _room_windows(room, windows)
            head_height = max((_safe_float(_value(w, "head_height", 2.1), 2.1) for w in r_windows), default=2.1)
            depth = min(_safe_float(_value(room, "width", 0.0), 0.0), _safe_float(_value(room, "height", 0.0), 0.0))
            if depth <= 2.5 * head_height:
                daylit_count += 1

            w_area = sum(_window_area(w) for w in r_windows)
            wfr = w_area / max(_room_area(room), 1e-6)

            if 0.15 <= wfr <= 0.25:
                wfr_score = 100.0
            elif wfr < 0.15:
                wfr_score = _clamp(100.0 - (0.15 - wfr) * 500.0, 0.0, 100.0)
            else:
                wfr_score = _clamp(100.0 - (wfr - 0.25) * 350.0, 0.0, 100.0)
            room_wfr_scores.append(wfr_score)

            faces = _room_window_faces(room, windows)
            if len(faces) >= 2:
                bilateral_count += 1

            if _room_type(room) == "bedroom" and wfr < 0.08:
                bedroom_dark = True
            if _room_type(room) == "living" and climate == "hot" and wfr > 0.40:
                living_overglazed_hot = True

        score_a = 100.0 * daylit_count / len(habitable)
        score_b = sum(room_wfr_scores) / max(1, len(room_wfr_scores))
        score_c = 100.0 * bilateral_count / len(habitable)
    else:
        score_a = 60.0
        score_b = 60.0
        score_c = 60.0
        bedroom_dark = False
        living_overglazed_hot = False

    raw_score = 0.40 * score_a + 0.35 * score_b + 0.25 * score_c

    if bedroom_dark:
        raw_score -= 15.0
        penalties.append("At least one bedroom has WFR below 0.08 (-15)")
        recs.append("Increase bedroom glazing to reach at least 8% window-to-floor ratio.")

    if living_overglazed_hot:
        raw_score -= 10.0
        penalties.append("Living room WFR exceeds 0.40 in hot climate (-10)")
        recs.append("Reduce living-room glazing or add shading in hot climates.")

    top_floor = max((int(_value(r, "floor", 1) or 1) for r in rooms), default=1)
    has_skylight_like = any(
        int(_value(w, "floor", 1) or 1) == top_floor
        and (
            "roof" in str(_value(w, "wall", "")).lower()
            or _safe_float(_value(w, "head_height", 0.0), 0.0) >= 2.6
        )
        for w in windows
    )
    if sun_hours < 6.0 and not has_skylight_like:
        raw_score -= 10.0
        penalties.append("Low sun exposure with no skylight/roof-light provision (-10)")
        recs.append("Add skylights/roof lights to improve daylight autonomy in low-sun sites.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Daylight depth compliance: {score_a:.1f}")
    findings.append(f"Habitable-room WFR quality score: {score_b:.1f}")
    findings.append(f"Bilateral daylighting compliance: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Increase window head heights or reduce room depth in under-daylit rooms.")
    if score_b < 60.0:
        recs.append("Tune habitable-room WFR to the 0.15-0.25 target range.")
    if score_c < 60.0:
        recs.append("Provide openings on at least two facades for major habitable rooms.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=6,
        name="Natural Daylighting",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["sun_exposure_hours", "solar_radiation_kwh", "windows", "room geometry"],
        standard_ref="LEED BD&C v4 Daylight Credit (sDA 300/50%)",
    )


def check_tree_preservation(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 7 - LEED v4 Sustainable Sites + NBC India Green"""
    weight = CRITERION_WEIGHTS[7]
    threshold = 55.0

    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    climate = classify_climate(_safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0))
    ndvi = _safe_float(env.get("ndvi"), 0.3)
    plot_area = _safe_float(env.get("plot_area_sqm"), 0.0)

    tree_points = _tree_points_local(env, rooms)

    violated = 0
    protected_violations = 0
    for tree in tree_points:
        if tree["confidence"] <= 0.5:
            continue
        overlap = any(_rect_circle_overlap_room(room, tree["x"], tree["y"], tree["radius"]) for room in rooms)
        if overlap:
            violated += 1
            if tree["radius"] > 5.0:
                protected_violations += 1

    score_a = _clamp(100.0 - violated * 25.0, 0.0, 100.0)

    min_x, min_y, max_x, max_y = _bounds(rooms)
    west_shade_trees = sum(
        1
        for t in tree_points
        if abs(t["x"] - min_x) <= 5.0 and (min_y - 5.0) <= t["y"] <= (max_y + 5.0)
    )

    if climate == "cold":
        solar_face = "S" if _safe_float(env.get("lat"), 0.0) >= 0 else "N"
        near_solar = sum(1 for t in tree_points if _tree_near_face(t, solar_face, min_x, min_y, max_x, max_y, 5.0))
        score_b = _clamp(100.0 - near_solar * 25.0 + west_shade_trees * 10.0, 0.0, 100.0)
    else:
        score_b = _clamp(min(100.0, west_shade_trees * 30.0), 0.0, 100.0)

    if ndvi >= 0.5:
        ndvi_score = 100.0
    elif ndvi >= 0.3:
        ndvi_score = 60.0
    elif ndvi >= 0.1:
        ndvi_score = 30.0
    else:
        ndvi_score = 0.0

    footprint = building_footprint_area(rooms)
    green_ratio = 1.0 - (footprint / max(plot_area, 1e-6)) if plot_area > 0 else 0.0
    green_score = _clamp(green_ratio * 500.0, 0.0, 100.0)
    score_c = 0.5 * ndvi_score + 0.5 * green_score

    raw_score = 0.50 * score_a + 0.30 * score_b + 0.20 * score_c

    if protected_violations > 0:
        penalty_val = 25.0 * protected_violations
        raw_score -= penalty_val
        penalties.append(f"Protected tree overlap violations: {protected_violations} tree(s) (-{penalty_val:.0f})")
        recs.append("Shift building footprint away from protected canopy zones.")

    if ndvi > 0.6 and plot_area > 0 and footprint > 0.60 * plot_area:
        raw_score -= 10.0
        penalties.append("Dense vegetation site with footprint >60% of plot (-10)")
        recs.append("Reduce footprint to preserve more green cover in high-NDVI contexts.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Tree canopy overlap violations: {violated} (sub-score {score_a:.1f})")
    findings.append(f"West-facade shade-tree count: {west_shade_trees} (sub-score {score_b:.1f})")
    findings.append(f"Vegetation/green-buffer context score: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Avoid placing rooms within detected tree canopy radii.")
    if score_b < 60.0 and climate != "cold":
        recs.append("Retain or introduce west-side shade trees for passive summer cooling.")
    if score_c < 60.0:
        recs.append("Reserve at least 20% of plot area as permeable green buffer.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=7,
        name="Tree Preservation & Green Buffer",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["tree_coordinates", "ndvi", "plot_polygon", "plot_area_sqm"],
        standard_ref="LEED v4 Sustainable Sites + NBC India Green Building Norms",
    )


def check_soil_foundation(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 8 - NBC India 2016 Foundation + SoilGrids"""
    weight = CRITERION_WEIGHTS[8]
    threshold = 50.0

    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    clay = _safe_float(env.get("clay_pct"), 25.0)
    slope = _safe_float(env.get("slope"), 5.0)
    soil_ph = _safe_float(env.get("soil_ph"), 6.8)
    bulk_density = _safe_float(env.get("bulk_density"), 1.4)

    if clay < 25.0:
        score_a = 100.0
    elif clay <= 45.0:
        score_a = 70.0
    else:
        score_a = 40.0

    max_floor = max((int(_value(r, "floor", 1) or 1) for r in rooms), default=1)
    if slope <= 5.0:
        score_b = 100.0
    elif slope <= 12.0:
        score_b = _clamp(80.0 - (slope - 5.0) * 4.0, 0.0, 100.0)
        if max_floor == 1:
            score_b = _clamp(score_b - 10.0, 0.0, 100.0)
            penalties.append("Gentle slope site with single-story layout loses stepped-foundation efficiency (-10)")
            recs.append("Use split-level or multi-floor organization on sloped sites.")
    else:
        score_b = _clamp(max(20.0, 60.0 - (slope - 12.0) * 5.0), 0.0, 100.0)

    if 6.0 <= soil_ph <= 7.5:
        ph_score = 100.0
    elif (5.0 <= soil_ph < 6.0) or (7.5 < soil_ph <= 8.5):
        ph_score = 65.0
    else:
        ph_score = 30.0

    score_c = ph_score
    if 1.0 <= bulk_density <= 1.6:
        score_c = _clamp(score_c + 10.0, 0.0, 100.0)
        bonuses.append("Bulk density is in favorable compaction range (+10)")

    raw_score = 0.50 * score_a + 0.30 * score_b + 0.20 * score_c
    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Clay-content foundation suitability sub-score: {score_a:.1f}")
    findings.append(f"Slope-efficiency sub-score: {score_b:.1f}")
    findings.append(f"Soil chemistry/density sub-score: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Use raft or reinforced foundation strategy for high-clay soils.")
    if score_b < 60.0:
        recs.append("Adopt stepped/split-level foundation strategy for sloped terrain.")
    if score_c < 60.0:
        recs.append("Prefer durable conventional materials where soil pH is outside natural-material range.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=8,
        name="Soil Suitability & Foundation Eco",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["clay_pct", "soil_ph", "bulk_density", "slope"],
        standard_ref="NBC India 2016 Foundation Chapter + SoilGrids ISRIC",
    )


def check_renewable_readiness(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 9 - LEED BD&C v4 Renewable Energy + MNRE India"""
    weight = CRITERION_WEIGHTS[9]
    threshold = 45.0

    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    solar_kwh = _safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0)
    rainfall_mm = _safe_float(env.get("rainfall_mm"), 1000.0)
    slope = _safe_float(env.get("slope"), 5.0)
    plot_area = _safe_float(env.get("plot_area_sqm"), 200.0)

    top_floor = max((int(_value(r, "floor", 1) or 1) for r in rooms), default=1)
    roof_rooms = [r for r in rooms if int(_value(r, "floor", 1) or 1) == top_floor]
    net_roof_m2 = sum(_room_area(r) for r in roof_rooms)

    potential_kw = net_roof_m2 * 0.15 * solar_kwh
    annual_solar_kwh = potential_kw * 365.0 * solar_kwh
    annual_demand = max(1e-6, plot_area * 30.0)
    score_a = _clamp((annual_solar_kwh / annual_demand) * 100.0, 0.0, 100.0)

    min_x, min_y, max_x, max_y = _bounds(rooms)
    axis_bearing = 90.0 if (max_x - min_x) >= (max_y - min_y) else 0.0
    axis_deviation = min(angle_diff(axis_bearing, 90.0), angle_diff(axis_bearing, 270.0))
    score_b = _clamp(math.cos(math.radians(axis_deviation)) * 100.0, 0.0, 100.0)

    bedrooms = [r for r in rooms if _room_type(r) == "bedroom"]
    n_occupants = max(2, len(bedrooms) * 2)
    annual_rainwater_l = net_roof_m2 * rainfall_mm * 0.001 * 0.85 * 1000.0
    household_demand_l = n_occupants * 150.0 * 365.0
    harvesting_ratio = annual_rainwater_l / max(household_demand_l, 1e-6)
    score_c = _clamp(harvesting_ratio * 100.0, 0.0, 100.0)

    raw_score = 0.40 * score_a + 0.35 * score_b + 0.25 * score_c

    max_floor = max((int(_value(r, "floor", 1) or 1) for r in rooms), default=1)
    if slope > 20.0 and max_floor < 2:
        raw_score -= 15.0
        penalties.append("Steep slope >20 deg without split-level design (-15)")
        recs.append("Use split-level massing on steep sites to improve renewable integration.")

    if axis_deviation > 45.0:
        raw_score -= 10.0
        penalties.append("Building axis deviates >45 deg from PV-optimal orientation (-10)")
        recs.append("Rotate major roof axis closer to east-west for better PV yield.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Roof solar potential readiness score: {score_a:.1f}")
    findings.append(f"PV orientation readiness score: {score_b:.1f}")
    findings.append(f"Rainwater harvesting readiness score: {score_c:.1f}")

    if score_a < 60.0:
        recs.append("Increase unobstructed roof area on the top floor for future PV layout.")
    if score_c < 60.0:
        recs.append("Design roof drainage/storage to improve rainwater harvesting ratio.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=9,
        name="Renewable Energy Readiness",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["solar_radiation_kwh", "rainfall_mm", "slope", "plot_area_sqm"],
        standard_ref="LEED BD&C v4 Renewable Energy Credit + MNRE India Solar Guidelines",
    )


def check_indoor_air_quality(rooms: Sequence[Any], windows: Sequence[Any], env: dict) -> CriterionResult:
    """Criterion 10 - WELL Building Standard v2 + LEED IEQ"""
    weight = CRITERION_WEIGHTS[10]
    threshold = 50.0

    findings: List[str] = []
    penalties: List[str] = []
    bonuses: List[str] = []
    recs: List[str] = []

    ndvi = _safe_float(env.get("ndvi"), 0.3)
    distance_to_water = _safe_float(env.get("distance_to_water_m"), 2000.0)

    total_rooms = max(1, len(rooms))
    rooms_with_windows = 0
    no_window_rooms: List[Any] = []
    for room in rooms:
        if _room_windows(room, windows):
            rooms_with_windows += 1
        else:
            no_window_rooms.append(room)

    score_a = 100.0 * rooms_with_windows / total_rooms

    total_window_area = sum(_window_area(w) for w in windows)
    total_floor_area = max(1e-6, sum(_room_area(r) for r in rooms))
    ratio = total_window_area / total_floor_area

    if 0.08 <= ratio <= 0.12:
        score_b = 100.0
    elif ratio < 0.04:
        score_b = 0.0
    elif ratio < 0.08:
        score_b = _clamp((ratio - 0.04) / 0.04 * 100.0, 0.0, 100.0)
    else:
        score_b = _clamp(100.0 - (ratio - 0.12) * 450.0, 0.0, 100.0)

    ndvi_component = _clamp(ndvi * 160.0, 0.0, 100.0)
    water_component = _clamp(100.0 - distance_to_water / 10.0, 0.0, 100.0)
    score_c = 0.5 * ndvi_component + 0.5 * water_component

    raw_score = 0.40 * score_a + 0.30 * score_b + 0.30 * score_c

    if no_window_rooms:
        raw_score -= 20.0
        penalties.append("At least one room has no openable window (-20)")
        recs.append("Ensure every room has at least one operable exterior opening.")

    bathrooms = [r for r in rooms if _room_type(r) == "bathroom"]
    if any(not _room_windows(b, windows) for b in bathrooms):
        raw_score -= 10.0
        penalties.append("Bathroom without window detected (-10)")
        recs.append("Add operable bathroom windows to reduce moisture and mold risk.")

    score = _clamp(raw_score, 0.0, 100.0)

    findings.append(f"Room-level window completeness score: {score_a:.1f}")
    findings.append(f"Operable window area ratio score: {score_b:.1f} (ratio {ratio:.3f})")
    findings.append(f"Biophilic context score: {score_c:.1f}")

    if score_b < 60.0:
        recs.append("Target 8-12% operable window area relative to floor area.")
    if score_c < 60.0:
        recs.append("Strengthen visual/physical links to vegetation and water features where possible.")

    recs = _dedupe_limit(recs, 3)

    return _build_result(
        criterion_id=10,
        name="Indoor Air Quality & Biophilic Design",
        score=score,
        threshold=threshold,
        weight=weight,
        sub_scores={"A": round(score_a, 2), "B": round(score_b, 2), "C": round(score_c, 2)},
        findings=findings,
        penalties=penalties,
        bonuses=bonuses,
        recommendations=recs,
        data_sources=["windows", "ndvi", "distance_to_water_m"],
        standard_ref="WELL Building Standard v2 Air Concept + LEED IEQ Credit",
    )


def run_eco_audit(
    variant_id: int,
    algorithm: str,
    rooms: list,
    walls: list,
    doors: list,
    windows: list,
    env: dict,
) -> EcoAuditReport:
    """Run all 10 criteria and produce the full EcoAuditReport."""

    criteria_fns = [
        check_passive_solar_orientation,
        check_natural_ventilation,
        check_building_compactness,
        check_thermal_zoning,
        check_flood_resilience,
        check_natural_daylighting,
        check_tree_preservation,
        check_soil_foundation,
        check_renewable_readiness,
        check_indoor_air_quality,
    ]

    results: List[CriterionResult] = []
    for idx, fn in enumerate(criteria_fns, start=1):
        try:
            result = fn(rooms, windows, env)
        except Exception as exc:
            weight = CRITERION_WEIGHTS[idx]
            result = CriterionResult(
                criterion_id=idx,
                criterion_name=_fn_to_name(fn.__name__),
                score=50.0,
                weight=weight,
                weighted_score=50.0 * weight,
                passed=True,
                pass_threshold=50.0,
                sub_scores={},
                findings=[f"Evaluation error: {str(exc)}"],
                penalties_applied=[],
                bonuses_applied=[],
                recommendations=["Re-run analysis with complete environmental data"],
                data_sources=[],
                standard_ref="N/A",
            )
        results.append(result)

    composite = sum(r.weighted_score for r in results)
    n_passed = sum(1 for r in results if r.passed)
    climate = classify_climate(_safe_float(env.get("solar_radiation_kwh", env.get("solar_radiation", 5.0)), 5.0))
    flood_p = _safe_float(env.get("flood_probability"), 0.3)
    risk = "high" if flood_p > 0.6 else ("moderate" if flood_p >= 0.3 else "low")

    sorted_by_score = sorted(results, key=lambda r: r.score, reverse=True)
    grade = _grade_for_score(composite)

    failed = [r for r in results if not r.passed]
    failed_sorted = sorted(
        failed,
        key=lambda r: ((max(0.0, r.pass_threshold - r.score) * r.weight), r.weight, -r.score),
        reverse=True,
    )

    priority_fixes: List[str] = []
    for r in failed_sorted:
        if len(priority_fixes) >= 5:
            break
        rec = r.recommendations[0] if r.recommendations else "Improve this criterion using climate-appropriate design adjustments."
        priority_fixes.append(f"[{r.criterion_name}] {rec}")

    if len(priority_fixes) < 5:
        for r in sorted(results, key=lambda x: x.score):
            if len(priority_fixes) >= 5:
                break
            if r.passed:
                continue
            candidate = f"[{r.criterion_name}] Improve score from {r.score:.1f} toward {r.pass_threshold:.1f}."
            if candidate not in priority_fixes:
                priority_fixes.append(candidate)

    citations = sorted({r.standard_ref for r in results if r.standard_ref})
    data_quality = verify_live_data(env)

    return EcoAuditReport(
        variant_id=int(variant_id),
        algorithm=str(algorithm or "GA"),
        timestamp=datetime.utcnow().isoformat() + "Z",
        criteria=results,
        composite_eco_score=round(composite, 2),
        grade=grade,
        overall_passed=n_passed >= 7,
        n_criteria_passed=n_passed,
        n_criteria_failed=10 - n_passed,
        critical_failures=[r.criterion_name for r in results if r.score < 40.0],
        top_strengths=[r.criterion_name for r in sorted_by_score[:3]],
        top_weaknesses=[r.criterion_name for r in sorted_by_score[-3:]],
        priority_fixes=priority_fixes,
        climate_context=climate,
        site_risk_level=risk,
        compliance_citations=citations,
        data_quality=data_quality,
    )


def _fn_to_name(fn_name: str) -> str:
    mapping = {
        "check_passive_solar_orientation": "Passive Solar Orientation",
        "check_natural_ventilation": "Natural Cross-Ventilation",
        "check_building_compactness": "Building Compactness & Efficiency",
        "check_thermal_zoning": "Thermal Zoning & Buffer Layout",
        "check_flood_resilience": "Flood Resilience & Elevation",
        "check_natural_daylighting": "Natural Daylighting",
        "check_tree_preservation": "Tree Preservation & Green Buffer",
        "check_soil_foundation": "Soil Suitability & Foundation Eco",
        "check_renewable_readiness": "Renewable Energy Readiness",
        "check_indoor_air_quality": "Indoor Air Quality & Biophilic Design",
    }
    return mapping.get(fn_name, fn_name.replace("check_", "").replace("_", " ").title())


def _grade_for_score(score: float) -> str:
    if score >= 85.0:
        return "A+"
    if score >= 75.0:
        return "A"
    if score >= 68.0:
        return "B+"
    if score >= 60.0:
        return "B"
    if score >= 52.0:
        return "C+"
    if score >= 45.0:
        return "C"
    if score >= 35.0:
        return "D"
    return "F"


def _build_result(
    criterion_id: int,
    name: str,
    score: float,
    threshold: float,
    weight: float,
    sub_scores: Dict[str, float],
    findings: List[str],
    penalties: List[str],
    bonuses: List[str],
    recommendations: List[str],
    data_sources: List[str],
    standard_ref: str,
) -> CriterionResult:
    score_c = round(_clamp(score, 0.0, 100.0), 2)
    return CriterionResult(
        criterion_id=criterion_id,
        criterion_name=name,
        score=score_c,
        weight=weight,
        weighted_score=round(score_c * weight, 4),
        passed=score_c >= threshold,
        pass_threshold=threshold,
        sub_scores={k: round(_clamp(v, 0.0, 100.0), 2) for k, v in sub_scores.items()},
        findings=findings,
        penalties_applied=penalties,
        bonuses_applied=bonuses,
        recommendations=_dedupe_limit(recommendations, 3),
        data_sources=_dedupe_limit(data_sources, 8),
        standard_ref=standard_ref,
    )


def _value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return float(default)
        return float(value)
    except Exception:
        return float(default)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _room_id(room: Any) -> str:
    rid = _value(room, "id", "")
    if rid is None:
        rid = ""
    return str(rid)


def _room_type(room: Any) -> str:
    return str(_value(room, "type", "") or "").strip().lower()


def _room_area(room: Any) -> float:
    return max(0.0, _safe_float(_value(room, "width", 0.0), 0.0) * _safe_float(_value(room, "height", 0.0), 0.0))


def _room_centroid(room: Any) -> Tuple[float, float]:
    x = _safe_float(_value(room, "x", 0.0), 0.0)
    y = _safe_float(_value(room, "y", 0.0), 0.0)
    w = _safe_float(_value(room, "width", 0.0), 0.0)
    h = _safe_float(_value(room, "height", 0.0), 0.0)
    return (x + 0.5 * w, y + 0.5 * h)


def _distance(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _bounds(rooms: Sequence[Any]) -> Tuple[float, float, float, float]:
    if not rooms:
        return (0.0, 0.0, 0.0, 0.0)
    min_x = min(_safe_float(_value(r, "x", 0.0), 0.0) for r in rooms)
    min_y = min(_safe_float(_value(r, "y", 0.0), 0.0) for r in rooms)
    max_x = max(_safe_float(_value(r, "x", 0.0), 0.0) + _safe_float(_value(r, "width", 0.0), 0.0) for r in rooms)
    max_y = max(_safe_float(_value(r, "y", 0.0), 0.0) + _safe_float(_value(r, "height", 0.0), 0.0) for r in rooms)
    return (min_x, min_y, max_x, max_y)


def _normalize_face(face: str) -> str:
    raw = str(face or "").strip().upper()
    if raw in {"TOP", "NORTH", "N"}:
        return "N"
    if raw in {"BOTTOM", "SOUTH", "S"}:
        return "S"
    if raw in {"LEFT", "WEST", "W"}:
        return "W"
    if raw in {"RIGHT", "EAST", "E"}:
        return "E"
    return raw if raw in {"N", "E", "S", "W"} else ""


def _parse_window_wall(wall: str) -> Tuple[str, str]:
    text = str(wall or "")
    parts = text.split("_") if text else []
    if not parts:
        return ("", "")
    if parts[-1].lower() == "vent" and len(parts) >= 2:
        face = parts[-2]
        room_id = "_".join(parts[:-2])
    else:
        face = parts[-1]
        room_id = "_".join(parts[:-1])
    return (room_id, _normalize_face(face))


def _window_area(window: Any) -> float:
    width = _safe_float(_value(window, "width", 0.0), 0.0)
    sill = _safe_float(_value(window, "sill_height", 0.0), 0.0)
    head = _safe_float(_value(window, "head_height", 0.0), 0.0)
    return max(0.0, width * max(0.0, head - sill))


def _room_windows(room: Any, windows: Sequence[Any]) -> List[Any]:
    rid = _room_id(room)
    rtype = _room_type(room)
    out: List[Any] = []
    for w in windows:
        wrid, _ = _parse_window_wall(str(_value(w, "wall", "")))
        if rid and wrid == rid:
            out.append(w)
        elif not rid and rtype and wrid.startswith(rtype):
            out.append(w)
    return out


def _room_window_faces(room: Any, windows: Sequence[Any]) -> set[str]:
    faces: set[str] = set()
    for w in _room_windows(room, windows):
        _, face = _parse_window_wall(str(_value(w, "wall", "")))
        if face:
            faces.add(face)
    return faces


def _window_area_by_cardinal_face(windows: Sequence[Any]) -> Dict[str, float]:
    acc = {"N": 0.0, "E": 0.0, "S": 0.0, "W": 0.0}
    for w in windows:
        _, face = _parse_window_wall(str(_value(w, "wall", "")))
        if face in acc:
            acc[face] += _window_area(w)
    return acc


def _bearing_to_cardinal(bearing: float) -> str:
    best = "N"
    best_d = 1e9
    for face, fb in CARDINAL_BEARINGS.items():
        d = angle_diff(bearing, fb)
        if d < best_d:
            best = face
            best_d = d
    return best


def _faces_within_bearing(target_bearing: float, tolerance: float) -> set[str]:
    return {face for face, fb in CARDINAL_BEARINGS.items() if angle_diff(fb, target_bearing) <= tolerance}


def _has_perpendicular_faces(faces: Iterable[str]) -> bool:
    fset = set(faces)
    return bool((fset & {"N", "S"}) and (fset & {"E", "W"}))


def _room_on_face(room: Any, face: str, all_rooms: Sequence[Any]) -> bool:
    min_x, min_y, max_x, max_y = _bounds(all_rooms)
    tol = max((max_x - min_x), (max_y - min_y)) * 0.08
    x = _safe_float(_value(room, "x", 0.0), 0.0)
    y = _safe_float(_value(room, "y", 0.0), 0.0)
    w = _safe_float(_value(room, "width", 0.0), 0.0)
    h = _safe_float(_value(room, "height", 0.0), 0.0)

    f = _normalize_face(face)
    if f == "N":
        return y <= min_y + tol
    if f == "S":
        return y + h >= max_y - tol
    if f == "W":
        return x <= min_x + tol
    if f == "E":
        return x + w >= max_x - tol
    return False


def _room_on_any_face(room: Any, faces: set[str], all_rooms: Sequence[Any]) -> bool:
    return any(_room_on_face(room, f, all_rooms) for f in faces)


def _rooms_adjacent(a: Any, b: Any, tol: float = 0.12) -> bool:
    ax = _safe_float(_value(a, "x", 0.0), 0.0)
    ay = _safe_float(_value(a, "y", 0.0), 0.0)
    aw = _safe_float(_value(a, "width", 0.0), 0.0)
    ah = _safe_float(_value(a, "height", 0.0), 0.0)

    bx = _safe_float(_value(b, "x", 0.0), 0.0)
    by = _safe_float(_value(b, "y", 0.0), 0.0)
    bw = _safe_float(_value(b, "width", 0.0), 0.0)
    bh = _safe_float(_value(b, "height", 0.0), 0.0)

    overlap_x = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    overlap_y = max(0.0, min(ay + ah, by + bh) - max(ay, by))

    vertical_touch = (abs((ax + aw) - bx) <= tol or abs((bx + bw) - ax) <= tol) and overlap_y > 0.15
    horizontal_touch = (abs((ay + ah) - by) <= tol or abs((by + bh) - ay) <= tol) and overlap_x > 0.15
    return vertical_touch or horizontal_touch


def _courtyard_or_void_area(rooms: Sequence[Any]) -> float:
    if not rooms:
        return 0.0
    min_x, min_y, max_x, max_y = _bounds(rooms)
    bbox_area = max(0.0, (max_x - min_x) * (max_y - min_y))
    room_area = sum(_room_area(r) for r in rooms)
    return max(0.0, bbox_area - room_area)


def _estimated_external_segments(rooms: Sequence[Any]) -> List[Tuple[str, float, float, float]]:
    """Return merged external segments as tuples (orientation, fixed, start, end)."""
    floor_rooms = [r for r in rooms if int(_value(r, "floor", 1) or 1) == 1]
    if not floor_rooms:
        floor_rooms = list(rooms)

    eps = 0.10
    horiz: List[Tuple[float, float, float]] = []  # y, x1, x2
    vert: List[Tuple[float, float, float]] = []   # x, y1, y2

    for room in floor_rooms:
        x = _safe_float(_value(room, "x", 0.0), 0.0)
        y = _safe_float(_value(room, "y", 0.0), 0.0)
        w = _safe_float(_value(room, "width", 0.0), 0.0)
        h = _safe_float(_value(room, "height", 0.0), 0.0)

        edges = [
            ("H", y, x, x + w),
            ("H", y + h, x, x + w),
            ("V", x, y, y + h),
            ("V", x + w, y, y + h),
        ]

        for ori, fixed, s0, s1 in edges:
            shared = False
            for other in floor_rooms:
                if _room_id(other) == _room_id(room):
                    continue
                ox = _safe_float(_value(other, "x", 0.0), 0.0)
                oy = _safe_float(_value(other, "y", 0.0), 0.0)
                ow = _safe_float(_value(other, "width", 0.0), 0.0)
                oh = _safe_float(_value(other, "height", 0.0), 0.0)

                if ori == "H":
                    other_edges = [
                        (oy, ox, ox + ow),
                        (oy + oh, ox, ox + ow),
                    ]
                    for ofixed, os0, os1 in other_edges:
                        if abs(ofixed - fixed) <= eps and max(0.0, min(s1, os1) - max(s0, os0)) > 0.15:
                            shared = True
                            break
                else:
                    other_edges = [
                        (ox, oy, oy + oh),
                        (ox + ow, oy, oy + oh),
                    ]
                    for ofixed, os0, os1 in other_edges:
                        if abs(ofixed - fixed) <= eps and max(0.0, min(s1, os1) - max(s0, os0)) > 0.15:
                            shared = True
                            break
                if shared:
                    break

            if not shared:
                if ori == "H":
                    horiz.append((fixed, min(s0, s1), max(s0, s1)))
                else:
                    vert.append((fixed, min(s0, s1), max(s0, s1)))

    merged: List[Tuple[str, float, float, float]] = []

    for y in sorted({round(v[0], 3) for v in horiz}):
        parts = sorted([(s0, s1) for fy, s0, s1 in horiz if abs(fy - y) <= eps], key=lambda t: t[0])
        if not parts:
            continue
        cur_s, cur_e = parts[0]
        for s0, s1 in parts[1:]:
            if s0 <= cur_e + eps:
                cur_e = max(cur_e, s1)
            else:
                merged.append(("H", y, cur_s, cur_e))
                cur_s, cur_e = s0, s1
        merged.append(("H", y, cur_s, cur_e))

    for x in sorted({round(v[0], 3) for v in vert}):
        parts = sorted([(s0, s1) for fx, s0, s1 in vert if abs(fx - x) <= eps], key=lambda t: t[0])
        if not parts:
            continue
        cur_s, cur_e = parts[0]
        for s0, s1 in parts[1:]:
            if s0 <= cur_e + eps:
                cur_e = max(cur_e, s1)
            else:
                merged.append(("V", x, cur_s, cur_e))
                cur_s, cur_e = s0, s1
        merged.append(("V", x, cur_s, cur_e))

    return merged


def _estimated_external_perimeter(rooms: Sequence[Any]) -> float:
    segs = _estimated_external_segments(rooms)
    perimeter = 0.0
    for ori, _fixed, s0, s1 in segs:
        perimeter += max(0.0, s1 - s0)
    return perimeter


def _estimated_external_corners(rooms: Sequence[Any]) -> int:
    segs = _estimated_external_segments(rooms)
    if not segs:
        return 4

    endpoint_types: Dict[Tuple[int, int], Dict[str, int]] = {}

    for ori, fixed, s0, s1 in segs:
        if ori == "H":
            pts = [(s0, fixed), (s1, fixed)]
        else:
            pts = [(fixed, s0), (fixed, s1)]

        for px, py in pts:
            key = (int(round(px * 100)), int(round(py * 100)))
            if key not in endpoint_types:
                endpoint_types[key] = {"H": 0, "V": 0}
            endpoint_types[key][ori] += 1

    corners = sum(1 for val in endpoint_types.values() if val["H"] > 0 and val["V"] > 0)
    return max(4, corners)


def _garage_blocks_solar(garages: Sequence[Any], livings: Sequence[Any], rooms: Sequence[Any], solar_face: str) -> bool:
    min_x, min_y, max_x, max_y = _bounds(rooms)

    def face_distance(room: Any, face: str) -> float:
        x = _safe_float(_value(room, "x", 0.0), 0.0)
        y = _safe_float(_value(room, "y", 0.0), 0.0)
        w = _safe_float(_value(room, "width", 0.0), 0.0)
        h = _safe_float(_value(room, "height", 0.0), 0.0)
        if face == "S":
            return max_y - (y + h)
        if face == "N":
            return y - min_y
        if face == "E":
            return max_x - (x + w)
        if face == "W":
            return x - min_x
        return 0.0

    def span_overlap(a: Any, b: Any, face: str) -> bool:
        ax = _safe_float(_value(a, "x", 0.0), 0.0)
        ay = _safe_float(_value(a, "y", 0.0), 0.0)
        aw = _safe_float(_value(a, "width", 0.0), 0.0)
        ah = _safe_float(_value(a, "height", 0.0), 0.0)

        bx = _safe_float(_value(b, "x", 0.0), 0.0)
        by = _safe_float(_value(b, "y", 0.0), 0.0)
        bw = _safe_float(_value(b, "width", 0.0), 0.0)
        bh = _safe_float(_value(b, "height", 0.0), 0.0)

        if face in {"N", "S"}:
            return max(0.0, min(ax + aw, bx + bw) - max(ax, bx)) > 0.20
        return max(0.0, min(ay + ah, by + bh) - max(ay, by)) > 0.20

    for g in garages:
        for l in livings:
            if not span_overlap(g, l, solar_face):
                continue
            if face_distance(g, solar_face) < face_distance(l, solar_face):
                return True
    return False


def _tree_points_local(env: dict, rooms: Sequence[Any]) -> List[Dict[str, float]]:
    trees_raw = env.get("tree_coordinates")
    if not isinstance(trees_raw, list):
        return []

    out: List[Dict[str, float]] = []
    transform = _plot_geo_transform(env)

    if transform:
        for item in trees_raw:
            if not isinstance(item, dict):
                continue
            lon = _safe_float(item.get("lon"), float("nan"))
            lat = _safe_float(item.get("lat"), float("nan"))
            if math.isnan(lon) or math.isnan(lat):
                continue
            tx = (lon - transform["lon0"]) * transform["m_lon"] - transform["min_x"]
            ty = (lat - transform["lat0"]) * transform["m_lat"] - transform["min_y"]
            out.append(
                {
                    "x": tx,
                    "y": ty,
                    "radius": max(0.5, _safe_float(item.get("radius_m"), 2.5)),
                    "confidence": _clamp(_safe_float(item.get("confidence"), 0.8), 0.0, 1.0),
                }
            )
        if out:
            return out

    # Fallback: map tree lat/lon extents to room bounds when polygon transform is unavailable.
    coords = [item for item in trees_raw if isinstance(item, dict) and item.get("lat") is not None and item.get("lon") is not None]
    if not coords:
        return []

    min_x, min_y, max_x, max_y = _bounds(rooms)
    lats = [_safe_float(c.get("lat"), 0.0) for c in coords]
    lons = [_safe_float(c.get("lon"), 0.0) for c in coords]
    lon_min, lon_max = min(lons), max(lons)
    lat_min, lat_max = min(lats), max(lats)
    lon_span = max(1e-6, lon_max - lon_min)
    lat_span = max(1e-6, lat_max - lat_min)

    for item in coords:
        lon = _safe_float(item.get("lon"), lon_min)
        lat = _safe_float(item.get("lat"), lat_min)
        tx = min_x + ((lon - lon_min) / lon_span) * max(1e-6, max_x - min_x)
        ty = min_y + ((lat - lat_min) / lat_span) * max(1e-6, max_y - min_y)
        out.append(
            {
                "x": tx,
                "y": ty,
                "radius": max(0.5, _safe_float(item.get("radius_m"), 2.5)),
                "confidence": _clamp(_safe_float(item.get("confidence"), 0.8), 0.0, 1.0),
            }
        )
    return out


def _plot_geo_transform(env: dict) -> Optional[Dict[str, float]]:
    polygon = env.get("plot_polygon")
    if not isinstance(polygon, list) or len(polygon) < 3:
        return None

    pts: List[Tuple[float, float]] = []
    for p in polygon:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        lon = _safe_float(p[0], float("nan"))
        lat = _safe_float(p[1], float("nan"))
        if math.isnan(lon) or math.isnan(lat):
            continue
        pts.append((lon, lat))

    if len(pts) < 3:
        return None

    if not all(-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0 for lon, lat in pts):
        return None

    lon0 = sum(lon for lon, _lat in pts) / len(pts)
    lat0 = sum(lat for _lon, lat in pts) / len(pts)
    m_lon = 111320.0 * math.cos(math.radians(lat0))
    m_lat = 111320.0

    xs = [(lon - lon0) * m_lon for lon, _lat in pts]
    ys = [(lat - lat0) * m_lat for _lon, lat in pts]

    return {
        "lon0": lon0,
        "lat0": lat0,
        "m_lon": m_lon,
        "m_lat": m_lat,
        "min_x": min(xs),
        "min_y": min(ys),
    }


def _tree_near_face(tree: Dict[str, float], face: str, min_x: float, min_y: float, max_x: float, max_y: float, dist: float) -> bool:
    f = _normalize_face(face)
    if f == "N":
        return abs(tree["y"] - min_y) <= dist
    if f == "S":
        return abs(tree["y"] - max_y) <= dist
    if f == "W":
        return abs(tree["x"] - min_x) <= dist
    if f == "E":
        return abs(tree["x"] - max_x) <= dist
    return False


def _rect_circle_overlap_room(room: Any, cx: float, cy: float, radius: float) -> bool:
    x = _safe_float(_value(room, "x", 0.0), 0.0)
    y = _safe_float(_value(room, "y", 0.0), 0.0)
    w = _safe_float(_value(room, "width", 0.0), 0.0)
    h = _safe_float(_value(room, "height", 0.0), 0.0)

    nx = _clamp(cx, x, x + w)
    ny = _clamp(cy, y, y + h)
    return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius ** 2


def _dedupe_limit(items: Sequence[str], limit: int) -> list[str]:
    out: List[str] = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        if text in out:
            continue
        out.append(text)
        if len(out) >= limit:
            break
    return out
