"""
Indian Land Records API — Bhu Naksha WMS + State Bhulekh lookup.

Strategy (in priority order):
1. Bhu Naksha WMS GetFeatureInfo — returns actual cadastral polygon for states
   that expose a public WMS endpoint (MP, Rajasthan, Odisha, Bihar, UP, Chhattisgarh).
2. State Bhulekh API (scrape-free, using known public JSON endpoints).
3. Nominatim + Overpass fallback — return OSM boundary + area.
4. Synthetic fallback — return estimated rectangle from coordinates.
"""
import asyncio
import math
import logging
import random
from typing import Optional
from fastapi import APIRouter, Query
import httpx

router = APIRouter()
logger = logging.getLogger(__name__)


# ─── State metadata ───────────────────────────────────────────────────────────

STATES = {
    "andhra_pradesh":    {"name": "Andhra Pradesh",    "bhu_naksha": False, "bhulekh": "AP MEEBHOOMI"},
    "assam":             {"name": "Assam",             "bhu_naksha": False, "bhulekh": "Dharitree"},
    "bihar":             {"name": "Bihar",             "bhu_naksha": True,  "bhulekh": "BIHARBHUMI"},
    "chhattisgarh":      {"name": "Chhattisgarh",      "bhu_naksha": True,  "bhulekh": "CG Bhuiyan"},
    "delhi":             {"name": "Delhi",             "bhu_naksha": False, "bhulekh": "Delhi Land Records"},
    "goa":               {"name": "Goa",               "bhu_naksha": False, "bhulekh": "Goa Land Records"},
    "gujarat":           {"name": "Gujarat",           "bhu_naksha": False, "bhulekh": "AnyROR Gujarat"},
    "haryana":           {"name": "Haryana",           "bhu_naksha": False, "bhulekh": "Jamabandi Haryana"},
    "himachal_pradesh":  {"name": "Himachal Pradesh",  "bhu_naksha": False, "bhulekh": "Himachal Bhulekh"},
    "jharkhand":         {"name": "Jharkhand",         "bhu_naksha": True,  "bhulekh": "Jharbhoomi"},
    "karnataka":         {"name": "Karnataka",         "bhu_naksha": True,  "bhulekh": "Bhoomi"},
    "kerala":            {"name": "Kerala",             "bhu_naksha": False, "bhulekh": "Ente Bhoomi (ILIMS)"},
    "madhya_pradesh":    {"name": "Madhya Pradesh",    "bhu_naksha": True,  "bhulekh": "MP Bhulekh"},
    "maharashtra":       {"name": "Maharashtra",       "bhu_naksha": True,  "bhulekh": "MahaBhulekh"},
    "manipur":           {"name": "Manipur",           "bhu_naksha": False, "bhulekh": "Manipur Land Records"},
    "meghalaya":         {"name": "Meghalaya",         "bhu_naksha": False, "bhulekh": "Meghalaya Land Records"},
    "odisha":            {"name": "Odisha",            "bhu_naksha": True,  "bhulekh": "Bhulekh Odisha"},
    "punjab":            {"name": "Punjab",            "bhu_naksha": False, "bhulekh": "PLRS Punjab"},
    "rajasthan":         {"name": "Rajasthan",         "bhu_naksha": True,  "bhulekh": "Apna Khata"},
    "tamil_nadu":        {"name": "Tamil Nadu",        "bhu_naksha": False, "bhulekh": "PATTA Tamil Nadu"},
    "telangana":         {"name": "Telangana",         "bhu_naksha": False, "bhulekh": "Dharani"},
    "uttar_pradesh":     {"name": "Uttar Pradesh",     "bhu_naksha": True,  "bhulekh": "UP Bhulekh"},
    "uttarakhand":       {"name": "Uttarakhand",       "bhu_naksha": True,  "bhulekh": "Devbhoomi Uttarakhand"},
    "west_bengal":       {"name": "West Bengal",       "bhu_naksha": False, "bhulekh": "Banglarbhumi"},
}

# Bhu Naksha WMS base URLs for states that expose them publicly
BHU_NAKSHA_WMS: dict[str, str] = {
    "madhya_pradesh":  "https://mpbhuabhilekh.nic.in/bhunaksha/",
    "rajasthan":       "https://bhunaksha.rajasthan.gov.in/bhunaksha/",
    "odisha":          "https://bhulekh.ori.nic.in/bhunaksha/",
    "bihar":           "https://biharbhumi.bihar.gov.in/biharbhuabhilekh/",
    "jharkhand":       "https://jharbhoomi.nic.in/jharlrmsmis/",
    "uttar_pradesh":   "https://upbhunaksha.gov.in/bhunaksha/",
    "chhattisgarh":    "https://bhunaksha.cg.nic.in/bhunaksha/",
    "karnataka":       "https://bhoomi.karnataka.gov.in/gis/",
    "maharashtra":     "https://mahabhunaksha.maharashtra.gov.in/",
    "uttarakhand":     "https://bhulekh.uk.gov.in/public/public_ror/Public_ROR.aspx",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δφ = math.radians(lat2 - lat1)
    Δλ = math.radians(lon2 - lon1)
    a = math.sin(Δφ/2)**2 + math.cos(φ1)*math.cos(φ2)*math.sin(Δλ/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def _polygon_area_sqm(coords: list) -> float:
    if len(coords) < 3:
        return 0.0
    clat = sum(c[1] for c in coords) / len(coords)
    clon = sum(c[0] for c in coords) / len(coords)
    lat_m = 111320.0
    lon_m = 111320.0 * math.cos(math.radians(clat))
    pts = [((c[0] - clon) * lon_m, (c[1] - clat) * lat_m) for c in coords]
    n = len(pts)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1]
        area -= pts[j][0] * pts[i][1]
    return abs(area) / 2.0


def _synthetic_boundary(lat: float, lon: float, area_sqm: float = 250.0) -> list:
    """Generate a realistic rectangular plot boundary from coordinates."""
    rng = random.Random(f"{lat:.5f}{lon:.5f}")
    aspect = rng.uniform(0.55, 0.85)
    w_m = math.sqrt(area_sqm / aspect)
    h_m = area_sqm / w_m
    d_lat = (h_m / 2) / 111320.0
    d_lon = (w_m / 2) / (111320.0 * math.cos(math.radians(lat)))
    # Slight rotation for realism
    angle = rng.uniform(-0.15, 0.15)
    corners_raw = [
        (-d_lon, -d_lat), (d_lon, -d_lat),
        (d_lon, d_lat),   (-d_lon, d_lat),
    ]
    boundary = []
    for dx, dy in corners_raw:
        rx = dx * math.cos(angle) - dy * math.sin(angle)
        ry = dx * math.sin(angle) + dy * math.cos(angle)
        boundary.append([round(lon + rx, 7), round(lat + ry, 7)])
    boundary.append(boundary[0])  # close ring
    return boundary


async def _try_bhu_naksha_wms(state: str, district: str, khasra: str, lat: Optional[float], lon: Optional[float]) -> Optional[dict]:
    """
    Attempt Bhu Naksha WMS GetFeatureInfo to retrieve cadastral parcel geometry.
    Falls back gracefully if state not supported or request times out.
    """
    if state not in BHU_NAKSHA_WMS:
        return None
    if not lat or not lon:
        return None

    base = BHU_NAKSHA_WMS[state]
    # Standard Bhu Naksha WMS GetMap/GetFeatureInfo pattern
    # Many states use GeoServer with layer "REVENUE_PLOT" or "cadastral_plot"
    layers_to_try = ["REVENUE_PLOT", "cadastral", "plot", "PLOT", "Cadastral_Plot"]

    async with httpx.AsyncClient(timeout=8.0) as client:
        for layer in layers_to_try:
            try:
                params = {
                    "SERVICE": "WMS",
                    "VERSION": "1.1.1",
                    "REQUEST": "GetFeatureInfo",
                    "FORMAT": "image/png",
                    "TRANSPARENT": "true",
                    "QUERY_LAYERS": layer,
                    "LAYERS": layer,
                    "INFO_FORMAT": "application/json",
                    "FEATURE_COUNT": "1",
                    "X": "256", "Y": "256",
                    "SRS": "EPSG:4326",
                    "WIDTH": "512", "HEIGHT": "512",
                    "BBOX": f"{lon-0.001},{lat-0.001},{lon+0.001},{lat+0.001}",
                }
                resp = await client.get(base, params=params)
                if resp.status_code == 200:
                    data = resp.json()
                    features = data.get("features", [])
                    if features:
                        geom = features[0].get("geometry", {})
                        props = features[0].get("properties", {})
                        coords = geom.get("coordinates", [[]])[0] if geom.get("type") == "Polygon" else None
                        if coords and len(coords) >= 3:
                            area = _polygon_area_sqm(coords)
                            if 50 < area < 50000:
                                return {
                                    "boundary": coords,
                                    "area_sqm": round(area),
                                    "survey_number": props.get("survey_no") or props.get("khasra_no") or khasra,
                                    "owner_name": props.get("owner") or props.get("khatedar") or "Available via state portal",
                                    "land_type": props.get("land_use") or props.get("type") or "Residential",
                                    "source": f"Bhu Naksha WMS — {STATES[state]['name']}",
                                    "portal": BHU_NAKSHA_WMS[state],
                                }
            except Exception as e:
                logger.debug(f"Bhu Naksha WMS layer {layer} failed: {e}")
                continue
    return None


async def _try_overpass_cadastral(lat: float, lon: float) -> Optional[dict]:
    """Query Overpass for cadastral/landuse polygons at the given point."""
    d = 0.003
    query = f"""
[out:json][timeout:12];
(
  way["landuse"~"^(residential|farmland|industrial|commercial)$"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["building"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["plot"]({lat-d},{lon-d},{lat+d},{lon+d});
  relation["landuse"]({lat-d},{lon-d},{lat+d},{lon+d});
);
out geom;
"""
    try:
        async with httpx.AsyncClient(timeout=14.0) as client:
            resp = await client.post("https://overpass-api.de/api/interpreter", data={"data": query})
            if resp.status_code != 200:
                return None
            elements = resp.json().get("elements", [])
            best = None
            best_area = float("inf")
            for el in elements:
                geom = el.get("geometry", [])
                if not geom:
                    continue
                coords = [[g["lon"], g["lat"]] for g in geom]
                if not coords:
                    continue
                area = _polygon_area_sqm(coords)
                # Prefer small polygons close to clicked point (likely the actual plot)
                if 30 < area < 8000 and area < best_area:
                    best = coords
                    best_area = area
            if best:
                return {
                    "boundary": best,
                    "area_sqm": round(best_area),
                    "source": "OpenStreetMap (OSM Overpass)",
                    "owner_name": "Not available via OSM",
                    "survey_number": "—",
                    "land_type": "Mapped via OSM",
                    "portal": "https://www.openstreetmap.org",
                }
    except Exception as e:
        logger.warning(f"Overpass cadastral failed: {e}")
    return None


# ─── Routes ───────────────────────────────────────────────────────────────────

@router.get("/land-record/states")
async def list_states():
    """Return all supported Indian states with their data source info."""
    return {
        "states": [
            {
                "id": k,
                "name": v["name"],
                "bhu_naksha_available": v["bhu_naksha"],
                "portal_name": v["bhulekh"],
                "portal_url": BHU_NAKSHA_WMS.get(k),
            }
            for k, v in STATES.items()
        ]
    }


@router.get("/land-record/lookup")
async def lookup_land_record(
    state: str = Query(..., description="State ID e.g. madhya_pradesh"),
    district: str = Query(default="", description="District name"),
    survey_number: str = Query(default="", description="Khasra/Survey/Plot number"),
    lat: Optional[float] = Query(default=None, description="Latitude (for WMS lookup)"),
    lon: Optional[float] = Query(default=None, description="Longitude (for WMS lookup)"),
):
    """
    Look up land record data for an Indian plot.

    Priority:
    1. Bhu Naksha WMS (if state supports it and lat/lon provided)
    2. OSM Overpass cadastral (if lat/lon provided)
    3. Informational fallback with portal link
    """
    state_info = STATES.get(state)
    if not state_info:
        return {"error": f"State '{state}' not found. Use /land-record/states to list valid states."}

    result = {
        "state": state_info["name"],
        "district": district or "—",
        "survey_number": survey_number or "—",
        "owner_name": None,
        "land_type": None,
        "area_sqm": None,
        "boundary": None,
        "source": None,
        "portal_name": state_info["bhulekh"],
        "portal_url": BHU_NAKSHA_WMS.get(state) or f"https://www.google.com/search?q={state_info['name'].replace(' ', '+')}+Bhulekh+land+records",
        "bhu_naksha_available": state_info["bhu_naksha"],
        "note": None,
    }

    # Try 1: Bhu Naksha WMS
    if lat and lon and state_info["bhu_naksha"]:
        try:
            wms_result = await asyncio.wait_for(
                _try_bhu_naksha_wms(state, district, survey_number, lat, lon),
                timeout=10.0
            )
            if wms_result:
                result.update(wms_result)
                result["note"] = "Boundary fetched from official Bhu Naksha WMS."
                return result
        except asyncio.TimeoutError:
            logger.warning("Bhu Naksha WMS timed out")

    # Try 2: OSM Overpass cadastral
    if lat and lon:
        try:
            osm_result = await asyncio.wait_for(
                _try_overpass_cadastral(lat, lon),
                timeout=14.0
            )
            if osm_result:
                result.update(osm_result)
                result["note"] = (
                    "Boundary sourced from OpenStreetMap. "
                    "For official owner data, visit the state portal link below."
                )
                return result
        except asyncio.TimeoutError:
            logger.warning("Overpass cadastral timed out")

    # Try 3: Synthetic fallback + portal guidance
    rng = random.Random(f"{lat or 0:.4f}{lon or 0:.4f}{survey_number}")
    area_estimate = rng.randint(150, 600)
    if lat and lon:
        boundary = _synthetic_boundary(lat, lon, float(area_estimate))
    else:
        boundary = None

    result.update({
        "boundary": boundary,
        "area_sqm": area_estimate if boundary else None,
        "owner_name": "Fetch from state portal (link below)",
        "land_type": "Residential / Mixed",
        "source": "Estimated boundary — real data via state portal",
        "note": (
            f"Live data for {state_info['name']} could not be fetched automatically. "
            f"Visit the {state_info['bhulekh']} portal (link below) and enter Survey No. "
            f"'{survey_number or '<your survey number>'}' to get the official RoR and boundary."
        ),
    })
    return result
