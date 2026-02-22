"""Plots listing route."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database.connection import get_db
from database.models import PlotRecord

router = APIRouter()


@router.get("/")
async def list_plots(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PlotRecord).limit(100))
    plots = result.scalars().all()
    return [{"id": str(p.id), "plot_id": p.plot_id, "lat": p.lat, "lon": p.lon} for p in plots]
