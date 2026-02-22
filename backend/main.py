"""ECO-3D FastAPI Backend."""
import sys, os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import logging

sys.path.insert(0, os.path.dirname(__file__))
from database.connection import init_db
from routes import analysis, floorplan, plots, report, boundary, auth, notifications

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("ECO-3D backend ready")
    yield

app = FastAPI(title="ECO-3D Spatial Intelligence API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)

@app.exception_handler(Exception)
async def global_exc(request: Request, exc: Exception):
    logger.error(f"Unhandled: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": str(exc)},
                        headers={"Access-Control-Allow-Origin": "*"})

app.include_router(analysis.router,  tags=["Analysis"])
app.include_router(floorplan.router, tags=["Floor Plan"])
app.include_router(plots.router,     prefix="/plots",  tags=["Plots"])
app.include_router(report.router,    prefix="/report", tags=["Report"])
app.include_router(boundary.router,  tags=["Boundary"])
app.include_router(auth.router)
app.include_router(notifications.router)

@app.get("/health")
async def health():
    return {"status": "ok", "version": "2.0.0"}
