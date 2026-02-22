"""Report route — GET /report/{plot_id}."""
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database.connection import get_db
from database.models import AnalysisRecord, FloorPlanRecord

router = APIRouter()


@router.get("/{plot_id}")
async def get_report(plot_id: str, db: AsyncSession = Depends(get_db)):
    analysis = await db.execute(
        select(AnalysisRecord).where(AnalysisRecord.plot_id == plot_id).order_by(AnalysisRecord.created_at.desc())
    )
    analysis = analysis.scalars().first()
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")

    fp = await db.execute(
        select(FloorPlanRecord).where(FloorPlanRecord.plot_id == plot_id).order_by(FloorPlanRecord.created_at.desc())
    )
    fp = fp.scalars().first()

    return {
        "plot_id": plot_id,
        "analysis": {
            "ndvi": analysis.ndvi,
            "slope": analysis.slope,
            "elevation": analysis.elevation,
            "rainfall_mm": analysis.rainfall_mm,
            "soil_type": analysis.soil_type,
            "wind_direction": analysis.wind_direction,
            "sun_exposure_hours": analysis.sun_exposure_hours,
            "flood_probability": analysis.flood_probability,
            "buildability_score": analysis.buildability_score,
            "segmentation": analysis.segmentation_mask,
            "tree_coordinates": analysis.tree_coordinates,
        },
        "floorplan": fp.layout_json if fp else None,
        "created_at": analysis.created_at.isoformat(),
    }
