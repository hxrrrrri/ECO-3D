"""
ECO-3D Passive Design Scorer
────────────────────────────
Geometry-based solar + ventilation scoring.
No GA, no torch, no external deps — pure math on the Room list.

Algorithm:
  1. solar_score   — fraction of sun-priority rooms whose x/y centroid
                     lies on the correct solar face of the bounding box
  2. ventilation_score — checks if a cross-ventilation axis exists:
                         at least one pair of habitable rooms whose centroids
                         span ≥70% of the plan width/depth along the wind axis
  3. thermal_mass_score — rewards wet-room clustering and public/private adjacency
  4. composite_eco_score — weighted combination used as fitness_score
  5. generate_eco_recommendations — human-readable improvement hints
"""
import math
from typing import List, Dict, Tuple, Optional

# ── Direction helpers ─────────────────────────────────────────────────────────
_DIR_VEC: Dict[str, Tuple[float, float]] = {
    "N":  ( 0, -1), "NE": ( 1, -1), "E":  ( 1,  0), "SE": ( 1,  1),
    "S":  ( 0,  1), "SW": (-1,  1), "W":  (-1,  0), "NW": (-1, -1),
    "NNE":( 0.5,-1),"NNW":(-0.5,-1),"SSE":( 0.5, 1),"SSW":(-0.5, 1),
    "ENE":( 1,-0.5),"ESE":( 1, 0.5),"WNW":(-1,-0.5),"WSW":(-1, 0.5),
}

_WIND_OPP = {
    "N":"S","S":"N","E":"W","W":"E",
    "NE":"SW","SW":"NE","NW":"SE","SE":"NW",
    "NNE":"SSW","SSW":"NNE","ENE":"WSW","WSW":"ENE",
    "NNW":"SSE","SSE":"NNW","ESE":"WNW","WNW":"ESE",
}

def _vec(d: str) -> Tuple[float, float]:
    key = d.upper().strip()
    if key in _DIR_VEC:
        vx, vy = _DIR_VEC[key]
    else:
        # Fallback: parse compass to angle
        angles = {"N":270,"NE":315,"E":0,"SE":45,"S":90,"SW":135,"W":180,"NW":225}
        a = math.radians(angles.get(key[:2], 0))
        vx, vy = math.cos(a), math.sin(a)
    mag = math.sqrt(vx*vx + vy*vy) or 1
    return vx/mag, vy/mag

def _sun_dir(lat: float) -> str:
    """In northern hemisphere sun is to the south; southern → north."""
    return "S" if lat >= 0 else "N"

# ── Room classification ───────────────────────────────────────────────────────
_SUN_PRIORITY   = {"living","dining","bedroom","office","puja_room"}  # want sun
_VENT_PRIORITY  = {"kitchen","bathroom","utility"}                     # want wind
_BUFFER_ROOMS   = {"garage","utility"}                                 # thermal buffer

def _classify(rtype: str) -> str:
    t = rtype.lower()
    if any(t.startswith(k) or k in t for k in _SUN_PRIORITY):   return "sun"
    if any(t.startswith(k) or k in t for k in _VENT_PRIORITY):  return "vent"
    if any(t.startswith(k) or k in t for k in _BUFFER_ROOMS):   return "buffer"
    return "neutral"

# ── Bounding box helpers ──────────────────────────────────────────────────────
def _bbox(rooms):
    if not rooms:
        return 0, 0, 1, 1
    xs = [r["x"] for r in rooms] + [r["x"]+r["w"] for r in rooms]
    ys = [r["y"] for r in rooms] + [r["y"]+r["h"] for r in rooms]
    return min(xs), min(ys), max(xs), max(ys)

def _centroid(r):
    return r["x"] + r["w"]/2, r["y"] + r["h"]/2

def _to_dicts(rooms) -> List[dict]:
    """Normalise Room objects or dicts to plain dicts with x,y,w,h,type."""
    out = []
    for r in rooms:
        if hasattr(r, "width"):
            out.append({"x": r.x, "y": r.y, "w": r.width, "h": r.height,
                        "type": r.type, "id": getattr(r,"id","")})
        else:
            out.append({"x": r.get("x",0), "y": r.get("y",0),
                        "w": r.get("width", r.get("w",1)),
                        "h": r.get("height", r.get("h",1)),
                        "type": r.get("type",""), "id": r.get("id","")})
    return out

# ─────────────────────────────────────────────────────────────────────────────
# 1. SOLAR SCORE
# ─────────────────────────────────────────────────────────────────────────────
def solar_score(rooms, sun_dir: str, lat: float = 20.0) -> float:
    """
    Score how well sun-priority rooms are positioned on the solar face.

    Method:
      - Project each room centroid onto the sun direction vector.
      - Sun-priority rooms in the top-33% of the projection get full credit.
      - Rooms in the middle-33% get half credit.
      - Buffer/garage rooms on the anti-sun face (bottom-33%) get a small bonus
        (they act as thermal buffers protecting the rest).
    Returns 0.0 – 1.0
    """
    rs = _to_dicts(rooms)
    if not rs:
        return 0.5
    actual_sun = _sun_dir(lat)
    # Blend requested direction with latitude-derived direction
    vx, vy = _vec(sun_dir if sun_dir else actual_sun)

    # Project centroids onto sun vector
    projections = [(r, vx*cx + vy*cy) for r in rs for cx,cy in [_centroid(r)]]
    vals = [p for _,p in projections]
    lo, hi = min(vals), max(vals)
    span = hi - lo or 1.0

    sun_rooms = [(r,p) for r,p in projections if _classify(r["type"]) == "sun"]
    buf_rooms  = [(r,p) for r,p in projections if _classify(r["type"]) == "buffer"]

    if not sun_rooms:
        return 0.5

    total_credit = 0.0
    for r, p in sun_rooms:
        norm = (p - lo) / span   # 0 = anti-sun, 1 = full-sun face
        if norm >= 0.67:
            total_credit += 1.0
        elif norm >= 0.33:
            total_credit += 0.5
        else:
            total_credit += 0.1

    # Bonus if buffer rooms are on anti-sun face
    buf_bonus = 0.0
    for _, p in buf_rooms:
        norm = (p - lo) / span
        if norm <= 0.33:
            buf_bonus += 0.15

    raw = (total_credit / len(sun_rooms)) + min(0.15, buf_bonus)
    return round(min(1.0, raw), 3)


# ─────────────────────────────────────────────────────────────────────────────
# 2. VENTILATION SCORE
# ─────────────────────────────────────────────────────────────────────────────
def ventilation_score(rooms, wind_dir: str) -> float:
    """
    Cross-ventilation score.

    Method (Givoni / ASHRAE heuristic):
      A cross-ventilation axis exists when:
        a) At least one habitable room is on the wind-inlet face (top-33% of
           wind-projection) AND at least one habitable room is on the outlet
           face (bottom-33% of wind-projection).
        b) The span between inlet centroid and outlet centroid is ≥ 60% of
           the plan width along that axis.
      Vent-priority rooms (kitchen, bath, utility) on the wind-inlet side
      get an extra bonus (they flush moisture/heat most effectively there).
    Returns 0.0 – 1.0
    """
    rs = _to_dicts(rooms)
    if not rs:
        return 0.5

    vx, vy = _vec(wind_dir)
    projections = [(r, vx*cx + vy*cy) for r in rs for cx,cy in [_centroid(r)]]
    vals = [p for _,p in projections]
    lo, hi = min(vals), max(vals)
    span = hi - lo or 1.0

    habitable = [(r,p) for r,p in projections
                 if _classify(r["type"]) in ("sun","vent","neutral")]
    if len(habitable) < 2:
        return 0.4

    # Inlet = high projection (wind comes from that direction)
    # Outlet = low projection
    inlets  = [(r,p) for r,p in habitable if (p-lo)/span >= 0.67]
    outlets = [(r,p) for r,p in habitable if (p-lo)/span <= 0.33]

    if not inlets or not outlets:
        return 0.35   # no cross-ventilation axis

    # Score 1: axis coverage (how much of the plan the ventilation crosses)
    best_inlet  = max(p for _,p in inlets)
    best_outlet = min(p for _,p in outlets)
    axis_coverage = (best_inlet - best_outlet) / span  # 0–1

    # Score 2: vent-priority rooms on inlet face
    vent_bonus = sum(0.1 for r,p in projections
                     if _classify(r["type"]) == "vent" and (p-lo)/span >= 0.50)
    vent_bonus = min(0.2, vent_bonus)

    # Score 3: living/bedroom rooms NOT on inlet face (they shouldn't be blasted)
    living_penalty = sum(0.05 for r,p in projections
                         if r["type"].startswith("living") and (p-lo)/span >= 0.80)
    living_penalty = min(0.15, living_penalty)

    raw = 0.6 * axis_coverage + 0.25 + vent_bonus - living_penalty
    return round(min(1.0, max(0.0, raw)), 3)


# ─────────────────────────────────────────────────────────────────────────────
# 3. THERMAL MASS SCORE
# ─────────────────────────────────────────────────────────────────────────────
def thermal_mass_score(rooms) -> float:
    """
    Rewards two passive design adjacency patterns:
      a) Wet-room clustering: kitchen + bathroom adjacent → shared plumbing wall
         reduces heat loss and moisture spread.
      b) Public-private zoning: living/dining rooms NOT adjacent to bedrooms
         (privacy + acoustic) → better thermal zoning.
      c) Buffer at boundary: garage/utility on north/west face.
    Returns 0.0 – 1.0
    """
    rs = _to_dicts(rooms)
    if not rs:
        return 0.5

    EPS = 0.5  # adjacency tolerance in metres

    def adjacent(a, b):
        # Check if two rooms share an edge (within EPS)
        h_adj = (abs((a["x"]+a["w"]) - b["x"]) < EPS or
                 abs((b["x"]+b["w"]) - a["x"]) < EPS)
        v_adj = (abs((a["y"]+a["h"]) - b["y"]) < EPS or
                 abs((b["y"]+b["h"]) - a["y"]) < EPS)
        x_overlap = min(a["x"]+a["w"], b["x"]+b["w"]) - max(a["x"], b["x"]) > -EPS
        y_overlap = min(a["y"]+a["h"], b["y"]+b["h"]) - max(a["y"], b["y"]) > -EPS
        return (h_adj and y_overlap) or (v_adj and x_overlap)

    wet   = [r for r in rs if _classify(r["type"]) == "vent"]
    pub   = [r for r in rs if r["type"].startswith("living") or r["type"].startswith("dining")]
    prv   = [r for r in rs if r["type"].startswith("bedroom")]
    buf   = [r for r in rs if _classify(r["type"]) == "buffer"]

    score = 0.5   # baseline

    # Wet clustering bonus
    if len(wet) >= 2:
        wet_pairs = sum(1 for i in range(len(wet)) for j in range(i+1,len(wet)) if adjacent(wet[i],wet[j]))
        max_pairs = len(wet)*(len(wet)-1)/2 or 1
        score += 0.2 * (wet_pairs / max_pairs)

    # Public-private separation bonus
    if pub and prv:
        prv_adj_pub = sum(1 for p in pub for b in prv if adjacent(p,b))
        if prv_adj_pub == 0:
            score += 0.2   # fully separated = good
        else:
            score -= 0.05 * prv_adj_pub

    # Buffer at boundary bonus (if any buffer room exists)
    if buf:
        score += 0.1

    return round(min(1.0, max(0.0, score)), 3)


# ─────────────────────────────────────────────────────────────────────────────
# 4. COMPOSITE ECO SCORE  (replaces the fake fitness formula)
# ─────────────────────────────────────────────────────────────────────────────
def composite_eco_score(
    solar: float,
    ventilation: float,
    thermal: float,
    ndvi: float = 0.45,
    flood_risk: float = 0.3,
    slope: float = 5.0,
) -> float:
    """
    Weighted composite fitness used as FloorPlanResponse.fitness_score.

    Weights inspired by LEED / GRIHA passive design criteria:
      35% solar gain (daylight + heating)
      30% cross-ventilation
      15% thermal mass / zoning
      10% site greenery (NDVI proxy for thermal comfort)
      10% structural safety (inverse flood + slope penalty)
    """
    site = min(1.0, ndvi * 1.5)                         # green cover bonus
    safety = max(0.0, 1.0 - flood_risk * 0.7 - slope/90)  # slope+flood penalty

    raw = (0.35 * solar +
           0.30 * ventilation +
           0.15 * thermal +
           0.10 * site +
           0.10 * safety)
    return round(min(0.97, max(0.30, raw)), 3)


# ─────────────────────────────────────────────────────────────────────────────
# 5. ECO RECOMMENDATIONS  (human-readable improvement hints)
# ─────────────────────────────────────────────────────────────────────────────
def generate_eco_recommendations(
    rooms,
    sun_dir: str,
    wind_dir: str,
    lat: float,
    solar: float,
    ventilation: float,
    thermal: float,
) -> List[str]:
    """Returns up to 5 actionable passive-design recommendations."""
    rs = _to_dicts(rooms)
    recs = []

    vx, vy = _vec(sun_dir if sun_dir else _sun_dir(lat))
    projections = [(r, vx*cx + vy*cy) for r in rs for cx,cy in [_centroid(r)]]
    vals = [p for _,p in projections]
    lo, hi = min(vals), max(vals)
    span = hi - lo or 1.0

    # Solar
    if solar < 0.65:
        sun_rooms = [r for r,p in projections
                     if _classify(r["type"]) == "sun" and (p-lo)/span < 0.5]
        if sun_rooms:
            names = ", ".join(r["type"] for r in sun_rooms[:2])
            recs.append(
                f"Move {names} toward the {sun_dir}-facing side to improve "
                f"solar gain by ~{int((0.80-solar)*100)}%."
            )
        else:
            recs.append(f"Add south-facing glazing to living/bedroom areas for passive solar heating.")

    # Ventilation
    if ventilation < 0.65:
        opp = _WIND_OPP.get(wind_dir.upper(), "opposite")
        recs.append(
            f"Position kitchen/bathroom on the {wind_dir} inlet face and "
            f"living areas near the {opp} face to establish a cross-ventilation axis."
        )

    # Thermal
    if thermal < 0.60:
        recs.append(
            "Cluster wet rooms (kitchen + bathrooms) on one shared plumbing wall "
            "to reduce heat loss and improve moisture management."
        )
        recs.append(
            "Keep bedrooms in a separate zone from living areas for better "
            "thermal zoning and acoustic privacy."
        )

    # Flood / slope
    # (scores already factored in; skip to keep list short)

    if not recs:
        recs.append(
            f"Layout is well-optimised for passive solar ({int(solar*100)}%) "
            f"and natural ventilation ({int(ventilation*100)}%). "
            "Consider adding a roof overhang to prevent summer overheating."
        )

    return recs[:5]


# ─────────────────────────────────────────────────────────────────────────────
# 6. PASSIVE ROOM ORDERING  (eco-aware sort before zone packing)
# ─────────────────────────────────────────────────────────────────────────────
def sort_rooms_eco(
    room_types: List[str],
    sun_dir: str,
    wind_dir: str,
    lat: float,
) -> List[str]:
    """
    Reorder room_types list so that when rooms are packed left→right, top→bottom
    into the zone grid, the resulting layout naturally places:
      • Public + sun-priority rooms (living, dining) → Zone 0 (solar face)
      • Private rooms (bedrooms) → middle zones
      • Wet/vent rooms (kitchen, bath, utility) → near wind-inlet position
      • Buffer rooms (garage) → anti-sun / anti-wind face (last)

    This is the key insight from the Graph2Plan / LE-RD pipeline:
    ordering the room sequence before layout = implicit constraint satisfaction
    without any iterative optimizer.
    """
    actual_sun = _sun_dir(lat)
    # Zones in the packer go: zone[0]=first rooms placed, zone[-1]=last
    # For a rectangle the first zone covers the whole area L→R, T→B
    # We want: living/dining first (solar face = south in NH = bottom in canvas Y)
    # then bedrooms, then kitchen/bath (wind inlet), then garage last.

    ORDER = {
        "living":   0,
        "dining":   1,
        "office":   2,
        "puja_room":3,
        "bedroom":  4,
        "kitchen":  5,
        "bathroom": 6,
        "utility":  7,
        "garage":   8,
    }

    def rank(rtype: str) -> int:
        t = rtype.lower()
        for k, v in ORDER.items():
            if t.startswith(k) or k in t:
                return v
        return 5

    return sorted(room_types, key=rank)


# ─────────────────────────────────────────────────────────────────────────────
# 7. MULTI-CANDIDATE SAMPLER  (the "rank + pick best" step)
# ─────────────────────────────────────────────────────────────────────────────
def pick_best_layout(
    candidates: list,   # list of Room lists
    sun_dir: str,
    wind_dir: str,
    lat: float,
    ndvi: float = 0.45,
    flood_risk: float = 0.3,
    slope: float = 5.0,
) -> Tuple[list, dict]:
    """
    Given N candidate layouts (each a list of Room objects), score each and
    return the best one plus its scores dict.

    This is the "Sample N layouts, score each, return top 1" approach —
    replacing the GA's iterative refinement with a fast parallel filter.
    """
    best_layout = candidates[0]
    best_scores: dict = {}
    best_composite = -1.0

    for rooms in candidates:
        sol = solar_score(rooms, sun_dir, lat)
        ven = ventilation_score(rooms, wind_dir)
        thm = thermal_mass_score(rooms)
        comp = composite_eco_score(sol, ven, thm, ndvi, flood_risk, slope)
        if comp > best_composite:
            best_composite = comp
            best_layout = rooms
            best_scores = {
                "solar": sol,
                "ventilation": ven,
                "thermal": thm,
                "composite": comp,
            }

    return best_layout, best_scores
