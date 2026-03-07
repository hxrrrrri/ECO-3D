"""Pydantic request/response schemas."""
from typing import Optional, List, Any
from datetime import datetime
from pydantic import BaseModel, Field, field_serializer, field_validator


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
    # Extended real-time fields
    wind_ms: Optional[float] = None
    solar_radiation_kwh: Optional[float] = None
    distance_to_water_m: Optional[float] = None
    # Full soil profile (SoilGrids v2 — ISRIC)
    clay_pct: Optional[float] = None
    sand_pct: Optional[float] = None
    silt_pct: Optional[float] = None
    soil_ph: Optional[float] = None
    organic_carbon: Optional[float] = None
    bulk_density: Optional[float] = None
    soil_buildable: Optional[bool] = None
    soil_source: Optional[str] = None
    # River flood (GloFAS — EU Copernicus)
    river_discharge_peak_m3s: Optional[float] = None
    river_discharge_mean_m3s: Optional[float] = None
    glofas_flood_index: Optional[float] = None
    flood_source: Optional[str] = None


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
    # New fields for plot shape and room preferences
    plot_shape: str = "rectangle"   # rectangle, L-shape, T-shape, irregular, square
    house_type: str = "Eco-Villa (Single Story)"
    room_preferences: Optional[dict] = None  # {"bedrooms":3,"bathrooms":2,"puja_room":True,...}
    maximize_sunlight: bool = True
    natural_ventilation: bool = True
    sustainability_priority: bool = True


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
    # ── Eco-optimization results (new — additive, all Optional so no breakage) ──
    eco_recommendations: Optional[List[str]] = None   # human-readable design hints
    solar_breakdown: Optional[dict] = None            # {room_id: solar_score}
    ventilation_path: Optional[list] = None           # [room_ids on cross-vent axis]


class UserCreate(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None


class UserLogin(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    id: Any
    email: str
    full_name: Optional[str] = None

    model_config = {"from_attributes": True}

    @field_serializer("id")
    def serialize_id(self, v):
        return str(v)


class NotificationResponse(BaseModel):
    id: Any
    title: str
    message: str
    type: str
    is_read: bool
    created_at: Any

    model_config = {"from_attributes": True}

    @field_serializer("id")
    def serialize_id(self, v):
        return str(v)

    @field_serializer("created_at")
    def serialize_created_at(self, v):
        if isinstance(v, datetime):
            return v.isoformat()
        return str(v) if v is not None else ""
