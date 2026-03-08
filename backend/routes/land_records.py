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
from typing import Any, Optional
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
    if lat is None or lon is None:
        return None

    assert lat is not None and lon is not None  # narrows Optional[float] → float
    _lat: float = lat
    _lon: float = lon
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
                    "BBOX": f"{_lon-0.001},{_lat-0.001},{_lon+0.001},{_lat+0.001}",
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
    """
    Query Overpass for cadastral/landuse polygons at the given point.
    Searches a 300m radius for plot-sized polygons (30–8 000 m²).
    """
    d = 0.003  # ~333 m
    query = f"""
[out:json][timeout:14];
(
  way["landuse"~"^(residential|farmland|industrial|commercial|allotments|orchard|vineyard)$"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["building"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["plot"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["boundary"="plot"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["natural"~"^(wood|scrub|grassland|heath|bare_rock)$"]({lat-d},{lon-d},{lat+d},{lon+d});
  way["amenity"~"^(school|hospital|park|parking)$"]({lat-d},{lon-d},{lat+d},{lon+d});
  relation["landuse"]({lat-d},{lon-d},{lat+d},{lon+d});
);
out geom;
"""
    try:
        async with httpx.AsyncClient(timeout=16.0) as client:
            resp = await client.post("https://overpass-api.de/api/interpreter", data={"data": query})
            if resp.status_code != 200:
                return None
            elements = resp.json().get("elements", [])
            best: Optional[list] = None
            best_tags: dict[str, str] = {}
            best_area = float("inf")
            for el in elements:
                geom = el.get("geometry", [])
                if not geom:
                    continue
                coords = [[g["lon"], g["lat"]] for g in geom]
                if not coords:
                    continue
                area = _polygon_area_sqm(coords)
                if 30 < area < 8000 and area < best_area:
                    best = coords
                    best_area = area
                    best_tags = el.get("tags", {})
            if best is not None:
                land_type = (
                    best_tags.get("landuse") or best_tags.get("building") or
                    best_tags.get("natural") or best_tags.get("amenity") or "Mapped via OSM"
                )
                return {
                    "boundary": best,
                    "area_sqm": round(best_area),
                    "source": "OpenStreetMap (OSM Overpass — cadastral)",
                    "owner_name": "Not available via OSM",
                    "survey_number": "—",
                    "land_type": land_type.capitalize(),
                    "portal": "https://www.openstreetmap.org",
                }
    except Exception as e:
        logger.warning(f"Overpass cadastral failed: {e}")
    return None


async def _try_nominatim_polygon(lat: float, lon: float) -> Optional[dict]:
    """
    Reverse-geocode with Nominatim and request a real polygon (polygon_geojson=1).
    Tries zoom levels 17 → 16 → 15 → 14 (building → street → suburb → district).
    Returns the first meaningful polygon found (area 50 m² – 2 km²), or None.
    """
    for zoom in (17, 16, 15, 14):
        try:
            async with httpx.AsyncClient(
                timeout=10.0,
                headers={"User-Agent": "eco3d-platform/2.1 boundary-lookup (contact@eco3d.app)"},
            ) as c:
                r = await c.get(
                    "https://nominatim.openstreetmap.org/reverse",
                    params={
                        "format": "geojson",
                        "lat": lat, "lon": lon,
                        "polygon_geojson": 1,
                        "zoom": zoom,
                        "addressdetails": 1,
                    },
                )
                if r.status_code != 200:
                    continue
                features = r.json().get("features", [])
                if not features:
                    continue
                feat = features[0]
                geom  = feat.get("geometry", {})
                props = feat.get("properties", {})

                # Extract outer ring regardless of Polygon vs MultiPolygon
                if geom.get("type") == "Polygon":
                    coords = geom["coordinates"][0]
                elif geom.get("type") == "MultiPolygon":
                    coords = geom["coordinates"][0][0]
                else:
                    continue  # Point or LineString — no polygon at this zoom

                if len(coords) < 3:
                    continue
                area = _polygon_area_sqm(coords)
                if area < 50 or area > 2_000_000:
                    continue  # Too tiny (noise) or too vast (country/state level)

                addr = props.get("address", {})
                place = (
                    addr.get("road") or addr.get("suburb") or
                    addr.get("neighbourhood") or addr.get("village") or
                    addr.get("town") or addr.get("city") or "—"
                )
                osm_type = props.get("type") or props.get("class") or "place"
                logger.info(
                    f"[Nominatim] boundary at zoom={zoom}: '{place}' area={area:.0f} m²"
                )
                return {
                    "boundary": coords,
                    "area_sqm": round(area),
                    "source": f"Nominatim/OSM reverse geocode (zoom={zoom})",
                    "owner_name": "Not available via Nominatim",
                    "survey_number": "—",
                    "land_type": osm_type.capitalize(),
                    "portal": (
                        f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}"
                        f"#map={zoom}/{lat}/{lon}"
                    ),
                    "place_name": place,
                }
        except Exception as e:
            logger.warning(f"[Nominatim] zoom={zoom} failed: {e}")
    return None


async def _try_overpass_admin_boundary(lat: float, lon: float) -> Optional[dict]:
    """
    Use Overpass `is_in` to find the smallest real administrative or place boundary
    that physically contains the clicked point.
    Useful when cadastral data is absent — still returns a real OSM polygon.
    """
    query = f"""
[out:json][timeout:14];
is_in({lat},{lon})->.a;
(
  way(pivot.a)["place"~"^(suburb|neighbourhood|quarter|village|hamlet|isolated_dwelling)$"];
  way(pivot.a)["boundary"~"^(administrative|postal_code)$"];
  relation(pivot.a)["place"~"^(suburb|neighbourhood|quarter|village|hamlet)$"];
  relation(pivot.a)["boundary"~"^(administrative|postal_code)$"]["admin_level"~"^(8|9|10|11)$"];
);
out geom;
"""
    try:
        async with httpx.AsyncClient(timeout=16.0) as c:
            r = await c.post("https://overpass-api.de/api/interpreter", data={"data": query})
            if r.status_code != 200:
                return None
            elements = r.json().get("elements", [])
            best: Optional[tuple] = None
            best_area = float("inf")
            for el in elements:
                # ways have geometry directly; relations have it in members
                raw_geom = el.get("geometry", [])
                if not raw_geom and el.get("type") == "relation":
                    for m in el.get("members", []):
                        if m.get("role") == "outer" and m.get("geometry"):
                            raw_geom = m["geometry"]
                            break
                if not raw_geom:
                    continue
                coords = [
                    [g["lon"], g["lat"]] for g in raw_geom
                    if "lon" in g and "lat" in g
                ]
                if len(coords) < 3:
                    continue
                area = _polygon_area_sqm(coords)
                # Accept local-scale polygons only (500 m² – 5 km²)
                if 500 < area < 5_000_000 and area < best_area:
                    best = (coords, area, el.get("tags", {}))
                    best_area = area
            if best:
                coords, area, tags = best
                land_type = (
                    tags.get("place") or tags.get("boundary") or "Administrative"
                ).capitalize()
                logger.info(f"[Overpass is_in] boundary: {land_type} area={area:.0f} m²")
                return {
                    "boundary": coords,
                    "area_sqm": round(area),
                    "source": "OSM Administrative Boundary (Overpass is_in)",
                    "owner_name": "Not available",
                    "survey_number": "—",
                    "land_type": land_type,
                    "portal": "https://www.openstreetmap.org",
                }
    except Exception as e:
        logger.warning(f"[Overpass is_in] failed: {e}")
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

    Priority order (all real data sources tried before synthetic):
    1. Bhu Naksha WMS         — official cadastral polygon (10 states)
    2. OSM Overpass cadastral — plot/building/landuse polygons from OSM
    3. Nominatim reverse      — real OSM polygon via reverse geocode (zoom 17→14)
    4. Overpass is_in         — real admin/neighbourhood boundary containing the point
    5. Synthetic rectangle    — absolute last resort, clearly labelled as estimated
    """
    state_info = STATES.get(state)
    if not state_info:
        return {"error": f"State '{state}' not found. Use /land-record/states to list valid states."}

    state_name = str(state_info["name"])
    state_bhulekh = str(state_info["bhulekh"])
    portal_url = BHU_NAKSHA_WMS.get(state) or (
        "https://www.google.com/search?q="
        + state_name.replace(" ", "+")
        + "+Bhulekh+land+records"
    )

    result: dict[str, Any] = {
        "state": state_name,
        "district": district or "—",
        "survey_number": survey_number or "—",
        "owner_name": None,
        "land_type": None,
        "area_sqm": None,
        "boundary": None,
        "source": None,
        "portal_name": state_bhulekh,
        "portal_url": portal_url,
        "bhu_naksha_available": bool(state_info["bhu_naksha"]),
        "note": None,
    }

    # Narrow Optional[float] → float once so every branch below gets a concrete type
    have_coords = lat is not None and lon is not None
    _lat: float = lat if lat is not None else 0.0
    _lon: float = lon if lon is not None else 0.0

    # ── Try 1: Bhu Naksha WMS (official government cadastral) ─────────────────
    if have_coords and state_info["bhu_naksha"]:
        try:
            wms_result = await asyncio.wait_for(
                _try_bhu_naksha_wms(state, district, survey_number, _lat, _lon),
                timeout=10.0,
            )
            if wms_result:
                for k, v in wms_result.items():
                    result[k] = v
                result["note"] = "Boundary fetched from official Bhu Naksha WMS."
                logger.info(f"[LandRecord] Bhu Naksha WMS success for ({_lat}, {_lon})")
                return result
        except asyncio.TimeoutError:
            logger.warning("[LandRecord] Bhu Naksha WMS timed out")

    # ── Try 2: OSM Overpass cadastral (plot/building/landuse polygons) ─────────
    if have_coords:
        try:
            osm_result = await asyncio.wait_for(
                _try_overpass_cadastral(_lat, _lon),
                timeout=16.0,
            )
            if osm_result:
                for k, v in osm_result.items():
                    result[k] = v
                result["note"] = (
                    "Boundary sourced from OpenStreetMap cadastral data. "
                    "For official owner/survey data, visit the state portal below."
                )
                logger.info(f"[LandRecord] OSM Overpass cadastral success for ({_lat}, {_lon})")
                return result
        except asyncio.TimeoutError:
            logger.warning("[LandRecord] OSM Overpass cadastral timed out")

    # ── Try 3: Nominatim reverse geocode with real polygon ────────────────────
    if have_coords:
        try:
            nom_result = await asyncio.wait_for(
                _try_nominatim_polygon(_lat, _lon),
                timeout=15.0,
            )
            if nom_result:
                nom_source = str(nom_result.get("source", "OSM"))
                for k, v in nom_result.items():
                    result[k] = v
                result["note"] = (
                    f"Boundary from Nominatim/OSM reverse geocode ({nom_source}). "
                    "This is the enclosing mapped area, not the exact cadastral parcel. "
                    "For official parcel data, visit the state portal below."
                )
                logger.info(f"[LandRecord] Nominatim polygon success for ({_lat}, {_lon})")
                return result
        except asyncio.TimeoutError:
            logger.warning("[LandRecord] Nominatim reverse geocode timed out")

    # ── Try 4: Overpass is_in — administrative/neighbourhood boundary ──────────
    if have_coords:
        try:
            admin_result = await asyncio.wait_for(
                _try_overpass_admin_boundary(_lat, _lon),
                timeout=16.0,
            )
            if admin_result:
                for k, v in admin_result.items():
                    result[k] = v
                result["note"] = (
                    "Boundary is the OSM administrative/neighbourhood area containing "
                    "your point — not the exact cadastral parcel. "
                    "For official parcel data, visit the state portal below."
                )
                logger.info(f"[LandRecord] Overpass is_in admin boundary success for ({_lat}, {_lon})")
                return result
        except asyncio.TimeoutError:
            logger.warning("[LandRecord] Overpass is_in timed out")

    # ── Try 5: Synthetic rectangle — absolute last resort ─────────────────────
    logger.warning(
        f"[LandRecord] All real sources failed for ({_lat}, {_lon}) — returning synthetic estimate"
    )
    rng = random.Random(f"{_lat:.4f}{_lon:.4f}{survey_number}")
    area_estimate = float(rng.randint(150, 600))
    boundary = _synthetic_boundary(_lat, _lon, area_estimate) if have_coords else None

    result["boundary"] = boundary
    result["area_sqm"] = int(area_estimate) if boundary else None
    result["owner_name"] = "Fetch from state portal (link below)"
    result["land_type"] = "Residential / Mixed"
    result["source"] = "Estimated boundary — NOT real cadastral data"
    result["note"] = (
        f"All real boundary sources (Bhu Naksha WMS, OpenStreetMap, Nominatim) "
        f"are currently unavailable for this location. "
        f"Visit the {state_bhulekh} portal (link below) and enter Survey No. "
        f"'{survey_number or '<your survey number>'}' to get the official RoR and boundary."
    )
    return result
