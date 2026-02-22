"""
Full Analysis Pipeline — 5 layers wired correctly
  1. DeepLabV3 segmentation  (ai/segmentation/segmenter.py  OR  ai/segmentation/model.py)
  2. YOLOv8 tree detection   (ai/detection/tree_detector.py OR  ai/detection/model.py)
  3. Real env data           (services/real_env_data.py — Open-Elevation, Open-Meteo, OpenLandMap)
  4. XGBoost flood model     (ai/flood/model.py — auto-trains on first use)
  5. MLP buildability model  (ai/buildability/model.py — auto-trains on first use)
  + Genetic floor plan uses  (ai/floorplan/genetic_optimizer.py via floorplan_service.py)
"""
import logging
import asyncio
import random
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database.models import PlotRecord, AnalysisRecord
from models.schemas import (
    AnalyzePlotRequest, AnalysisResponse,
    SegmentationResult, EnvironmentalFeatures, TreeCoordinate,
)

logger = logging.getLogger(__name__)


# ── Layer 1: DeepLabV3 segmentation ──────────────────────────────────────────
def run_segmentation(lat: float, lon: float) -> SegmentationResult:
    """
    Try ai/segmentation/model.py first (uses Mapbox tile if token set),
    fall back to ai/segmentation/segmenter.py (uses OSM tile).
    Both fall back internally to synthetic if torch unavailable.
    """
    # Primary: model.py (has Mapbox support)
    try:
        from ai.segmentation.model import run_segmentation as seg_fn
        dist = seg_fn(lat, lon)
        logger.info(f"DeepLabV3 segmentation OK. dominant={max(dist, key=dist.get)}")
        return SegmentationResult(
            vegetation=dist.get("vegetation", 0.3),
            water=dist.get("water", 0.05),
            urban=dist.get("urban", 0.15),
            bare_soil=dist.get("bare_soil", 0.1),
            road=dist.get("road", 0.05),
        )
    except Exception as e:
        logger.warning(f"ai/segmentation/model.py failed ({e}), trying segmenter.py")

    # Fallback: segmenter.py
    try:
        from ai.segmentation.segmenter import SatelliteSegmenter
        result = SatelliteSegmenter().segment(lat, lon, zoom=18)
        dist = result.get("class_distribution", {})
        veg  = dist.get("vegetation", 0) + dist.get("forest", 0) + dist.get("agriculture", 0) * 0.5
        water = dist.get("water", 0)
        urban = dist.get("urban", 0)
        bare  = dist.get("bare_land", 0) + dist.get("agriculture", 0) * 0.5
        road  = max(0.0, 1.0 - veg - water - urban - bare)
        total = veg + water + urban + bare + road or 1.0
        return SegmentationResult(
            vegetation=round(veg/total, 3), water=round(water/total, 3),
            urban=round(urban/total, 3),   bare_soil=round(bare/total, 3),
            road=round(road/total, 3),
        )
    except Exception as e:
        logger.warning(f"segmenter.py failed ({e}), using synthetic")
        return _synthetic_seg(lat, lon)


def _synthetic_seg(lat: float, lon: float) -> SegmentationResult:
    rng = random.Random(f"{lat:.4f}{lon:.4f}")
    v = rng.uniform(0.25, 0.55); w = rng.uniform(0.02, 0.10)
    u = rng.uniform(0.05, 0.20); b = rng.uniform(0.03, 0.15)
    r = max(0.0, 1.0 - v - w - u - b); t = v + w + u + b + r
    return SegmentationResult(vegetation=round(v/t,3), water=round(w/t,3),
                               urban=round(u/t,3), bare_soil=round(b/t,3), road=round(r/t,3))


# ── Layer 2: YOLOv8 tree detection ────────────────────────────────────────────
def run_tree_detection(lat: float, lon: float) -> list[TreeCoordinate]:
    """
    Try ai/detection/model.py (run_tree_detection) first,
    fall back to ai/detection/tree_detector.py (TreeDetector class).
    Both fall back internally to synthetic.
    """
    # Primary: detection/model.py
    try:
        from ai.detection.model import run_tree_detection as det_fn
        trees = det_fn(lat, lon)
        logger.info(f"YOLOv8 tree detection OK: {len(trees)} trees")
        return trees
    except Exception as e:
        logger.warning(f"ai/detection/model.py failed ({e}), trying tree_detector.py")

    # Fallback: tree_detector.py
    try:
        from ai.detection.tree_detector import TreeDetector
        raw = TreeDetector().detect(lat, lon, zoom=18)
        return [
            TreeCoordinate(
                lat=t.get("lat", lat), lon=t.get("lng", t.get("lon", lon)),
                confidence=t.get("confidence", 0.8)
            ) for t in raw
        ]
    except Exception as e:
        logger.warning(f"tree_detector.py failed ({e}), using synthetic")
        return _synthetic_trees(lat, lon)


def _synthetic_trees(lat: float, lon: float) -> list[TreeCoordinate]:
    rng = random.Random(f"trees{lat:.4f}{lon:.4f}")
    return [
        TreeCoordinate(
            lat=round(lat + rng.uniform(-0.0008, 0.0008), 6),
            lon=round(lon + rng.uniform(-0.0008, 0.0008), 6),
            confidence=round(rng.uniform(0.72, 0.97), 2),
        ) for _ in range(rng.randint(2, 6))
    ]


# ── Layer 4: XGBoost flood model ──────────────────────────────────────────────
def run_flood_model(env: dict) -> float:
    """
    Use ai/flood/model.py (XGBoost, auto-trains on first use).
    Falls back to physics formula from real_env_data.py.
    """
    try:
        from ai.flood.model import predict_flood_probability
        prob = predict_flood_probability({
            "elevation":         env["elevation"],
            "slope":             env["slope"],
            "ndvi":              env["ndvi"],
            "rainfall_mm":       env["rainfall_mm"],
            "soil_type":         env["soil_type"],
            "distance_to_water": 500.0,   # OSM query could improve this
        })
        logger.info(f"XGBoost flood probability: {prob:.3f}")
        return prob
    except Exception as e:
        logger.warning(f"XGBoost flood model failed ({e}), using physics formula")
        return float(env.get("flood_probability", 0.3))


# ── Layer 5: MLP buildability model ──────────────────────────────────────────
def run_buildability_model(env: dict, flood: float) -> float:
    """
    Use ai/buildability/model.py (MLP, auto-trains on first use).
    Falls back to physics formula from real_env_data.py.
    """
    try:
        from ai.buildability.model import predict_buildability_score
        score = predict_buildability_score({
            "flood_probability":  flood,
            "slope":              env["slope"],
            "soil_stability":     1.0 - env.get("clay_fraction", 0.25),
            "vegetation_density": env["ndvi"],
            "wind_exposure":      min(1.0, env.get("wind_ms", 3.0) / 15.0),
            "sun_exposure":       env["sun_exposure_hours"],
        })
        logger.info(f"MLP buildability score: {score:.1f}")
        return score
    except Exception as e:
        logger.warning(f"MLP buildability model failed ({e}), using physics formula")
        return float(env.get("buildability_score", 65.0))


# ── Synthetic env fallback ────────────────────────────────────────────────────
def _synthetic_env(lat: float, lon: float, rng: random.Random) -> dict:
    import math, datetime
    doy   = datetime.date.today().timetuple().tm_yday
    decl  = 23.45 * math.sin(math.radians((360/365)*(doy-81)))
    cos_ha = max(-1.0, min(1.0, -math.tan(math.radians(lat))*math.tan(math.radians(decl))))
    sun_h  = round(2*math.degrees(math.acos(cos_ha))/15, 2)
    elev   = round(rng.uniform(10, 400), 1); slope = round(rng.uniform(1, 20), 2)
    ndvi   = round((0.55 if abs(lat)<23.5 else 0.38 if abs(lat)<45 else 0.22)+rng.uniform(-0.1,0.1), 3)
    rain   = round((1600 if abs(lat)<10 else 800 if abs(lat)<30 else 500)+rng.uniform(-200,200), 1)
    flood  = round(min(0.95, max(0.02, 0.38*(1-elev/80)+0.18*(1-slope/15)+0.14*min(1,rain/2000))), 3)
    build  = round(min(99, max(2, 100-flood*38-slope*0.9+ndvi*8+sun_h*1.2)), 1)
    return {
        "elevation": elev, "slope": slope, "wind_ms": round(rng.uniform(2,8),1),
        "wind_direction": rng.choice(["N","NE","E","SE","S","SW","W","NW"]),
        "rainfall_mm": rain, "soil_type": rng.choice(["Sandy Loam","Loam","Clay Loam"]),
        "soil_buildable": True, "clay_fraction": 0.25,
        "ndvi": ndvi, "sun_exposure_hours": sun_h,
        "flood_probability": flood, "buildability_score": build,
    }


# ── Main orchestrator ─────────────────────────────────────────────────────────
async def run_full_analysis(request: AnalyzePlotRequest, db: AsyncSession) -> AnalysisResponse:
    lat, lon, plot_id = request.lat, request.lon, request.plot_id
    rng = random.Random(f"{lat:.5f}{lon:.5f}")

    # Layers 1 & 2 are CPU-bound — run in thread pool
    # Layer 3 is async HTTP — run concurrently
    loop = asyncio.get_running_loop()  # get_event_loop() deprecated in 3.10+

    seg_task   = loop.run_in_executor(None, run_segmentation, lat, lon)
    trees_task = loop.run_in_executor(None, run_tree_detection, lat, lon)

    try:
        from services.real_env_data import fetch_all_real_data
        seg, trees, env_data = await asyncio.gather(
            seg_task, trees_task, fetch_all_real_data(lat, lon)
        )
        logger.info(f"Layers 1-3 complete for ({lat:.4f}, {lon:.4f})")
    except Exception as e:
        logger.error(f"Pipeline gather error ({e}), using available data")
        seg      = await seg_task
        trees    = await trees_task
        env_data = _synthetic_env(lat, lon, rng)

    # Layers 4 & 5: ML models (sync, fast after first-run train)
    flood = run_flood_model(env_data)
    build = run_buildability_model(env_data, flood)

    # ── Persist ───────────────────────────────────────────────────────────────
    try:
        existing = await db.execute(select(PlotRecord).where(PlotRecord.plot_id == plot_id))
        if not existing.scalars().first():
            db.add(PlotRecord(plot_id=plot_id, lat=lat, lon=lon, polygon=request.polygon))
        db.add(AnalysisRecord(
            plot_id=plot_id, segmentation_mask=seg.model_dump(),
            tree_coordinates=[t.model_dump() for t in trees],
            ndvi=env_data["ndvi"], slope=env_data["slope"], elevation=env_data["elevation"],
            rainfall_mm=env_data["rainfall_mm"], soil_type=env_data["soil_type"],
            wind_direction=env_data["wind_direction"], sun_exposure_hours=env_data["sun_exposure_hours"],
            flood_probability=flood, buildability_score=build,
            raw_features={**env_data, "_lat": lat, "_lon": lon},  # prefixed to avoid key collision
        ))
        await db.commit()
    except Exception as e:
        logger.warning(f"DB persist failed: {e}")
        try: await db.rollback()
        except: pass

    status = "EXCELLENT" if build >= 80 else "GOOD" if build >= 60 else "FAIR" if build >= 40 else "POOR"

    return AnalysisResponse(
        plot_id=plot_id, segmentation=seg, tree_coordinates=trees,
        environmental=EnvironmentalFeatures(
            ndvi=env_data["ndvi"], slope=env_data["slope"], elevation=env_data["elevation"],
            rainfall_mm=env_data["rainfall_mm"], soil_type=env_data["soil_type"],
            wind_direction=env_data["wind_direction"], sun_exposure_hours=env_data["sun_exposure_hours"],
        ),
        flood_probability=flood, buildability_score=build, status=status,
    )
