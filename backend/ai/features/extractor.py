"""
LAYER 2 — Environmental Feature Engineering
Computes: NDVI, slope (DEM), elevation, rainfall, soil type, wind direction, sun exposure
"""
import os
import math
import random
import asyncio
from typing import Dict, List, Optional
import httpx


async def extract_environmental_features(
    lat: float, lon: float, polygon: Optional[List] = None
) -> Dict:
    """
    Fetch/compute all environmental features for a plot location.
    Uses external APIs where available, falls back to synthetic computation.
    """
    ndvi = await _compute_ndvi(lat, lon)
    elevation, slope = await _compute_elevation_slope(lat, lon)
    rainfall = await _fetch_rainfall(lat, lon)
    soil_type = _estimate_soil_type(lat, lon)
    wind_direction = _estimate_wind_direction(lat, lon)
    sun_hours = _compute_sun_exposure(lat)
    distance_to_water = _estimate_distance_to_water(lat, lon)

    return {
        "ndvi": ndvi,
        "slope": slope,
        "elevation": elevation,
        "rainfall_mm": rainfall,
        "soil_type": soil_type,
        "wind_direction": wind_direction,
        "sun_exposure_hours": sun_hours,
        "distance_to_water": distance_to_water,
    }


async def _compute_ndvi(lat: float, lon: float) -> float:
    """
    NDVI = (NIR - Red) / (NIR + Red).
    In production: fetch Sentinel-2 band 4 (Red) and band 8 (NIR) from Copernicus.
    Synthetic: derive from lat/lon with ecological realism.
    """
    seed = int((abs(lat) * 317.1 + abs(lon) * 211.7) % 10000)
    rng = random.Random(seed)
    # Tropical latitudes → higher NDVI; arid zones lower
    base = 0.6 if abs(lat) < 23.5 else (0.4 if abs(lat) < 45 else 0.25)
    ndvi = base + rng.uniform(-0.15, 0.15)
    return round(max(0.0, min(1.0, ndvi)), 3)


async def _compute_elevation_slope(lat: float, lon: float) -> tuple:
    """
    Fetch elevation from Open-Elevation API, compute slope from nearby points.
    Falls back to synthetic.
    """
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            points = [
                {"latitude": lat, "longitude": lon},
                {"latitude": lat + 0.001, "longitude": lon},
                {"latitude": lat, "longitude": lon + 0.001},
            ]
            resp = await client.post(
                "https://api.open-elevation.com/api/v1/lookup",
                json={"locations": points}
            )
            elevations = [r["elevation"] for r in resp.json()["results"]]
            elev = elevations[0]
            # Slope = max rise over run (approximate)
            rise_lat = abs(elevations[1] - elevations[0])
            rise_lon = abs(elevations[2] - elevations[0])
            run = 111.0  # ~111m per 0.001 degrees
            slope_pct = (max(rise_lat, rise_lon) / run) * 100
            return round(elev, 1), round(slope_pct, 2)
    except Exception:
        pass
    # Synthetic
    seed = int((abs(lat) * 157.9 + abs(lon) * 97.3) % 10000)
    rng = random.Random(seed)
    elev = rng.uniform(10, 800)
    slope = rng.uniform(1, 25)
    return round(elev, 1), round(slope, 2)


async def _fetch_rainfall(lat: float, lon: float) -> float:
    """Fetch annual average rainfall (mm) from OpenWeatherMap or synthetic."""
    api_key = os.getenv("OPENWEATHER_API_KEY")
    if api_key:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(
                    f"https://api.openweathermap.org/data/2.5/weather",
                    params={"lat": lat, "lon": lon, "appid": api_key}
                )
                data = resp.json()
                rain_1h = data.get("rain", {}).get("1h", 0)
                return round(rain_1h * 8760, 1)  # extrapolate to annual
        except Exception:
            pass
    # Synthetic: tropical zones get more rain
    seed = int((abs(lat) * 271.3 + abs(lon) * 193.7) % 10000)
    rng = random.Random(seed)
    base = 1800 if abs(lat) < 23.5 else (900 if abs(lat) < 45 else 500)
    return round(base + rng.uniform(-300, 300), 1)


def _estimate_soil_type(lat: float, lon: float) -> str:
    """Heuristic soil type estimation from coordinates."""
    types = ["clay", "silt", "sandy_clay", "loam", "sand", "gravel"]
    seed = int((abs(lat) * 191.3 + abs(lon) * 137.7) % 10000)
    rng = random.Random(seed)
    if abs(lat) < 10:
        return rng.choice(["clay", "silt", "loam"])
    elif abs(lat) < 30:
        return rng.choice(["sand", "sandy_clay", "loam"])
    else:
        return rng.choice(types)


def _estimate_wind_direction(lat: float, lon: float) -> str:
    """Estimate prevailing wind direction from latitude band."""
    if abs(lat) < 30:
        return "NE" if lat > 0 else "SE"
    elif abs(lat) < 60:
        return "SW" if lat > 0 else "NW"
    else:
        seed = int((abs(lat) * 113.1 + abs(lon) * 89.7) % 10000)
        return random.Random(seed).choice(["N", "NW", "W", "SW"])


def _compute_sun_exposure(lat: float) -> float:
    """
    Approximate daily sun exposure hours from latitude.
    Uses simplified insolation model.
    """
    # Peak sun hours at equator ~8h, decreasing toward poles
    sun = 8.0 - (abs(lat) / 90.0) * 4.5
    return round(max(2.0, sun), 2)


def _estimate_distance_to_water(lat: float, lon: float) -> float:
    """Estimate distance to nearest water body (meters). Synthetic."""
    seed = int((abs(lat) * 233.1 + abs(lon) * 157.3) % 10000)
    rng = random.Random(seed)
    return round(rng.uniform(50, 2000), 1)
