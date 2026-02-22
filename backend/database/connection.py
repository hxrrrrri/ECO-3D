"""
Database connection — supports PostgreSQL (production) and SQLite (development).

Set DATABASE_URL env var:
  PostgreSQL: postgresql+asyncpg://eco3d:eco3d@localhost:5432/eco3d
  SQLite:     sqlite+aiosqlite:///./eco3d.db   (DEFAULT — no setup needed)
"""
import os
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite+aiosqlite:///./eco3d.db"          # SQLite default — works out of the box
)

# SQLite needs check_same_thread=False via connect_args
connect_args = {}
engine_kwargs: dict = {"echo": False, "pool_pre_ping": True}

if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
    # SQLite doesn't support pool_size / max_overflow
    engine_kwargs["connect_args"] = connect_args
else:
    engine_kwargs["pool_size"] = 10
    engine_kwargs["max_overflow"] = 20

engine = create_async_engine(DATABASE_URL, **engine_kwargs)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    """Create all tables on startup."""
    from database.models import PlotRecord, AnalysisRecord, FloorPlanRecord, User, Notification  # noqa: F401
    try:
        async with engine.begin() as conn:
            # Enable PostGIS only for PostgreSQL
            if not DATABASE_URL.startswith("sqlite"):
                from sqlalchemy import text
                await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
            await conn.run_sync(Base.metadata.create_all)
        logger.info(f"Database ready ({DATABASE_URL.split('://')[0]})")
    except Exception as e:
        logger.warning(f"DB init warning (continuing): {e}")


async def get_db():
    """FastAPI dependency — yields an async DB session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
