"""SQLAlchemy ORM models with PostGIS geometry support."""
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Float, DateTime, JSON, Text, Boolean, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from database.connection import Base


class PlotRecord(Base):
    __tablename__ = "plots"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plot_id = Column(String(64), unique=True, nullable=False, index=True)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    polygon = Column(JSON, nullable=True)   # GeoJSON polygon
    created_at = Column(DateTime, default=datetime.utcnow)


class AnalysisRecord(Base):
    __tablename__ = "analyses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
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

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plot_id = Column(String(64), nullable=False, index=True)
    layout_json = Column(JSON, nullable=False)         # Rooms, dimensions, orientation
    fitness_score = Column(Float, nullable=True)
    generation_count = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Notification(Base):
    __tablename__ = "notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True) # Optional for global notifications
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)
    type = Column(String(50), default="info") # info, success, warning, error
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
