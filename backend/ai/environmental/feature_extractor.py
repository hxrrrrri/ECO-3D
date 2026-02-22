"""
Layer 2: Environmental Feature Engineering
Computes: NDVI, slope (DEM), elevation, rainfall, soil type,
          wind direction/speed, sun exposure
"""
import numpy as np
import math
import logging
import os

logger = logging.getLogger(__name__)

SOIL_TYPES_BY_REGION = {
    # Simplified: real system would use global soil database (HWSD, SoilGrids)
    "sandy": {"type": "Sandy Loam", "clay": 15, "silt": 20, "sand": 65},
    "clay": {"type": "Clay", "clay": 60, "silt": 25, "sand": 15},
    "loam": {"type": "Loam", "clay": 25, "silt": 40, "sand": 35},
    "silt": {"type": "Silt Loam", "clay": 20, "silt": 65, "sand": 15},
}

WIND_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


class EnvironmentalFeatureExtractor:
    def __init__(self):
        self.openweather_key = os.environ.get("OPENWEATHER_API_KEY", "")

    def _compute_ndvi_from_bands(self, red: np.ndarray, nir: np.ndarray) -> float:
        """Compute NDVI = (NIR - RED) / (NIR + RED). Requires multispectral bands."""
        denom = nir + red
        denom = np.where(denom == 0, 1e-6, denom)
        ndvi = (nir.astype(float) - red.astype(float)) / denom
        return float(np.clip(ndvi.mean(), -1, 1))

    def _estimate_ndvi_from_rgb(self, lat: float, lng: float) -> float:
        """
        Estimate NDVI from visible-light satellite tile.
        Real system uses Sentinel-2 bands B4 (red) and B8 (NIR).
        Here: proxy using green channel ratio.
        """
        try:
            import requests
            from PIL import Image
            import io

            n = 2 ** 16
            lat_r = math.radians(lat)
            x = int((lng + 180) / 360 * n)
            y = int((1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n)
            url = f"https://tile.openstreetmap.org/16/{x % (2**16)}/{y % (2**16)}.png"
            resp = requests.get(url, headers={"User-Agent": "ECO3D/1.0"}, timeout=8)
            img = np.array(Image.open(io.BytesIO(resp.content)).convert("RGB"))
            r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
            # Proxy: greenness ratio (no NIR available in RGB)
            green_idx = (g.astype(float) - r.astype(float)) / (g.astype(float) + r.astype(float) + 1e-6)
            return round(float(np.clip(green_idx.mean() * 2.5 + 0.3, -0.2, 0.95)), 2)
        except Exception as e:
            logger.warning(f"NDVI estimation failed: {e}. Using synthetic value.")
            return round(np.random.uniform(0.3, 0.85), 2)

    def _fetch_elevation(self, lat: float, lng: float) -> float:
        """Fetch elevation from Open-Elevation API."""
        try:
            import requests
            resp = requests.get(
                "https://api.open-elevation.com/api/v1/lookup",
                params={"locations": f"{lat},{lng}"},
                timeout=8,
            )
            data = resp.json()
            return float(data["results"][0]["elevation"])
        except Exception:
            # Synthetic: base + noise
            return round(abs(math.sin(lat) * math.cos(lng)) * 500 + np.random.uniform(10, 50), 1)

    def _compute_slope(self, lat: float, lng: float, elevation: float) -> float:
        """
        Estimate slope from DEM by sampling elevation at 4 neighbors.
        Real: use SRTM/Copernicus DEM raster with gdal.
        """
        try:
            delta = 0.0005  # ~50m
            def get_elev(dlat, dlng):
                import requests
                resp = requests.get(
                    "https://api.open-elevation.com/api/v1/lookup",
                    params={"locations": f"{lat+dlat},{lng+dlng}"},
                    timeout=5,
                )
                return float(resp.json()["results"][0]["elevation"])

            e_n = get_elev(delta, 0)
            e_s = get_elev(-delta, 0)
            e_e = get_elev(0, delta)
            e_w = get_elev(0, -delta)

            # Grid spacing in meters
            d = delta * 111320  # degrees to meters
            dz_dx = (e_e - e_w) / (2 * d)
            dz_dy = (e_n - e_s) / (2 * d)
            slope_deg = math.degrees(math.atan(math.sqrt(dz_dx**2 + dz_dy**2)))
            slope_pct = math.tan(math.radians(slope_deg)) * 100
            return round(slope_pct, 1)
        except Exception:
            return round(np.random.uniform(3.0, 25.0), 1)

    def _fetch_rainfall(self, lat: float, lng: float) -> float:
        """Fetch annual rainfall from OpenWeatherMap or estimation."""
        try:
            if not self.openweather_key:
                raise ValueError("No API key")
            import requests
            resp = requests.get(
                "https://api.openweathermap.org/data/2.5/climate/month",
                params={"lat": lat, "lon": lng, "appid": self.openweather_key, "units": "metric"},
                timeout=8,
            )
            # OpenWeather doesn't expose annual directly; proxy from current
            data = resp.json()
            monthly_rain = data.get("list", [{}])[0].get("rain", {}).get("all", 30)
            return round(monthly_rain * 12, 0)
        except Exception:
            # Fallback: latitude-based estimate
            tropical_factor = max(0, 1 - abs(lat - 10) / 45)
            return round(200 + tropical_factor * 2000 + np.random.uniform(-100, 100), 0)

    def _get_soil_type(self, lat: float, lng: float) -> dict:
        """
        Determine soil type from location.
        Real: query HWSD (Harmonized World Soil Database) or SoilGrids API.
        Simplified: rule-based by latitude/terrain.
        """
        # Very simplified: tropical = loam, arid = sandy, temperate = clay
        if abs(lat) < 20:
            key = "loam"
        elif abs(lat) < 40:
            key = "clay"
        else:
            key = "silt"
        return SOIL_TYPES_BY_REGION[key]

    def _compute_wind(self, lat: float, lng: float) -> tuple:
        """Return (wind_direction, wind_speed_ms)."""
        try:
            if not self.openweather_key:
                raise ValueError("No API key")
            import requests
            resp = requests.get(
                "https://api.openweathermap.org/data/2.5/weather",
                params={"lat": lat, "lon": lng, "appid": self.openweather_key},
                timeout=8,
            )
            data = resp.json()["wind"]
            deg = data.get("deg", 315)
            speed = data.get("speed", 2.5)
            direction = WIND_DIRECTIONS[round(deg / 45) % 8]
            return direction, round(speed, 1)
        except Exception:
            idx = int((lat + lng) * 10) % len(WIND_DIRECTIONS)
            return WIND_DIRECTIONS[idx], round(np.random.uniform(0.5, 5.0), 1)

    def _compute_sun_exposure(self, lat: float) -> float:
        """
        Estimate average daily sun exposure hours.
        Simplified: based on latitude and season average.
        """
        # At equator: ~12h, decreases toward poles
        base = 12 - abs(lat) * 0.1
        return round(max(4, min(16, base + np.random.uniform(-1, 1))), 1)

    def extract(self, lat: float, lng: float, polygon=None) -> dict:
        """Extract all environmental features for the given location."""
        ndvi = self._estimate_ndvi_from_rgb(lat, lng)
        elevation = self._fetch_elevation(lat, lng)
        slope = self._compute_slope(lat, lng, elevation)
        rainfall = self._fetch_rainfall(lat, lng)
        soil = self._get_soil_type(lat, lng)
        wind_dir, wind_speed = self._compute_wind(lat, lng)
        sun = self._compute_sun_exposure(lat)

        # Distance to nearest water body (synthetic; real: query OSM water features)
        distance_to_water_m = round(abs(math.sin(lat * 0.1) * math.cos(lng * 0.1)) * 2000 + 50, 0)

        return {
            "ndvi": ndvi,
            "slope_pct": slope,
            "elevation_m": elevation,
            "rainfall_mm": rainfall,
            "soil_type": soil["type"],
            "clay_pct": soil["clay"],
            "silt_pct": soil["silt"],
            "sand_pct": soil["sand"],
            "wind_direction": wind_dir,
            "wind_speed_ms": wind_speed,
            "sun_exposure_hours": sun,
            "distance_to_water_m": distance_to_water_m,
        }
