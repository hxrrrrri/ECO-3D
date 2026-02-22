"""Analysis route — POST /analyze-plot runs the full AI pipeline."""
import traceback
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from database.connection import get_db
from database.models import PlotRecord, AnalysisRecord
from models.schemas import AnalyzePlotRequest, AnalysisResponse
from services.analysis_pipeline import run_full_analysis

router = APIRouter()


@router.post("/analyze-plot", response_model=AnalysisResponse)
async def analyze_plot(request: AnalyzePlotRequest, db: AsyncSession = Depends(get_db)):
    """
    Full sequential AI pipeline:
    1. Satellite tile fetch
    2. DeepLabV3 segmentation
    3. YOLOv8 tree detection
    4. Environmental feature engineering (NDVI, slope, elevation, rainfall, soil, wind, sun)
    5. XGBoost flood risk model
    6. MLP buildability model
    7. Persist to PostgreSQL
    8. Return structured JSON
    """
    try:
        result = await run_full_analysis(request, db)
        return result
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
