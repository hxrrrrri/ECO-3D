"""SQLAlchemy ORM models — compatible with SQLite (dev) and PostgreSQL (prod)."""
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Float, DateTime, JSON, Text, Boolean, ForeignKey
from database.connection import Base, DATABASE_URL

# SQLAlchemy 2.0+ Uuid type works with both SQLite and PostgreSQL
# For maximum compatibility, we use String(36) as primary key storage
# which works universally across all databases
_IS_SQLITE = DATABASE_URL.startswith("sqlite")

if _IS_SQLITE:
    # SQLite: store UUIDs as VARCHAR(36) strings
    from sqlalchemy import String as _UuidType
    def _uuid_pk():
        return Column(_UuidType(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    def _uuid_fk(target, **kwargs):
        return Column(_UuidType(36), ForeignKey(target), **kwargs)
else:
    # PostgreSQL: use native UUID type from postgresql dialect
    from sqlalchemy.dialects.postgresql import UUID as _PgUUID
    def _uuid_pk():
        return Column(_PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    def _uuid_fk(target, **kwargs):
        return Column(_PgUUID(as_uuid=True), ForeignKey(target), **kwargs)


class PlotRecord(Base):
    __tablename__ = "plots"

    id = _uuid_pk()
    plot_id = Column(String(64), unique=True, nullable=False, index=True)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    polygon = Column(JSON, nullable=True)   # GeoJSON polygon
    created_at = Column(DateTime, default=datetime.utcnow)


class AnalysisRecord(Base):
    __tablename__ = "analyses"

    id = _uuid_pk()
    plot_id = Column(String(64), nullable=False, index=True)
    segmentation_mask = Column(JSON, nullable=True)    # Land class percentages
    tree_coordinates = Column(JSON, nullable=True)     # [{lat, lon, confidence}]
    ndvi = Column(Float, nullable=True)
    slope = Column(Float, nullable=True)
    elevation = Column(Float, nullable=True)
    rainfall_mm = Column(Float, nullable=True)
    soil_type = Column(String(64), nullable=True)
    wind_direction = Column(String(16), nullable=True)
    sun_exposure_hours = Column(Float, nullable=True)
    flood_probability = Column(Float, nullable=True)
    buildability_score = Column(Float, nullable=True)
    raw_features = Column(JSON, nullable=True)         # Full feature dict
    created_at = Column(DateTime, default=datetime.utcnow)


class FloorPlanRecord(Base):
    __tablename__ = "floorplans"

    id = _uuid_pk()
    plot_id = Column(String(64), nullable=False, index=True)
    layout_json = Column(JSON, nullable=False)         # Rooms, dimensions, orientation
    fitness_score = Column(Float, nullable=True)
    generation_count = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class User(Base):
    __tablename__ = "users"

    id = _uuid_pk()
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Notification(Base):
    __tablename__ = "notifications"

    id = _uuid_pk()
    user_id = _uuid_fk("users.id", nullable=True, index=True)  # Optional for global notifications
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)
    type = Column(String(50), default="info")  # info, success, warning, error
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
