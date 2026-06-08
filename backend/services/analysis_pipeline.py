"""
Full Analysis Pipeline — 5 layers, completely crash-proof.
Every layer has synthetic fallback — the endpoint will NEVER return 500.
"""
import logging
import asyncio
import math
import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from database.models import PlotRecord, AnalysisRecord
from models.schemas import (
    AnalyzePlotRequest, AnalysisResponse,
    SegmentationResult, EnvironmentalFeatures, TreeCoordinate,
)

logger = logging.getLogger(__name__)


# ── Synthetic fallbacks (always available) ────────────────────────────────────
def _synthetic_seg(lat: float, lon: float) -> SegmentationResult:
    # Use a neutral non-random fallback to avoid synthetic noise.
    v, w, u, b, r = 0.0, 0.0, 0.0, 0.0, 0.0
    t = 1.0
    return SegmentationResult(
        vegetation=round(v/t, 3), water=round(w/t, 3),
        urban=round(u/t, 3), bare_soil=round(b/t, 3), road=round(r/t, 3),
    )


def _synthetic_trees(lat: float, lon: float) -> list:
    # If tree detection is unavailable, return no trees instead of fabricated points.
    return []


def _synthetic_env(lat: float, lon: float) -> dict:
    doy = datetime.date.today().timetuple().tm_yday
    decl = 23.45 * math.sin(math.radians((360 / 365) * (doy - 81)))
    cos_ha = max(-1.0, min(1.0, -math.tan(math.radians(lat)) * math.tan(math.radians(decl))))
    sun_h = round(2 * math.degrees(math.acos(cos_ha)) / 15, 2)
    elev = round(max(5.0, 180.0 - abs(lat) * 1.4), 1)
    slope = round(max(1.0, min(18.0, abs(lat) * 0.25 + 3.5)), 2)
    ndvi = round(0.55 if abs(lat) < 23.5 else 0.38 if abs(lat) < 45 else 0.22, 3)
    rain = round(1600.0 if abs(lat) < 10 else 800.0 if abs(lat) < 30 else 500.0, 1)
    flood = round(min(0.95, max(0.02, 0.38*(1-elev/80) + 0.18*(1-slope/15) + 0.14*min(1, rain/2000))), 3)
    build = round(min(99, max(2, 100 - flood*38 - slope*0.9 + ndvi*8 + sun_h*1.2)), 1)
    wind_direction = "NE" if lat >= 0 else "SE"
    return {
        "elevation": elev, "slope": slope,
        "wind_ms": 4.2,
        "wind_direction": wind_direction,
        "rainfall_mm": rain,
        "soil_type": "Loam",
        "soil_buildable": True, "clay_fraction": 0.25,
        "ndvi": ndvi, "sun_exposure_hours": sun_h,
        "flood_probability": flood, "buildability_score": build,
        "soil_source": "Estimated (real providers unavailable)",
        "flood_source": "Estimated (real providers unavailable)",
    }


# ── Layer 1: Segmentation ─────────────────────────────────────────────────────
def run_segmentation(lat: float, lon: float) -> SegmentationResult:
    try:
        from ai.segmentation.model import run_segmentation as seg_fn
        dist = seg_fn(lat, lon)
        return SegmentationResult(
            vegetation=float(dist.get("vegetation", 0.3)),
            water=float(dist.get("water", 0.05)),
            urban=float(dist.get("urban", 0.15)),
            bare_soil=float(dist.get("bare_soil", 0.1)),
            road=float(dist.get("road", 0.05)),
        )
    except Exception as e:
        logger.warning(f"Segmentation failed ({e}), using synthetic")
    return _synthetic_seg(lat, lon)


# ── Layer 2: Tree detection ───────────────────────────────────────────────────
def run_tree_detection(lat: float, lon: float) -> list:
    try:
        from ai.detection.model import run_tree_detection as det_fn
        trees = det_fn(lat, lon)
        if trees:
            result = []
            for t in trees:
                if isinstance(t, TreeCoordinate):
                    result.append(t)
                elif isinstance(t, dict):
                    result.append(TreeCoordinate(
                        lat=float(t.get("lat", lat)),
                        lon=float(t.get("lon", t.get("lng", lon))),
                        confidence=float(t.get("confidence", 0.8)),
                    ))
            if result:
                return result
    except Exception as e:
        logger.warning(f"Tree detection failed ({e}), using synthetic")
    return _synthetic_trees(lat, lon)


# ── Layer 3: Real env data ────────────────────────────────────────────────────
async def _fetch_env_data(lat: float, lon: float) -> dict:
    try:
        from services.real_env_data import fetch_all_real_data
        data = await asyncio.wait_for(fetch_all_real_data(lat, lon), timeout=30.0)
        logger.info(f"Real env data fetched OK")
        return data
    except Exception as e:
        logger.warning(f"Real env data failed ({e}), using synthetic")
        return _synthetic_env(lat, lon)


# ── Layer 3: Flood risk ───────────────────────────────────────────────────────
def run_flood_model(env: dict) -> float:
    """Return flood probability.

    The real-data path (real_env_data.compute_flood_risk) blends topographic
    physics with live GloFAS discharge — this is the documented, real-data-driven
    value and is preferred. The XGBoost model (trained on synthetic data) is only
    a fallback for when no real value is available.
    """
    real = env.get("flood_probability")
    if real is not None:
        try:
            return round(float(real), 4)
        except (TypeError, ValueError):
            pass
    try:
        from ai.flood.model import predict_flood_probability
        return float(predict_flood_probability({
            "elevation":         env.get("elevation", 100.0),
            "slope":             env.get("slope", 5.0),
            "ndvi":              env.get("ndvi", 0.5),
            "rainfall_mm":       env.get("rainfall_mm", 800.0),
            "soil_type":         env.get("soil_type", "loam"),
            "distance_to_water": env.get("distance_to_water_m", 500.0),
        }))
    except Exception as e:
        logger.warning(f"Flood ML fallback failed ({e})")
        return 0.3


# ── Layer 4: Buildability ─────────────────────────────────────────────────────
def run_buildability_model(env: dict, flood: float) -> float:
    """Return buildability score [1, 99].

    Prefers the real-data physics score (real_env_data.compute_buildability,
    which integrates the full SoilGrids profile, NDVI, wind, solar and elevation).
    The sklearn MLP (trained on synthetic data) is only a fallback.
    """
    real = env.get("buildability_score")
    if real is not None:
        try:
            return round(float(real), 2)
        except (TypeError, ValueError):
            pass
    try:
        from ai.buildability.model import predict_buildability_score
        return float(predict_buildability_score({
            "flood_probability":  flood,
            "slope":              env.get("slope", 5.0),
            "soil_stability":     1.0 - env.get("clay_fraction", 0.25),
            "vegetation_density": env.get("ndvi", 0.5),
            "wind_exposure":      min(1.0, env.get("wind_ms", 3.0) / 15.0),
            "sun_exposure":       env.get("sun_exposure_hours", 6.0),
        }))
    except Exception as e:
        logger.warning(f"Buildability ML fallback failed ({e})")
        return 65.0


def _safe_json(v):
    """Convert any value to JSON-safe Python type."""
    if isinstance(v, (str, bool, type(None))):
        return v
    try:
        return float(v)
    except (TypeError, ValueError):
        return str(v)


# ── Main orchestrator ─────────────────────────────────────────────────────────
async def run_full_analysis(request: AnalyzePlotRequest, db: AsyncSession) -> AnalysisResponse:
    lat, lon, plot_id = request.lat, request.lon, request.plot_id

    loop = asyncio.get_running_loop()

    # Keep real-data layers intact when a single subsystem fails.
    seg_res, trees_res, env_res = await asyncio.gather(
        loop.run_in_executor(None, run_segmentation, lat, lon),
        loop.run_in_executor(None, run_tree_detection, lat, lon),
        _fetch_env_data(lat, lon),
        return_exceptions=True,
    )

    if isinstance(seg_res, Exception):
        logger.warning(f"Segmentation task failed ({seg_res}), using neutral fallback")
        seg = _synthetic_seg(lat, lon)
    else:
        seg = seg_res

    if isinstance(trees_res, Exception):
        logger.warning(f"Tree detection task failed ({trees_res}), using empty tree set")
        trees = _synthetic_trees(lat, lon)
    else:
        trees = trees_res

    if isinstance(env_res, Exception):
        logger.error(f"Environmental data task failed ({env_res}), using deterministic estimate")
        env_data = _synthetic_env(lat, lon)
    else:
        env_data = env_res

    flood = run_flood_model(env_data)
    build = run_buildability_model(env_data, flood)

    # DB persist — non-fatal
    try:
        existing = await db.execute(
            select(PlotRecord).where(PlotRecord.plot_id == plot_id)
        )
        if not existing.scalars().first():
            db.add(PlotRecord(
                plot_id=plot_id, lat=lat, lon=lon, polygon=request.polygon
            ))
        db.add(AnalysisRecord(
            plot_id=plot_id,
            segmentation_mask=seg.model_dump(),
            tree_coordinates=[t.model_dump() for t in trees],
            ndvi=float(env_data["ndvi"]),
            slope=float(env_data["slope"]),
            elevation=float(env_data["elevation"]),
            rainfall_mm=float(env_data["rainfall_mm"]),
            soil_type=str(env_data["soil_type"]),
            wind_direction=str(env_data["wind_direction"]),
            sun_exposure_hours=float(env_data["sun_exposure_hours"]),
            flood_probability=float(flood),
            buildability_score=float(build),
            raw_features={k: _safe_json(v) for k, v in {**env_data, "_lat": lat, "_lon": lon}.items()},
        ))
        await db.commit()
        logger.info(f"DB persist OK for {plot_id}")
    except Exception as e:
        logger.warning(f"DB persist failed (non-fatal): {e}")
        try:
            await db.rollback()
        except Exception:
            pass

    # Status is derived from the composite buildability score, which already
    # incorporates soil, flood, slope and elevation penalties (see
    # real_env_data.compute_buildability). We only hard-fail to NOT BUILDABLE on
    # the soil flag when the soil data is REAL — an estimated/fallback soil
    # profile must not contradict an otherwise good score.
    soil_source = str(env_data.get("soil_source", "")).lower()
    soil_is_real = bool(soil_source) and not soil_source.startswith("estimated")
    soil_unbuildable = soil_is_real and env_data.get("soil_buildable") is False

    if build < 30 or (soil_unbuildable and build < 40):
        status = "NOT BUILDABLE"
    elif build >= 80:
        status = "EXCELLENT"
    elif build >= 60:
        status = "GOOD"
    elif build >= 40:
        status = "FAIR"
    else:
        status = "POOR"

    def _f(key, default=None):
        v = env_data.get(key, default)
        try: return float(v) if v is not None else None
        except: return None

    return AnalysisResponse(
        plot_id=plot_id,
        segmentation=seg,
        tree_coordinates=trees,
        environmental=EnvironmentalFeatures(
            ndvi=float(env_data["ndvi"]),
            slope=float(env_data["slope"]),
            elevation=float(env_data["elevation"]),
            rainfall_mm=float(env_data["rainfall_mm"]),
            soil_type=str(env_data["soil_type"]),
            wind_direction=str(env_data["wind_direction"]),
            sun_exposure_hours=float(env_data["sun_exposure_hours"]),
            # Extended real-time fields
            wind_ms=_f("wind_ms"),
            solar_radiation_kwh=_f("solar_radiation_kwh"),
            distance_to_water_m=_f("distance_to_water_m"),
            # Full soil profile (SoilGrids v2)
            clay_pct=_f("clay_pct"),
            sand_pct=_f("sand_pct"),
            silt_pct=_f("silt_pct"),
            soil_ph=_f("soil_ph"),
            organic_carbon=_f("organic_carbon"),
            bulk_density=_f("bulk_density"),
            soil_buildable=bool(env_data["soil_buildable"]) if env_data.get("soil_buildable") is not None else None,
            soil_source=str(env_data["soil_source"]) if env_data.get("soil_source") else None,
            # River flood (GloFAS)
            river_discharge_peak_m3s=_f("river_discharge_peak_m3s"),
            river_discharge_mean_m3s=_f("river_discharge_mean_m3s"),
            glofas_flood_index=_f("glofas_flood_index"),
            flood_source=str(env_data["flood_source"]) if env_data.get("flood_source") else None,
        ),
        flood_probability=float(flood),
        buildability_score=float(build),
        status=status,
        score_references=[
            "FEMA Hazard Mitigation Standards: Flood probability and structural slope limits.",
            "LEED BD+C v4: Sustainable Sites requirements for soil stability and vegetation preservation.",
            "ASHRAE Standard 55: Thermal Environmental Conditions factoring in local wind and sun exposure.",
            "SoilGrids v2 (ISRIC/WUR): Soil clay, sand, silt, pH, organic carbon, bulk density at 250m resolution.",
            "Open-Meteo GloFAS (EU Copernicus): Real-time 90-day river discharge forecast.",
            "NASA POWER API: Satellite-derived NDVI proxy and daily solar radiation.",
        ],
    )
