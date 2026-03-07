"""
Plot Boundary Service — Real individual plot/parcel detection.

Priority order:
1. Overpass: cadastral plots, individual landuse parcels (< 5000 m²)
2. Overpass: any closed way that CONTAINS the click (< 5000 m²)
3. Nominatim reverse geocode → GeoJSON boundary (only if small enough)
4. Synthetic realistic rectangle (~200-800 m² typical residential plot)

IMPORTANT: We strictly reject any polygon > 10,000 m² to avoid
neighbourhood/district boundaries being returned as "the plot".
"""
import math
import logging
import random
from typing import Optional
import httpx

logger = logging.getLogger(__name__)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org"

# Reasonable plot size limits
MIN_AREA_M2 = 30        # smallest legal plot
MAX_AREA_M2 = 10_000    # max we'll show (~1 hectare — large estate)


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δφ = math.radians(lat2 - lat1)
    Δλ = math.radians(lon2 - lon1)
    a = math.sin(Δφ/2)**2 + math.cos(φ1)*math.cos(φ2)*math.sin(Δλ/2)**2
    return R * 2 * math.asin(math.sqrt(a))


def _polygon_area_sqm(coords: list) -> float:
    """Geodetic Shoelace formula. coords = [[lon,lat],...]"""
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


def _bbox_from_point(lat: float, lon: float, radius_m: float) -> tuple:
    d_lat = radius_m / 111000
    d_lon = radius_m / (111000 * math.cos(math.radians(lat)))
    return lat - d_lat, lon - d_lon, lat + d_lat, lon + d_lon


def _point_in_polygon(lat: float, lon: float, polygon: list) -> bool:
    """Ray-casting point-in-polygon test."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _best_plot(elements: list, lat: float, lon: float) -> Optional[list]:
    """
    Pick the best polygon from Overpass elements:
    - Must be within MAX_AREA_M2
    - Prefer polygons that contain the click point
    - Among those, prefer the smallest (most specific plot)
    """
    candidates = []
    for el in elements:
        geom = el.get("geometry", [])
        if len(geom) < 3:
            continue
        polygon = [[g["lon"], g["lat"]] for g in geom]
        area = _polygon_area_sqm(polygon)
        if area < MIN_AREA_M2 or area > MAX_AREA_M2:
            continue  # reject tiny or huge features
        contains = _point_in_polygon(lat, lon, polygon)
        clat = sum(g["lat"] for g in geom) / len(geom)
        clon = sum(g["lon"] for g in geom) / len(geom)
        dist = _haversine_m(lat, lon, clat, clon)
        candidates.append((contains, area, dist, polygon))

    if not candidates:
        return None

    # Sort: contains first, then by area ascending (smallest = most specific)
    candidates.sort(key=lambda x: (not x[0], x[1]))
    return candidates[0][3]


# ── Strategy 1: Cadastral / small landuse ways ────────────────────────────────

async def _try_cadastral(lat: float, lon: float) -> Optional[list]:
    """Query Overpass for small cadastral/plot ways near the click point."""
    # Small radius — we only want individual plots, not districts
    s, w, n, e = _bbox_from_point(lat, lon, 250)
    query = f"""
[out:json][timeout:20];
(
  way["boundary"="cadastral"]({s},{w},{n},{e});
  way["place"="plot"]({s},{w},{n},{e});
  way["landuse"~"^(residential|commercial|farmland|meadow|grass|greenfield|brownfield|allotments|orchard|vineyard|garden|forest|scrub|village_green|construction)$"]({s},{w},{n},{e});
  way["natural"~"^(grassland|scrub|heath|sand|bare_rock|wood)$"]({s},{w},{n},{e});
  way["building"]({s},{w},{n},{e});
  way["amenity"]({s},{w},{n},{e});
  relation["landuse"]({s},{w},{n},{e});
);
out geom;
"""
    try:
        async with httpx.AsyncClient(timeout=17.0) as client:
            resp = await client.post(OVERPASS_URL, data={"data": query})
            if resp.status_code == 200:
                elements = resp.json().get("elements", [])
                polygon = _best_plot(elements, lat, lon)
                if polygon:
                    area = _polygon_area_sqm(polygon)
                    logger.info(f"Cadastral Overpass: {len(polygon)} pts, {area:.0f} m²")
                    return polygon
    except Exception as e:
        logger.warning(f"Cadastral query failed: {e}")
    return None


# ── Strategy 2: Any small closed way containing the click ─────────────────────

async def _try_containing_way(lat: float, lon: float) -> Optional[list]:
    """Find the smallest closed way that geometrically contains the click."""
    s, w, n, e = _bbox_from_point(lat, lon, 200)
    query = f"""
[out:json][timeout:20];
way({s},{w},{n},{e});
out geom;
"""
    try:
        async with httpx.AsyncClient(timeout=17.0) as client:
            resp = await client.post(OVERPASS_URL, data={"data": query})
            if resp.status_code == 200:
                elements = resp.json().get("elements", [])
                polygon = _best_plot(elements, lat, lon)
                if polygon:
                    area = _polygon_area_sqm(polygon)
                    logger.info(f"Containing way: {len(polygon)} pts, {area:.0f} m²")
                    return polygon
    except Exception as e:
        logger.warning(f"Containing way query failed: {e}")
    return None


# ── Strategy 3: Nominatim reverse geocode ─────────────────────────────────────

async def _try_nominatim(lat: float, lon: float) -> Optional[list]:
    """Use Nominatim GeoJSON polygon but only accept small ones."""
    try:
        async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "ECO-3D/2.0"}) as client:
            resp = await client.get(
                f"{NOMINATIM_URL}/reverse",
                params={"lat": lat, "lon": lon, "format": "json", "zoom": 18,
                        "addressdetails": 0, "polygon_geojson": 1}
            )
            if resp.status_code != 200:
                return None
            geojson = resp.json().get("geojson", {})
            gtype = geojson.get("type", "")
            coords = geojson.get("coordinates", [])
            polygon = None
            if gtype == "Polygon" and coords:
                polygon = [[c[0], c[1]] for c in coords[0]]
            elif gtype == "MultiPolygon" and coords:
                # Pick sub-polygon closest to click
                best_d = 1e9
                for sub in coords:
                    ring = [[c[0], c[1]] for c in sub[0]]
                    if len(ring) < 3:
                        continue
                    clat = sum(c[1] for c in ring) / len(ring)
                    clon = sum(c[0] for c in ring) / len(ring)
                    d = _haversine_m(lat, lon, clat, clon)
                    if d < best_d:
                        best_d = d
                        polygon = ring
            if polygon and len(polygon) >= 3:
                area = _polygon_area_sqm(polygon)
                if MIN_AREA_M2 < area < MAX_AREA_M2:
                    logger.info(f"Nominatim: {len(polygon)} pts, {area:.0f} m²")
                    return polygon
                else:
                    logger.info(f"Nominatim polygon rejected: area={area:.0f} m² (out of range)")
    except Exception as e:
        logger.warning(f"Nominatim failed: {e}")
    return None


# ── Fallback: Realistic rectangular plot ──────────────────────────────────────

def _synthetic_plot(lat: float, lon: float) -> list:
    """
    Deterministic realistic rectangular plot.
    Uses typical residential plot sizes for the region.
    Kerala/India: typically 3-15 cents = 120-600 m²
    Other regions: 150-800 m²
    """
    rng = random.Random(f"{lat:.5f}{lon:.5f}")
    # Kerala/South India: smaller plots (3-8 cents typical)
    if 8.0 <= lat <= 12.5 and 76.0 <= lon <= 77.5:
        area = rng.uniform(120, 400)   # Kerala residential plot sizes
    else:
        area = rng.uniform(180, 600)
    # Aspect ratio: typically 1:1.5 to 1:3 (frontage × depth)
    ratio = rng.uniform(1.4, 2.5)
    w_m = math.sqrt(area / ratio)
    h_m = area / w_m

    # Slight rotation to match road alignment
    angle = rng.uniform(-20, 20) * math.pi / 180
    d_lat = 1.0 / 111000
    d_lon = 1.0 / (111000 * math.cos(math.radians(lat)))

    hw, hh = w_m / 2, h_m / 2
    corners = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]

    pts = []
    for cx, cy in corners:
        rx = cx * math.cos(angle) - cy * math.sin(angle)
        ry = cx * math.sin(angle) + cy * math.cos(angle)
        pts.append([
            round(lon + rx * d_lon, 6),
            round(lat + ry * d_lat, 6),
        ])
    pts.append(pts[0])
    return pts


# ── Main public functions ─────────────────────────────────────────────────────

async def get_plot_boundary(lat: float, lon: float) -> tuple:
    """Returns (polygon, area_sqm). Tries real OSM data then synthetic fallback."""
    polygon = None

    polygon = await _try_cadastral(lat, lon)
    if polygon is None:
        polygon = await _try_containing_way(lat, lon)
    if polygon is None:
        polygon = await _try_nominatim(lat, lon)
    if polygon is None:
        polygon = _synthetic_plot(lat, lon)
        logger.info("Using synthetic rectangular plot")

    area = round(_polygon_area_sqm(polygon), 1)
    return polygon, area


async def check_point_buildability(lat: float, lon: float) -> dict:
    """Check if clicked point is on buildable land. Checks for buildings, roads, parks, water."""
    s, w, n, e = _bbox_from_point(lat, lon, 30)  # very small radius around exact click
    query = f"""
[out:json][timeout:12];
(
  way({s},{w},{n},{e});
  node({s},{w},{n},{e});
);
out tags;
"""
    blocking = []
    try:
        async with httpx.AsyncClient(timeout=14.0) as client:
            resp = await client.post(OVERPASS_URL, data={"data": query})
            if resp.status_code == 200:
                for el in resp.json().get("elements", []):
                    tags = el.get("tags", {})
                    if "building" in tags:
                        btype = tags.get("building", "yes")
                        blocking.append(f"Existing building ({btype}) — select a vacant plot")
                    if "highway" in tags:
                        htype = tags.get("highway", "road")
                        blocking.append(f"Road/highway ({htype}) — cannot build here")
                    if tags.get("leisure") == "park":
                        blocking.append("Public park — protected area")
                    if tags.get("landuse") in ("forest", "conservation", "nature_reserve"):
                        blocking.append(f"Protected land ({tags.get('landuse')})")
                    if tags.get("government"):
                        blocking.append("Government property")
                    if tags.get("natural") in ("water", "wetland"):
                        blocking.append(f"Water body ({tags.get('natural')}) — cannot build")
                    if tags.get("amenity") in ("school", "hospital", "place_of_worship"):
                        blocking.append(f"Protected amenity ({tags.get('amenity')})")
    except Exception as e:
        logger.warning(f"Buildability check failed: {e}")

    if blocking:
        unique = list(dict.fromkeys(blocking))[:2]
        return {
            "is_buildable": False,
            "reason": " · ".join(unique),
            "land_use": unique[0],
        }
    return {"is_buildable": True, "reason": "Vacant land — no restrictions detected", "land_use": "vacant"}
