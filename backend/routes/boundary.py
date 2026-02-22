"""Plot boundary route — returns OSM-derived empty plot polygon."""
from fastapi import APIRouter, Query
from services.plot_boundary import get_plot_boundary, check_point_buildability

router = APIRouter()

@router.get("/plot-boundary")
async def plot_boundary(lat: float = Query(...), lon: float = Query(...)):
    """Returns plot boundary polygon and buildability check."""
    buildability = await check_point_buildability(lat, lon)
    boundary     = await get_plot_boundary(lat, lon)
    return {
        "lat": lat, "lon": lon,
        "is_buildable": buildability["is_buildable"],
        "reason": buildability["reason"],
        "land_use": buildability["land_use"],
        "boundary": boundary or [],
    }
