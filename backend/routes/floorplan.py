"""Floor plan route — POST /generate-floorplan — never returns 500."""
import traceback, logging
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from database.connection import get_db
from models.schemas import GenerateFloorPlanRequest
from services.floorplan_service import generate_floor_plan

router = APIRouter()
logger = logging.getLogger(__name__)

@router.post("/generate-floorplan")
async def create_floor_plan(request: GenerateFloorPlanRequest, db: AsyncSession = Depends(get_db)):
    try:
        result = await generate_floor_plan(request, db)
        return JSONResponse(
            content=result.model_dump(),
            headers={"Access-Control-Allow-Origin": "*"},
        )
    except Exception:
        logger.error(f"[generate-floorplan] Uncaught: {traceback.format_exc()}")
        return JSONResponse(
            status_code=200,
            content={
                "error": True,
                "plot_id": request.plot_id,
                "message": "Floor plan generation failed. Please try again.",
            },
            headers={"Access-Control-Allow-Origin": "*"},
        )
