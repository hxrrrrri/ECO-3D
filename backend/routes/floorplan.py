"""Floor plan generation route — POST /generate-floorplan."""
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from database.connection import get_db
from models.schemas import GenerateFloorPlanRequest, FloorPlanResponse
from services.floorplan_service import generate_floor_plan

router = APIRouter()


@router.post("/generate-floorplan", response_model=FloorPlanResponse)
async def create_floor_plan(request: GenerateFloorPlanRequest, db: AsyncSession = Depends(get_db)):
    """
    Genetic algorithm floor plan generator.
    Optimizes for: sunlight, cross ventilation, tree preservation, structural safety.
    """
    try:
        return await generate_floor_plan(request, db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
