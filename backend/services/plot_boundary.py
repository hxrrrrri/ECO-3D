"""
Plot Boundary Service — ECO-3D v4
Strategy order:
1. Satellite colour segmentation (real image analysis — most accurate)
2. OSM explicit parcel (cadastral/landuse polygon)
3. OSM obstacle ray-cast (buildings/roads define empty space)
4. Synthetic rectangle (deterministic fallback)
"""
import math, logging, asyncio
from typing import Optional, Tuple, List
import httpx

logger = logging.getLogger(__name__)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
MIN_AREA_M2  =     20
MAX_AREA_M2  = 50_000


def _haversine_m(lat1,lon1,lat2,lon2):
    R=6_371_000.0
    p1,p2=math.radians(lat1),math.radians(lat2)
    dp=math.radians(lat2-lat1); dl=math.radians(lon2-lon1)
    a=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return R*2*math.asin(math.sqrt(max(0.,min(1.,a))))

def _polygon_area_m2(coords):
    if len(coords)<3: return 0.0
    clat=sum(c[1] for c in coords)/len(coords)
    clon=sum(c[0] for c in coords)/len(coords)
    lat_m=111_320.0; lon_m=111_320.0*math.cos(math.radians(clat))
    pts=[((c[0]-clon)*lon_m,(c[1]-clat)*lat_m) for c in coords]
    n=len(pts); area=0.0
    for i in range(n):
        j=(i+1)%n; area+=pts[i][0]*pts[j][1]-pts[j][0]*pts[i][1]
    return abs(area)/2.0

def _bbox(lat,lon,r_m):
    d_lat=r_m/111_000; d_lon=r_m/(111_000*math.cos(math.radians(lat)))
    return lat-d_lat,lon-d_lon,lat+d_lat,lon+d_lon

def _point_in_poly(lat,lon,poly):
    inside=False; n=len(poly); j=n-1
    for i in range(n):
        xi,yi=poly[i][0],poly[i][1]; xj,yj=poly[j][0],poly[j][1]
        if ((yi>lat)!=(yj>lat)) and (lon<(xj-xi)*(lat-yi)/(yj-yi+1e-12)+xi):
            inside=not inside
        j=i
    return inside


async def _try_satellite_segmentation(lat,lon):
    try:
        from ai.boundary.satellite_segmenter import detect_plot_boundary
        polygon,area=await asyncio.wait_for(detect_plot_boundary(lat,lon),timeout=15.0)
        if polygon and len(polygon)>=4 and MIN_AREA_M2<area<MAX_AREA_M2:
            logger.info(f"[Boundary] Satellite seg: {len(polygon)} pts, {area:.0f} m²")
            return polygon
    except asyncio.TimeoutError:
        logger.warning("[Boundary] Satellite segmentation timed out")
    except Exception as e:
        logger.warning(f"[Boundary] Satellite seg error: {e}")
    return None


_PARCEL_TAGS=[
    ("boundary","cadastral"),("place","plot"),
    ("landuse","residential"),("landuse","farmland"),
    ("landuse","meadow"),("landuse","grass"),
    ("landuse","greenfield"),("landuse","brownfield"),
    ("landuse","allotments"),("landuse","orchard"),
    ("natural","grassland"),("natural","scrub"),
    ("natural","sand"),("natural","bare_rock"),
    ("leisure","garden"),
]

async def _try_osm_parcel(lat,lon):
    s,w,n,e=_bbox(lat,lon,250)
    filters="\n  ".join(f'way["{k}"="{v}"]({s},{w},{n},{e});' for k,v in _PARCEL_TAGS)
    query=f"[out:json][timeout:18];\n(\n  {filters}\n);\nout geom;\n"
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            r=await c.post(OVERPASS_URL,data={"data":query})
            if r.status_code!=200: return None
        candidates=[]
        for el in r.json().get("elements",[]):
            geom=el.get("geometry",[])
            if len(geom)<3: continue
            poly=[[g["lon"],g["lat"]] for g in geom]
            area=_polygon_area_m2(poly)
            if area<MIN_AREA_M2 or area>MAX_AREA_M2: continue
            clat=sum(g["lat"] for g in geom)/len(geom)
            clon=sum(g["lon"] for g in geom)/len(geom)
            dist=_haversine_m(lat,lon,clat,clon)
            contains=_point_in_poly(lat,lon,poly)
            if contains or dist<50:
                candidates.append((contains,area,dist,poly))
        if candidates:
            candidates.sort(key=lambda x:(not x[0],x[1]))
            p=candidates[0][3]
            logger.info(f"[Boundary] OSM parcel: {len(p)} pts, {_polygon_area_m2(p):.0f} m²")
            return p
    except Exception as e:
        logger.warning(f"[Boundary] OSM parcel failed: {e}")
    return None


async def _try_obstacle_raycast(lat,lon):
    SEARCH_R=200; MAX_RAY_M=110; N_RAYS=32; MIN_RAY_M=3.0
    s,w,n,e=_bbox(lat,lon,SEARCH_R)
    query=f"""
[out:json][timeout:20];
(
  way["building"]({s},{w},{n},{e});
  way["highway"~"^(primary|secondary|tertiary|residential|service|track|path|footway)$"]({s},{w},{n},{e});
  way["waterway"]({s},{w},{n},{e});
  way["natural"~"^(water|wetland|wood|tree_row)$"]({s},{w},{n},{e});
  way["landuse"~"^(forest|military|cemetery|industrial)$"]({s},{w},{n},{e});
);
out geom;
"""
    try:
        async with httpx.AsyncClient(timeout=22.0) as c:
            r=await c.post(OVERPASS_URL,data={"data":query})
            if r.status_code!=200: return None
        elements=r.json().get("elements",[])
    except Exception as e:
        logger.warning(f"[Boundary] Raycast OSM failed: {e}")
        return None
    if not elements: return None
    lat_m=111_320.0; lon_m=111_320.0*math.cos(math.radians(lat))
    def tc(glon,glat): return (glon-lon)*lon_m,(glat-lat)*lat_m
    segments=[]
    for el in elements:
        geom=el.get("geometry",[])
        if len(geom)<2: continue
        pts=[tc(g["lon"],g["lat"]) for g in geom]
        for i in range(len(pts)-1):
            segments.append((pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1]))
    if not segments: return None
    endpoints=[]
    for i in range(N_RAYS):
        angle=(2*math.pi*i)/N_RAYS; dx,dy=math.cos(angle),math.sin(angle)
        min_dist=float(MAX_RAY_M)
        for ax,ay,bx,by in segments:
            denom=dx*(by-ay)-dy*(bx-ax)
            if abs(denom)<1e-9: continue
            t=(ax*(by-ay)-ay*(bx-ax))/denom
            u=-(ax*dy-ay*dx)/denom
            if MIN_RAY_M<t<min_dist and 0.0<=u<=1.0: min_dist=t
        endpoints.append((dx*min_dist,dy*min_dist))
    polygon=[[round(lon+cx/lon_m,7),round(lat+cy/lat_m,7)] for cx,cy in endpoints]
    polygon.append(polygon[0])
    area=_polygon_area_m2(polygon)
    if area<MIN_AREA_M2 or area>MAX_AREA_M2: return None
    logger.info(f"[Boundary] Raycast: {len(polygon)} pts, {area:.0f} m²")
    return polygon


def _synthetic_plot(lat,lon):
    rng=random.Random(f"{lat:.5f}{lon:.5f}")
    area=rng.uniform(200,600); ratio=rng.uniform(1.4,2.5)
    w_m=math.sqrt(area/ratio); h_m=area/w_m
    angle=rng.uniform(-15,15)*math.pi/180
    d_lat=1.0/111_000; d_lon=1.0/(111_000*math.cos(math.radians(lat)))
    hw,hh=w_m/2,h_m/2
    corners=[(-hw,-hh),(hw,-hh),(hw,hh),(-hw,hh)]
    pts=[]
    for cx,cy in corners:
        rx=cx*math.cos(angle)-cy*math.sin(angle)
        ry=cx*math.sin(angle)+cy*math.cos(angle)
        pts.append([round(lon+rx*d_lon,7),round(lat+ry*d_lat,7)])
    pts.append(pts[0])
    return pts


async def get_plot_boundary(lat,lon):
    polygon=None
    polygon=await _try_satellite_segmentation(lat,lon)
    if polygon is None: polygon=await _try_osm_parcel(lat,lon)
    if polygon is None:
        logger.warning("[Boundary] No real boundary source resolved for (%s, %s)", lat, lon)
        return [], 0.0
    area=round(_polygon_area_m2(polygon),1)
    if area<10:
        logger.warning("[Boundary] Rejected real boundary with implausible area %.1f", area)
        return [], 0.0
    return polygon,area


async def check_point_buildability(lat,lon):
    s,w,n,e=_bbox(lat,lon,20)
    query=f"""
[out:json][timeout:12];
(
  way["building"]({s},{w},{n},{e});
  way["highway"~"^(primary|secondary|tertiary|trunk|motorway)$"]({s},{w},{n},{e});
  way["natural"~"^(water|wetland)$"]({s},{w},{n},{e});
  way["leisure"="park"]({s},{w},{n},{e});
  way["landuse"~"^(military|cemetery|forest)$"]({s},{w},{n},{e});
);
out tags;
"""
    blocking=[]
    try:
        async with httpx.AsyncClient(timeout=14.0) as c:
            resp=await c.post(OVERPASS_URL,data={"data":query})
            if resp.status_code==200:
                for el in resp.json().get("elements",[]):
                    tags=el.get("tags",{})
                    if "building" in tags: blocking.append("Existing building — select vacant land")
                    elif "highway" in tags: blocking.append("Major road — cannot build here")
                    elif tags.get("natural") in ("water","wetland"): blocking.append("Water body — cannot build here")
                    elif tags.get("leisure")=="park": blocking.append("Public park — protected area")
                    elif tags.get("landuse")=="military": blocking.append("Military land — restricted")
                    elif tags.get("landuse")=="cemetery": blocking.append("Cemetery — restricted")
    except Exception as e:
        logger.warning(f"Buildability check failed: {e}")
    if blocking:
        unique=list(dict.fromkeys(blocking))[:2]
        return {"is_buildable":False,"reason":" · ".join(unique),"land_use":unique[0]}
    return {"is_buildable":True,"reason":"Vacant land — no restrictions detected","land_use":"vacant"}
