"""Analysis route — POST /analyze-plot — never returns 500."""
import traceback, logging
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from database.connection import get_db
from models.schemas import AnalyzePlotRequest
from services.analysis_pipeline import run_full_analysis

router = APIRouter()
logger = logging.getLogger(__name__)

@router.post("/analyze-plot")
async def analyze_plot(request: AnalyzePlotRequest, db: AsyncSession = Depends(get_db)):
    try:
        result = await run_full_analysis(request, db)
        return JSONResponse(
            content=result.model_dump(),
            headers={"Access-Control-Allow-Origin": "*"},
        )
    except Exception as e:
        tb = traceback.format_exc()
        logger.error(f"[analyze-plot] Uncaught: {tb}")
        return JSONResponse(
            status_code=200,
            content={
                "error": True,
                "plot_id": request.plot_id,
                "message": f"Analysis error: {str(e)}",
                "detail": tb.splitlines()[-1] if tb else str(e),
            },
            headers={"Access-Control-Allow-Origin": "*"},
        )
