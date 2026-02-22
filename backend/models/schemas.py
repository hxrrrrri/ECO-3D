"""Pydantic request/response schemas."""
from typing import Optional, List
from pydantic import BaseModel, Field


class Coordinate(BaseModel):
    lat: float
    lon: float


class AnalyzePlotRequest(BaseModel):
    plot_id: str = Field(..., description="Unique plot identifier e.g. AE-9921")
    lat: float = Field(..., description="Plot centroid latitude")
    lon: float = Field(..., description="Plot centroid longitude")
    polygon: Optional[List[List[float]]] = Field(None, description="GeoJSON polygon [[lon,lat],...]")


class TreeCoordinate(BaseModel):
    lat: float
    lon: float
    confidence: float
    bbox: Optional[List[float]] = None


class SegmentationResult(BaseModel):
    vegetation: float
    water: float
    urban: float
    bare_soil: float
    road: float


class EnvironmentalFeatures(BaseModel):
    ndvi: float
    slope: float
    elevation: float
    rainfall_mm: float
    soil_type: str
    wind_direction: str
    sun_exposure_hours: float


class AnalysisResponse(BaseModel):
    plot_id: str
    segmentation: SegmentationResult
    tree_coordinates: List[TreeCoordinate]
    environmental: EnvironmentalFeatures
    flood_probability: float
    buildability_score: float
    status: str = "EXCELLENT"
    score_references: Optional[List[str]] = None


class GenerateFloorPlanRequest(BaseModel):
    plot_id: str
    plot_area_sqm: float = 500.0
    num_floors: int = 2
    style: str = "sustainable"
    preserve_trees: bool = True


class Room(BaseModel):
    id: Optional[str] = None
    type: str
    width: float
    height: float
    x: float
    y: float
    floor: int
    orientation: str


class Wall(BaseModel):
    room_id: str
    type: str
    orientation: str
    x: float
    y: float
    length: float
    thickness: float


class Door(BaseModel):
    room_to: str
    type: str
    x: float
    y: float
    width: float
    orientation: str
    symbol: str


class Window(BaseModel):
    wall: str
    position: float
    width: float


class FloorPlanResponse(BaseModel):
    plot_id: str
    layout: List[Room]
    walls: Optional[List[Wall]] = None
    doors: Optional[List[Door]] = None
    windows: Optional[List[Window]] = None
    total_area: float
    fitness_score: float
    generation_count: int
    sunlight_score: float
    ventilation_score: float
    tree_preserved_count: int
    orientation_degrees: float


class UserCreate(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None


class UserLogin(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: str
    email: str
    full_name: Optional[str] = None

    class Config:
        from_attributes = True


class NotificationResponse(BaseModel):
    id: str
    title: str
    message: str
    type: str
    is_read: bool
    created_at: str

    class Config:
        from_attributes = True
