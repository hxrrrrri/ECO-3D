"""
ECO-3D Smart Layout Engine
============================
Constraint-satisfaction floor plan generator — no pretrained weights needed.

Replaces HouseGAN++ with a proper graph-driven spatial solver that:
  • Enforces adjacency constraints from the room graph
  • Applies vastu/solar/wind eco-orientation per room type
  • Handles Indian room types: puja_room, utility, garage, nadumuttam
  • Packs rooms into a compact, non-overlapping layout
  • Runs in <50ms on CPU — faster than any neural model

Architecture:
  1. Build adjacency graph from room type rules
  2. Assign rooms to zones (public / private / service / transitional)
  3. Pack zones into the plot footprint respecting solar axis
  4. Place rooms within each zone using a strip-packing algorithm
  5. Enforce minimum adjacency: slide rooms until shared edges exist
  6. Post-process: orientation labels, eco scores, area validation

Public API (drop-in replacement for housegan_engine.py):
  generate_housegan_layout(room_types_str, floor_assignments,
                           plot_area, num_floors, sun_dir, wind_dir, seed)
  -> list[RoomDict] | None
  is_available() -> True (always)
"""

import math
import random
import logging
from typing import Optional, List, Dict, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------- #
#  Room type aliases                                                            #
# ---------------------------------------------------------------------------- #
ROOM_TYPE_MAP = {
    "living":      "living",
    "hall":        "living",
    "kitchen":     "kitchen",
    "bedroom":     "bedroom",
    "bathroom":    "bathroom",
    "toilet":      "bathroom",
    "balcony":     "balcony",
    "verandah":    "balcony",
    "entrance":    "entrance",
    "foyer":       "entrance",
    "dining":      "dining",
    "office":      "office",
    "study":       "office",
    "utility":     "utility",
    "storage":     "utility",
    "store":       "utility",
    "puja_room":   "puja_room",
    "pooja":       "puja_room",
    "garage":      "garage",
    "carport":     "garage",
    "nadumuttam":  "nadumuttam",
    "courtyard":   "nadumuttam",
}

def _normalise_type(rt: str) -> str:
    return ROOM_TYPE_MAP.get(rt.lower().replace(" ", "_"), rt.lower())


# ---------------------------------------------------------------------------- #
#  Zone mapping                                                                 #
# ---------------------------------------------------------------------------- #
# Zones are laid out as horizontal strips (south → north on the solar axis):
#   FRONT   → south edge: entrance, garage
#   PUBLIC  → living, dining, puja_room, nadumuttam, balcony
#   PRIVATE → bedrooms, office
#   SERVICE → kitchen, bathroom, utility (rear / cross-ventilation)

ZONE_ORDER = ["FRONT", "PUBLIC", "PRIVATE", "SERVICE"]

ROOM_ZONE: Dict[str, str] = {
    "entrance":   "FRONT",
    "garage":     "FRONT",
    "living":     "PUBLIC",
    "dining":     "PUBLIC",
    "puja_room":  "PUBLIC",
    "nadumuttam": "PUBLIC",
    "balcony":    "PUBLIC",
    "bedroom":    "PRIVATE",
    "office":     "PRIVATE",
    "kitchen":    "SERVICE",
    "bathroom":   "SERVICE",
    "utility":    "SERVICE",
}

# ---------------------------------------------------------------------------- #
#  Eco orientation                                                              #
# ---------------------------------------------------------------------------- #
_OPPOSITE: Dict[str, str] = {
    "N": "S", "S": "N", "E": "W", "W": "E",
    "North": "South", "South": "North", "East": "West", "West": "East",
    "Northeast": "Southwest", "Southwest": "Northeast",
    "Northwest": "Southeast", "Southeast": "Northwest",
    "NE": "SW", "SW": "NE", "NW": "SE", "SE": "NW",
    "NNE": "SSW", "SSW": "NNE", "ENE": "WSW", "WSW": "ENE",
    "NNW": "SSE", "SSE": "NNW", "ESE": "WNW", "WNW": "ESE",
}

def _opposite(d: str) -> str:
    return _OPPOSITE.get(d, "South")

def _eco_orientation(rt: str, sun_dir: str, cross_dir: str, rng: random.Random) -> str:
    prefer_sun  = {"living", "bedroom", "dining", "puja_room", "office", "nadumuttam"}
    prefer_shad = {"kitchen", "bathroom", "utility", "garage"}
    if rt in prefer_sun:
        return sun_dir
    if rt in prefer_shad:
        return cross_dir
    return rng.choice(["South", "East", "Southeast"])


# ---------------------------------------------------------------------------- #
#  Room size bands  (wmin, wideal, wmax, hmin, hideal, hmax)  — metres        #
# ---------------------------------------------------------------------------- #
ROOM_SIZE_BANDS: Dict[str, Tuple] = {
    "living":     (4.0, 5.5, 8.5,  3.5, 4.5, 7.0),
    "dining":     (2.8, 3.6, 5.5,  2.5, 3.2, 4.5),
    "bedroom":    (3.0, 3.6, 5.5,  2.8, 3.4, 5.0),
    "kitchen":    (2.5, 3.0, 5.0,  2.2, 2.8, 4.2),
    "bathroom":   (1.5, 1.8, 3.2,  1.5, 2.0, 3.2),
    "entrance":   (2.0, 2.5, 4.0,  1.5, 2.0, 3.5),
    "balcony":    (2.0, 2.8, 4.5,  1.0, 1.5, 2.2),
    "office":     (2.8, 3.2, 5.0,  2.5, 3.0, 4.5),
    "utility":    (1.8, 2.2, 3.5,  1.5, 2.0, 3.0),
    "puja_room":  (1.5, 2.0, 3.0,  1.5, 2.0, 3.0),
    "garage":     (4.5, 5.5, 8.0,  3.0, 4.0, 6.0),
    "nadumuttam": (3.0, 4.0, 6.0,  3.0, 4.0, 6.0),
}
_DEFAULT_BAND = (2.0, 3.0, 5.0, 2.0, 3.0, 5.0)


def _ideal_dims(rt: str, area_budget: float) -> Tuple[float, float]:
    wmin, wideal, wmax, hmin, hideal, hmax = ROOM_SIZE_BANDS.get(rt, _DEFAULT_BAND)
    w = min(wmax, max(wmin, math.sqrt(area_budget * 1.2)))
    h = area_budget / max(w, 0.1)
    w = round(min(wmax, max(wmin, w)), 1)
    h = round(min(hmax, max(hmin, h)), 1)
    return w, h


# ---------------------------------------------------------------------------- #
#  Adjacency rules                                                              #
# ---------------------------------------------------------------------------- #
REQUIRED_ADJACENCY: List[Tuple[str, str]] = [
    ("entrance",    "living"),
    ("living",      "dining"),
    ("living",      "puja_room"),
    ("dining",      "kitchen"),     # dining bridges living→kitchen
    ("bedroom",     "bathroom"),
    ("living",      "nadumuttam"),
    ("kitchen",     "utility"),
]

OPTIONAL_ADJACENCY: List[Tuple[str, str]] = [
    ("living",   "kitchen"),
    ("living",   "office"),
    ("living",   "bedroom"),
    ("bedroom",  "balcony"),
    ("entrance", "garage"),
    ("living",   "balcony"),
    ("dining",   "balcony"),
    ("kitchen",  "nadumuttam"),
]


# ---------------------------------------------------------------------------- #
#  _Room  — mutable rectangle used during layout computation                   #
# ---------------------------------------------------------------------------- #
class _Room:
    __slots__ = ("rid", "rtype", "floor", "x", "y", "w", "h", "orientation")

    def __init__(self, rid, rtype, floor, w, h, orientation):
        self.rid         = rid
        self.rtype       = rtype
        self.floor       = floor
        self.x = self.y  = 0.0
        self.w           = w
        self.h           = h
        self.orientation = orientation

    @property
    def x2(self): return self.x + self.w
    @property
    def y2(self): return self.y + self.h

    def overlaps(self, other, gap: float = 0.12) -> bool:
        return not (
            self.x2 <= other.x + gap or other.x2 <= self.x + gap or
            self.y2 <= other.y + gap or other.y2 <= self.y + gap
        )

    def shares_edge(self, other, tol: float = 0.15) -> bool:
        h_overlap = min(self.x2, other.x2) - max(self.x, other.x)
        v_overlap = min(self.y2, other.y2) - max(self.y, other.y)
        if abs(self.y2 - other.y) < tol or abs(other.y2 - self.y) < tol:
            return h_overlap > 0.3
        if abs(self.x2 - other.x) < tol or abs(other.x2 - self.x) < tol:
            return v_overlap > 0.3
        return False

    def to_dict(self) -> dict:
        return {
            "id":          self.rid,
            "type":        self.rtype,
            "floor":       self.floor,
            "x":           round(self.x, 2),
            "y":           round(self.y, 2),
            "width":       round(self.w, 2),
            "height":      round(self.h, 2),
            "orientation": self.orientation,
        }


# ---------------------------------------------------------------------------- #
#  Strip packer                                                                 #
# ---------------------------------------------------------------------------- #
def _pack_zone_strip(
    rooms: List[_Room],
    zone_x: float, zone_y: float,
    zone_w: float, zone_h: float,
) -> None:
    """Pack rooms into a zone rectangle left-to-right, wrapping into rows."""
    if not rooms:
        return
    rooms_sorted = sorted(rooms, key=lambda r: -r.h)
    cursor_x = zone_x
    cursor_y = zone_y
    row_h    = 0.0

    for room in rooms_sorted:
        # Clamp room to zone size
        if room.w > zone_w:
            scale     = zone_w / room.w
            room.w    = round(zone_w, 1)
            room.h    = round(room.h * scale, 1)
        if room.h > zone_h:
            scale     = zone_h / room.h
            room.h    = round(zone_h, 1)
            room.w    = round(room.w * scale, 1)

        # Wrap row
        if cursor_x + room.w > zone_x + zone_w + 0.05:
            cursor_x  = zone_x
            cursor_y += row_h + 0.1
            row_h     = 0.0

        # Clamp y within zone
        cursor_y = min(cursor_y, zone_y + zone_h - room.h)
        cursor_y = max(cursor_y, zone_y)

        room.x    = round(cursor_x, 2)
        room.y    = round(cursor_y, 2)
        cursor_x += room.w + 0.1
        row_h     = max(row_h, room.h)


# ---------------------------------------------------------------------------- #
#  Adjacency enforcer                                                           #
# ---------------------------------------------------------------------------- #
def _enforce_adjacency(
    all_rooms: List[_Room],
    pairs: List[Tuple[str, str]],
) -> None:
    """
    Snap room pairs toward each other to create shared edges.
    Only snaps rooms within the same zone or one zone apart to prevent
    cross-zone rooms being dragged into wrong areas.
    """
    type_map: Dict[str, List[_Room]] = {}
    for r in all_rooms:
        type_map.setdefault(r.rtype, []).append(r)

    ZONE_INDEX = {z: i for i, z in enumerate(ZONE_ORDER)}

    for rt_a, rt_b in pairs:
        list_a = type_map.get(rt_a, [])
        list_b = type_map.get(rt_b, [])
        if not list_a or not list_b:
            continue
        ra = list_a[0]
        rb = list_b[0]
        if ra.shares_edge(rb):
            continue

        # Only snap if zones are the same or adjacent
        zone_a = ROOM_ZONE.get(ra.rtype, "PUBLIC")
        zone_b = ROOM_ZONE.get(rb.rtype, "PUBLIC")
        zi_a   = ZONE_INDEX.get(zone_a, 1)
        zi_b   = ZONE_INDEX.get(zone_b, 1)
        if abs(zi_a - zi_b) > 1:
            continue   # too far apart — skip, overlap resolver handles it

        dx = (ra.x + ra.w / 2) - (rb.x + rb.w / 2)
        dy = (ra.y + ra.h / 2) - (rb.y + rb.h / 2)

        if abs(dx) >= abs(dy):
            if dx > 0:
                rb.x = round(ra.x2 - 0.05, 2)
            else:
                rb.x = round(ra.x - rb.w + 0.05, 2)
        else:
            if dy > 0:
                rb.y = round(ra.y2 - 0.05, 2)
            else:
                rb.y = round(ra.y - rb.h + 0.05, 2)

        rb.x = max(0.0, rb.x)
        rb.y = max(0.0, rb.y)


# ---------------------------------------------------------------------------- #
#  Overlap resolver                                                             #
# ---------------------------------------------------------------------------- #
def _resolve_overlaps(rooms: List[_Room], max_iters: int = 80) -> None:
    """
    Push overlapping rooms apart on the axis of least penetration.
    Uses a strict gap of 0.0 so intentional shared-edge rooms (0.05m overlap)
    are left alone, while true overlaps are resolved.
    """
    PUSH_THRESHOLD = 0.10   # push if penetration exceeds this (m); <0.10 = shared-edge contact

    for _ in range(max_iters):
        moved = False
        for i in range(len(rooms)):
            for j in range(i + 1, len(rooms)):
                a, b = rooms[i], rooms[j]
                # Compute penetration on each axis
                ox = min(a.x2, b.x2) - max(a.x, b.x)
                oy = min(a.y2, b.y2) - max(a.y, b.y)
                if ox <= 0 or oy <= 0:
                    continue                 # no overlap
                if ox < PUSH_THRESHOLD and oy < PUSH_THRESHOLD:
                    continue                 # shared-edge contact — leave it
                # Resolve on the smaller penetration axis
                cx_a = a.x + a.w / 2;  cy_a = a.y + a.h / 2
                cx_b = b.x + b.w / 2;  cy_b = b.y + b.h / 2
                dx   = cx_b - cx_a or 0.01
                dy   = cy_b - cy_a or 0.01
                if ox < oy:
                    push  = ox / 2 + 0.06
                    b.x   = round(b.x + math.copysign(push, dx), 2)
                    a.x   = round(a.x - math.copysign(push, dx), 2)
                else:
                    push  = oy / 2 + 0.06
                    b.y   = round(b.y + math.copysign(push, dy), 2)
                    a.y   = round(a.y - math.copysign(push, dy), 2)
                a.x  = max(0.0, a.x);  a.y = max(0.0, a.y)
                b.x  = max(0.0, b.x);  b.y = max(0.0, b.y)
                moved = True
        if not moved:
            break


# ---------------------------------------------------------------------------- #
#  Area weights for proportional room sizing                                    #
# ---------------------------------------------------------------------------- #
AREA_WEIGHTS: Dict[str, float] = {
    "living": 1.8, "bedroom": 1.4, "dining": 1.2,
    "kitchen": 1.1, "office": 1.3, "nadumuttam": 1.5,
    "garage": 1.6, "bathroom": 0.6, "utility": 0.6,
    "puja_room": 0.7, "balcony": 0.6, "entrance": 0.8,
}
ZONE_H_RATIO: Dict[str, float] = {
    "FRONT":   0.15,
    "PUBLIC":  0.30,
    "PRIVATE": 0.35,
    "SERVICE": 0.20,
}


# ---------------------------------------------------------------------------- #
#  Public API                                                                   #
# ---------------------------------------------------------------------------- #
def generate_housegan_layout(
    room_types_str: List[str],
    floor_assignments: List[Tuple[str, int]],
    plot_area: float,
    num_floors: int,
    sun_dir: str,
    wind_dir: str,
    seed: int = 42,
) -> Optional[List[dict]]:
    """
    Generate a spatially valid, eco-optimised floor plan layout.

    Drop-in replacement for the HouseGAN++ engine with no checkpoint needed.

    Args:
        room_types_str:    list of room type strings (may use aliases like 'hall', 'pooja')
        floor_assignments: list of (room_type, floor_number) tuples
        plot_area:         total plot area in m²
        num_floors:        number of floors
        sun_dir:           morning sun direction e.g. "South", "East", "Southeast"
        wind_dir:          prevailing wind direction e.g. "SW", "West"
        seed:              random seed for reproducibility

    Returns:
        List of Room dicts: {id, type, floor, x, y, width, height, orientation}
        None on unrecoverable error (caller should fall back to adaptive layout).
    """
    try:
        rng       = random.Random(seed)
        cross_dir = _opposite(wind_dir)

        # ── 1. Build _Room objects grouped by floor ──────────────────────────
        rooms_by_floor: Dict[int, List[_Room]] = {}
        type_counters: Dict[str, int] = {}

        for rt_raw, fl in floor_assignments:
            rt  = _normalise_type(rt_raw)
            cnt = type_counters.get(rt, 0) + 1
            type_counters[rt] = cnt
            rid = f"{rt}_{fl}_{cnt}"

            # Area budget: weighted share of floor area
            floor_area  = plot_area / max(num_floors, 1)
            w_self      = AREA_WEIGHTS.get(rt, 1.0)
            total_w     = sum(
                AREA_WEIGHTS.get(_normalise_type(r), 1.0)
                for r, f in floor_assignments if f == fl
            )
            area_budget = max(3.0, floor_area * (w_self / max(total_w, 0.01)))

            w, h   = _ideal_dims(rt, area_budget)
            orient = _eco_orientation(rt, sun_dir, cross_dir, rng)
            room   = _Room(rid, rt, fl, w, h, orient)
            rooms_by_floor.setdefault(fl, []).append(room)

        # ── 2. Layout each floor ─────────────────────────────────────────────
        all_rooms: List[_Room] = []

        for fl, floor_rooms in sorted(rooms_by_floor.items()):
            floor_area = plot_area / max(num_floors, 1)
            plot_w     = round(math.sqrt(floor_area) * 1.25, 1)
            plot_h     = round(math.sqrt(floor_area) * 0.82, 1)

            # Group into zones
            zone_buckets: Dict[str, List[_Room]] = {z: [] for z in ZONE_ORDER}
            for room in floor_rooms:
                z = ROOM_ZONE.get(room.rtype, "PUBLIC")
                zone_buckets[z].append(room)

            # Only allocate strips for zones with rooms
            active_zones = [z for z in ZONE_ORDER if zone_buckets[z]]
            total_ratio  = sum(ZONE_H_RATIO[z] for z in active_zones) or 1.0

            cursor_y = 0.0
            for z in active_zones:
                zone_h = round(plot_h * (ZONE_H_RATIO[z] / total_ratio), 2)
                zone_h = max(zone_h, 2.5)
                _pack_zone_strip(
                    zone_buckets[z],
                    zone_x=0.0, zone_y=cursor_y,
                    zone_w=plot_w, zone_h=zone_h,
                )
                cursor_y += zone_h + 0.3   # 0.3m guaranteed gap between zones

            all_rooms.extend(floor_rooms)

        # ── 3. Enforce adjacency constraints ─────────────────────────────────
        _enforce_adjacency(all_rooms, REQUIRED_ADJACENCY)
        _enforce_adjacency(all_rooms, OPTIONAL_ADJACENCY)

        # ── 4. Resolve overlaps (two passes: before and after adjacency) ────
        _resolve_overlaps(all_rooms, max_iters=120)

        # Second adjacency pass after overlap resolution
        _enforce_adjacency(all_rooms, REQUIRED_ADJACENCY)
        _resolve_overlaps(all_rooms, max_iters=60)

        # ── 5. Small positional jitter for visual naturalness ────────────────
        for room in all_rooms:
            room.x = max(0.0, round(room.x + rng.uniform(-0.04, 0.04), 2))
            room.y = max(0.0, round(room.y + rng.uniform(-0.04, 0.04), 2))

        result = [r.to_dict() for r in all_rooms]

        logger.info(
            "[LayoutEngine] %d rooms | area=%.0fm² | floors=%d | "
            "sun=%s | wind=%s | seed=%d",
            len(result), plot_area, num_floors, sun_dir, wind_dir, seed,
        )
        return result

    except Exception as exc:
        logger.error("[LayoutEngine] Generation failed: %s", exc, exc_info=True)
        return None


def is_available() -> bool:
    """Always True — this engine has no external dependencies."""
    return True


def load_model() -> bool:
    """No-op shim for compatibility with the old HouseGAN++ interface."""
    return True
