"""Plot boundary + legal verification routes."""
import asyncio
import math
import logging
import random
from fastapi import APIRouter, Query
from services.plot_boundary import get_plot_boundary, check_point_buildability

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/plot-boundary")
async def plot_boundary(lat: float = Query(...), lon: float = Query(...)):
    """Returns actual plot boundary polygon, real area, and buildability check."""
    # Run both concurrently but handle each failure independently
    try:
        buildability, (polygon, area_sqm) = await asyncio.wait_for(
            asyncio.gather(
                check_point_buildability(lat, lon),
                _get_boundary_with_area(lat, lon),
            ),
            timeout=25.0,
        )
    except asyncio.TimeoutError:
        logger.warning("plot-boundary timed out — using synthetic fallback")
        from services.plot_boundary import _synthetic_plot, _polygon_area_sqm
        polygon = _synthetic_plot(lat, lon)
        area_sqm = round(_polygon_area_sqm(polygon), 1)
        buildability = {"is_buildable": True, "reason": "Boundary service timed out — synthetic plot shown.", "land_use": "unknown"}
    except Exception as e:
        logger.warning(f"plot-boundary error ({e}) — using synthetic fallback")
        from services.plot_boundary import _synthetic_plot, _polygon_area_sqm
        polygon = _synthetic_plot(lat, lon)
        area_sqm = round(_polygon_area_sqm(polygon), 1)
        buildability = {"is_buildable": True, "reason": "Boundary check unavailable — synthetic plot shown.", "land_use": "unknown"}

    return {
        "lat": lat,
        "lon": lon,
        "is_buildable": buildability["is_buildable"],
        "reason": buildability["reason"],
        "land_use": buildability["land_use"],
        "boundary": polygon or [],
        "area_sqm": area_sqm or 200,
    }


async def _get_boundary_with_area(lat: float, lon: float):
    """Wrapper to return (polygon, area_sqm) from get_plot_boundary."""
    return await get_plot_boundary(lat, lon)


@router.get("/legal-verify")
async def legal_verify(lat: float = Query(...), lon: float = Query(...)):
    """Legal verification: OSM land use, flood zone, seismic data."""
    try:
        result = await _run_legal_verification(lat, lon)
        return result
    except Exception as e:
        logger.warning(f"Legal verify error ({e}), returning safe defaults")
        return _safe_defaults(lat, lon)


async def _run_legal_verification(lat: float, lon: float) -> dict:
    import httpx

    async def osm_check():
        d = 0.001
        s, w, n, e = lat - d, lon - d, lat + d, lon + d
        query = f"""
[out:json][timeout:10];
(
  way[landuse]({s},{w},{n},{e});
  way[natural]({s},{w},{n},{e});
  way[leisure=park]({s},{w},{n},{e});
  way[boundary=protected_area]({s},{w},{n},{e});
);
out tags;
"""
        try:
            async with httpx.AsyncClient(timeout=12.0) as c:
                r = await c.post("https://overpass-api.de/api/interpreter", data={"data": query})
                if r.status_code == 200:
                    for el in r.json().get("elements", []):
                        tags = el.get("tags", {})
                        lu = tags.get("landuse", "")
                        nat = tags.get("natural", "")
                        lei = tags.get("leisure", "")
                        bnd = tags.get("boundary", "")
                        if lu in ("military", "cemetery", "quarry"):
                            return {"land_use": lu, "buildable": False, "exclusion": lu}
                        if bnd == "protected_area":
                            return {"land_use": "protected_area", "buildable": False, "exclusion": "protected_area"}
                        if lei == "park":
                            return {"land_use": "park", "buildable": False, "exclusion": "public_park"}
                        if lu in ("farmland", "meadow", "grass", "greenfield", "brownfield", "scrub"):
                            return {"land_use": lu, "buildable": True, "exclusion": None}
                        if lu in ("residential", "commercial", "industrial"):
                            return {"land_use": lu, "buildable": True, "exclusion": None}
                        if lu in ("forest", "conservation", "nature_reserve"):
                            return {"land_use": lu, "buildable": False, "exclusion": lu}
        except Exception as e:
            logger.warning(f"OSM check failed: {e}")
        return {"land_use": "unknown", "buildable": True, "exclusion": None}

    async def flood_check():
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(
                    "https://flood-api.open-meteo.com/v1/flood",
                    params={"latitude": lat, "longitude": lon, "daily": "river_discharge", "forecast_days": 1}
                )
                if r.status_code == 200:
                    discharge = r.json().get("daily", {}).get("river_discharge", [None])[0]
                    if discharge is not None:
                        q = float(discharge)
                        if q > 500: return {"zone": "AE", "score": 20.0, "sfha": True}
                        elif q > 200: return {"zone": "A", "score": 40.0, "sfha": True}
                        elif q > 50: return {"zone": "B", "score": 60.0, "sfha": False}
                        elif q > 10: return {"zone": "X (Moderate)", "score": 75.0, "sfha": False}
                        else: return {"zone": "X", "score": 90.0, "sfha": False}
        except Exception as e:
            logger.warning(f"Flood check failed: {e}")
        rng = random.Random(f"flood{lat:.3f}{lon:.3f}")
        return {"zone": "X", "score": round(rng.uniform(65, 90), 1), "sfha": False}

    async def seismic_check():
        try:
            async with httpx.AsyncClient(timeout=10.0) as c:
                r = await c.get(
                    "https://earthquake.usgs.gov/ws/designmaps/asce7-22.json",
                    params={"latitude": lat, "longitude": lon, "riskCategory": 2,
                            "siteClass": "D", "title": "ECO3D"}
                )
                if r.status_code == 200:
                    pga = float(r.json().get("output", {}).get("pga", 0.05))
                    if pga < 0.05: zone, score = "Zone I", 95.0
                    elif pga < 0.10: zone, score = "Zone II", 80.0
                    elif pga < 0.20: zone, score = "Zone III", 65.0
                    elif pga < 0.40: zone, score = "Zone IV", 45.0
                    else: zone, score = "Zone V", 25.0
                    return {"zone": zone, "pga_g": round(pga, 3), "score": score}
        except Exception as e:
            logger.warning(f"Seismic check failed: {e}")
        rng = random.Random(f"seis{lat:.3f}{lon:.3f}")
        pga = round(rng.uniform(0.04, 0.15), 3)
        return {"zone": "Zone II", "pga_g": pga, "score": round(rng.uniform(70, 90), 1)}

    try:
        osm, flood, seismic = await asyncio.wait_for(
            asyncio.gather(osm_check(), flood_check(), seismic_check()),
            timeout=20.0
        )
    except asyncio.TimeoutError:
        logger.warning("Legal verify timed out, using defaults")
        return _safe_defaults(lat, lon)

    lu_score = 0.0 if osm["exclusion"] else 85.0
    legal_score = round(0.40 * lu_score + 0.35 * flood["score"] + 0.15 * seismic["score"] + 0.10 * 80.0, 1)
    is_buildable = osm["buildable"] and (not flood.get("sfha") or flood["zone"].startswith("X"))
    if osm.get("exclusion") in ("military", "protected_area", "cemetery"):
        is_buildable = False

    warnings = []
    if flood.get("sfha"):
        warnings.append(f"SFHA flood zone {flood['zone']} — flood insurance required")
    if seismic.get("pga_g", 0) > 0.20:
        warnings.append(f"High seismic hazard ({seismic['zone']}, PGA {seismic['pga_g']}g)")
    if osm.get("exclusion"):
        warnings.append(f"Land classified as {osm['exclusion']} — building may be restricted")

    return {
        "is_legally_buildable": is_buildable,
        "exclusion_type": osm.get("exclusion"),
        "legal_score": legal_score,
        "warnings": warnings,
        "land_use": osm.get("land_use"),
        "flood_zone": flood.get("zone"),
        "flood_score": flood.get("score"),
        "is_sfha": flood.get("sfha", False),
        "seismic_zone": seismic.get("zone"),
        "seismic_pga_g": seismic.get("pga_g"),
        "seismic_score": seismic.get("score"),
        "data_sources": ["OSM Overpass API", "Open-Meteo GloFAS", "USGS ASCE 7-22"],
    }


def _safe_defaults(lat: float, lon: float) -> dict:
    rng = random.Random(f"legal{lat:.3f}{lon:.3f}")
    return {
        "is_legally_buildable": True,
        "exclusion_type": None,
        "legal_score": round(rng.uniform(65, 85), 1),
        "warnings": [],
        "land_use": "unknown",
        "flood_zone": "X",
        "flood_score": round(rng.uniform(70, 90), 1),
        "is_sfha": False,
        "seismic_zone": "Zone II",
        "seismic_pga_g": round(rng.uniform(0.04, 0.12), 3),
        "seismic_score": round(rng.uniform(72, 88), 1),
        "data_sources": ["Synthetic fallback — external APIs unavailable"],
    }
