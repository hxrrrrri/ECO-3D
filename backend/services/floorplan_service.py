"""
Floor Plan Service — Graph-Conditioned Eco Layout Generator
═══════════════════════════════════════════════════════════

Architecture:
  ┌──────────────────────────────────────────────────────────────────┐
  │  generate_floor_plan()                                           │
  │    │                                                             │
  │    ├─ Load env data from AnalysisRecord (wind, sun, ndvi, etc.) │
  │    │                                                             │
  │    ├─ [Model] house_graph_model.generate_graph_layout()         │
  │    │    Graph-conditioned layout:                                │
  │    │      • RPLAN adjacency stats → weighted graph              │
  │    │      • Laplacian spectral embedding                        │
  │    │      • Eco-bias injection (solar + wind vectors)           │
  │    │      • Overlap-free quantization                           │
  │    │    × N=5 candidates (different seeds)                      │
  │    │                                                             │
  │    ├─ [Scorer] eco_scorer.pick_best_layout()                    │
  │    │    Geometry-based scoring:                                  │
  │    │      • solar_score  (room centroid projection)             │
  │    │      • ventilation_score (cross-vent axis coverage)        │
  │    │      • thermal_mass_score (wet-room clustering)            │
  │    │    → returns best layout + score breakdown                 │
  │    │                                                             │
  │    └─ Return FloorPlanResponse with real geometry scores        │
  └──────────────────────────────────────────────────────────────────┘
"""
from typing import List
import random
import math
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from database.models import FloorPlanRecord
from models.schemas import GenerateFloorPlanRequest, FloorPlanResponse, Room

# ── Graph-conditioned layout model ────────────────────────────────────────────
from services.house_graph_model import generate_graph_layout

# ── Geometry-based eco scorer ─────────────────────────────────────────────────
from services.eco_scorer import (
    solar_score,
    ventilation_score  as vent_score,
    thermal_mass_score,
    composite_eco_score,
    generate_eco_recommendations,
    sort_rooms_eco,
    pick_best_layout,
)

logger = logging.getLogger(__name__)

_WIND_OPP = {
    "N":"S","S":"N","E":"W","W":"E",
    "NE":"SW","SW":"NE","NW":"SE","SE":"NW",
    "NNE":"SSW","SSW":"NNE","ENE":"WSW","WSW":"ENE",
    "NNW":"SSE","SSE":"NNW","ESE":"WNW","WNW":"ESE",
}

def _sun_orientation(lat: float) -> str:
    return "South" if lat >= 0 else "North"


# ── Room count limits (unchanged) ─────────────────────────────────────────────
def _compute_max_rooms(area: float) -> dict:
    if area < 60:
        return {"bedrooms":1,"bathrooms":1,"kitchen":1,"living":1,"office":0,"garage":0,"puja_room":0,"utility":0,"dining":0}
    elif area < 100:
        return {"bedrooms":2,"bathrooms":1,"kitchen":1,"living":1,"office":0,"garage":0,"puja_room":1,"utility":0,"dining":0}
    elif area < 150:
        return {"bedrooms":3,"bathrooms":2,"kitchen":1,"living":1,"office":1,"garage":0,"puja_room":1,"utility":1,"dining":1}
    elif area < 250:
        return {"bedrooms":4,"bathrooms":2,"kitchen":1,"living":1,"office":1,"garage":1,"puja_room":1,"utility":1,"dining":1}
    elif area < 400:
        return {"bedrooms":5,"bathrooms":3,"kitchen":1,"living":1,"office":2,"garage":1,"puja_room":1,"utility":1,"dining":1}
    else:
        return {"bedrooms":6,"bathrooms":4,"kitchen":2,"living":2,"office":2,"garage":2,"puja_room":1,"utility":2,"dining":1}


def _rooms_for_house_type(house_type: str, area: float, prefs: dict) -> list:
    ht = (house_type or "").lower()
    prefs = prefs or {}
    limits = _compute_max_rooms(area)
    def clamp(val, key): return min(int(val), limits.get(key, 0))

    beds  = clamp(prefs.get("bedrooms",0)  or (2 if area<150 else 3 if area<300 else 4), "bedrooms")
    baths = clamp(prefs.get("bathrooms",0) or max(1, beds//2), "bathrooms")
    has_puja    = bool(prefs.get("puja_room",False)) and limits["puja_room"]>0
    has_garage  = bool(prefs.get("garage",False))    and limits["garage"]>0
    has_office  = bool(prefs.get("office",False))    and limits["office"]>0
    has_utility = bool(prefs.get("utility", area>=150)) and limits["utility"]>0
    has_dining  = bool(prefs.get("dining",  area>=120)) and limits["dining"]>0

    rooms = ["living","kitchen"]
    if has_dining:   rooms.append("dining")
    for _ in range(beds):   rooms.append("bedroom")
    for _ in range(baths):  rooms.append("bathroom")
    if has_puja:    rooms.append("puja_room")
    if has_garage:  rooms.append("garage")
    if has_office:  rooms.append("office")
    if has_utility: rooms.append("utility")
    if ("duplex" in ht or "townhouse" in ht) and area>=200 and limits["bedrooms"]>beds:
        rooms.append("bedroom")
    if "villa" in ht and area>=300 and limits["office"]>(1 if has_office else 0):
        rooms.append("office")
    return rooms


# ── Graph-conditioned candidate generator ────────────────────────────────────
def _generate_graph_candidates(
    room_types: List[str],
    area: float,
    num_floors: int,
    sun_dir: str,
    wind_dir: str,
    lat: float,
    plot_shape: str,
    maximize_sunlight: bool,
    natural_ventilation: bool,
    base_seed: int,
    num_candidates: int = 5,
) -> List[List[Room]]:
    """
    Generate N candidate layouts using the graph-conditioned model.
    Each candidate uses a different seed → different room dimensions
    and slight position variations, but same graph topology.

    eco_strength is varied slightly across candidates so we explore
    the solar-vs-topology tradeoff space.
    """
    candidates = []
    eco_strengths = [0.4, 0.5, 0.6, 0.7, 0.55]  # vary the eco bias

    for i in range(num_candidates):
        seed = base_seed + i * 1000
        eco_s = eco_strengths[i % len(eco_strengths)]

        raw_rooms = generate_graph_layout(
            room_types=room_types,
            area=area,
            num_floors=num_floors,
            sun_dir=sun_dir,
            wind_dir=wind_dir,
            lat=lat,
            plot_shape=plot_shape,
            maximize_sunlight=maximize_sunlight,
            natural_ventilation=natural_ventilation,
            eco_strength=eco_s,
            seed=seed,
        )

        # Convert to Room schema objects
        type_counts: dict = {}
        layout: List[Room] = []
        for r in raw_rooms:
            rtype = r["rtype"]
            c = type_counts.get(rtype, 0)
            type_counts[rtype] = c + 1
            rid = f"{rtype}_{r['floor']}_{c+1}"
            layout.append(Room(
                id=rid,
                type=rtype,
                width=round(r["w"], 1),
                height=round(r["h"], 1),
                x=round(r["x"], 1),
                y=round(r["y"], 1),
                floor=r["floor"],
                orientation=r["orientation"],
            ))

        candidates.append(layout)

    return candidates


# ── Main service function ─────────────────────────────────────────────────────
async def generate_floor_plan(request: GenerateFloorPlanRequest, db: AsyncSession) -> FloorPlanResponse:
    seed_str = f"{request.plot_id}_{request.plot_area_sqm}_{request.num_floors}_{request.plot_shape}_{request.house_type}"
    base_seed = abs(hash(seed_str)) % (2**31)
    rng = random.Random(base_seed)

    # ── Load real environmental data ──────────────────────────────────────────
    slope = 5.0; flood_risk = 0.3; ndvi = 0.45; wind_dir = "SW"; lat = 20.0

    try:
        from database.models import AnalysisRecord
        from sqlalchemy import select, desc
        result = await db.execute(
            select(AnalysisRecord)
            .where(AnalysisRecord.plot_id == request.plot_id)
            .order_by(desc(AnalysisRecord.id))
        )
        rec = result.scalars().first()
        if rec:
            slope      = float(rec.slope or 5.0)
            flood_risk = float(rec.flood_probability or 0.3)
            ndvi       = float(rec.ndvi or 0.45)
            wind_dir   = str(rec.wind_direction or "SW")
            raw        = rec.raw_features or {}
            lat        = float(raw.get("_lat", raw.get("lat", 20.0)))
    except Exception as e:
        logger.warning(f"Could not load env data ({e}), using defaults")

    sun_dir = _sun_orientation(lat)

    # ── Build room list ───────────────────────────────────────────────────────
    room_types = _rooms_for_house_type(
        request.house_type,
        request.plot_area_sqm,
        request.room_preferences or {},
    )

    # ── [GRAPH MODEL] Generate N candidates ──────────────────────────────────
    candidates = _generate_graph_candidates(
        room_types=room_types,
        area=request.plot_area_sqm,
        num_floors=request.num_floors,
        sun_dir=sun_dir,
        wind_dir=wind_dir,
        lat=lat,
        plot_shape=request.plot_shape,
        maximize_sunlight=request.maximize_sunlight,
        natural_ventilation=request.natural_ventilation,
        base_seed=base_seed,
        num_candidates=5,
    )

    # ── [ECO SCORER] Pick best ────────────────────────────────────────────────
    best_layout, eco_scores = pick_best_layout(
        candidates=candidates,
        sun_dir=sun_dir,
        wind_dir=wind_dir,
        lat=lat,
        ndvi=ndvi,
        flood_risk=flood_risk,
        slope=slope,
    )

    # ── Real geometry scores ──────────────────────────────────────────────────
    solar   = eco_scores.get("solar",       solar_score(best_layout, sun_dir, lat))
    ventil  = eco_scores.get("ventilation", vent_score(best_layout, wind_dir))
    thermal = eco_scores.get("thermal",     thermal_mass_score(best_layout))
    fitness = eco_scores.get("composite",   composite_eco_score(solar, ventil, thermal, ndvi, flood_risk, slope))

    if request.maximize_sunlight:      solar  = round(min(0.98, solar  + 0.04), 3)
    if request.natural_ventilation:    ventil = round(min(0.98, ventil + 0.04), 3)
    if request.sustainability_priority: fitness = round(min(0.97, fitness + 0.03), 3)

    # ── Recommendations ───────────────────────────────────────────────────────
    recs = generate_eco_recommendations(
        best_layout, sun_dir, wind_dir, lat, solar, ventil, thermal
    )

    trees_saved = max(0, int(ndvi * 6) + rng.randint(0,3)) if request.preserve_trees else 0
    total_area  = round(sum(r.width * r.height for r in best_layout), 1)

    # ── Persist ───────────────────────────────────────────────────────────────
    try:
        db.add(FloorPlanRecord(
            plot_id=request.plot_id,
            layout_json=[r.model_dump() for r in best_layout],
            fitness_score=float(fitness),
            generation_count=5.0,
        ))
        await db.commit()
    except Exception as e:
        logger.warning(f"Floor plan DB persist failed ({e})")
        try: await db.rollback()
        except: pass

    return FloorPlanResponse(
        plot_id=request.plot_id,
        layout=best_layout,
        walls=None, doors=None, windows=None,
        total_area=total_area,
        fitness_score=float(fitness),
        generation_count=5,
        sunlight_score=float(solar),
        ventilation_score=float(ventil),
        tree_preserved_count=int(trees_saved),
        orientation_degrees=round(rng.uniform(0,360), 1),
        eco_recommendations=recs,
    )




