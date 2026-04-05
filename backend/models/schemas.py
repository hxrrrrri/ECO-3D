"""Pydantic request/response schemas."""
from typing import Optional, List, Any
from datetime import datetime
from pydantic import BaseModel, Field, field_serializer, field_validator


def _normalize_generation_method(value: Optional[str]) -> str:
    raw = (value or "deterministic").strip().lower()
    compact = "".join(ch for ch in raw if ch.isalnum())
    ga_aliases = {
        "ga",
        "gaoptimizer",
        "gaoptimiser",
        "gaoptimization",
        "gaoptimisation",
        "genetic",
        "geneticalgo",
        "geneticalgorithm",
        "evolutionary",
    }
    return "ga" if compact in ga_aliases else "deterministic"


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
    generation_method: str = "deterministic"  # deterministic (default) | ga
    ga_seed: Optional[int] = None
    ga_time_budget_ms: int = 2500
    layout_mode: str = "default"  # default | fit_boundary
    max_iterations: Optional[int] = 12
    target_eco_score: Optional[float] = 92.0

    @field_validator("generation_method")
    @classmethod
    def validate_generation_method(cls, v: str) -> str:
        return _normalize_generation_method(v)

    @field_validator("ga_time_budget_ms")
    @classmethod
    def validate_ga_time_budget(cls, v: int) -> int:
        return max(1200, min(int(v), 8000))

    @field_validator("layout_mode")
    @classmethod
    def validate_layout_mode(cls, v: str) -> str:
        mode = (v or "default").strip().lower()
        if mode not in {"default", "fit_boundary"}:
            return "default"
        return mode

    @field_validator("max_iterations")
    @classmethod
    def validate_max_iterations(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return 12
        return max(1, min(int(v), 20))

    @field_validator("target_eco_score")
    @classmethod
    def validate_target_eco_score(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return 92.0
        return max(50.0, min(float(v), 100.0))


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
    id: Optional[str] = None
    room_id: str
    type: str
    orientation: str
    x: float
    y: float
    length: float
    thickness: float
    floor: int = 1
    height: float = 3.2
    x2: Optional[float] = None
    y2: Optional[float] = None


class Door(BaseModel):
    id: Optional[str] = None
    room_to: str
    type: str
    x: float
    y: float
    width: float
    orientation: str
    symbol: str
    floor: int = 1
    height: float = 2.1
    wall_id: Optional[str] = None


class Window(BaseModel):
    id: Optional[str] = None
    wall: str
    position: float
    width: float
    floor: int = 1
    sill_height: float = 0.9
    head_height: float = 2.1


class CriterionResultSchema(BaseModel):
    criterion_id: int
    criterion_name: str
    score: float
    weight: float
    weighted_score: float
    passed: bool
    pass_threshold: float
    sub_scores: dict
    findings: List[str]
    penalties_applied: List[str]
    bonuses_applied: List[str]
    recommendations: List[str]
    data_sources: List[str]
    standard_ref: str


class EcoAuditReportSchema(BaseModel):
    variant_id: int
    algorithm: str
    timestamp: str
    criteria: List[CriterionResultSchema]
    composite_eco_score: float
    grade: str
    overall_passed: bool
    n_criteria_passed: int
    n_criteria_failed: int
    critical_failures: List[str]
    top_strengths: List[str]
    top_weaknesses: List[str]
    priority_fixes: List[str]
    climate_context: str
    site_risk_level: str
    compliance_citations: List[str]
    data_quality: dict


class RoomMutationSchema(BaseModel):
    room_id: str
    mutation_type: str
    old_value: dict
    new_value: dict
    criterion_id: int
    reason: str
    confidence: float


class CorrectionResultSchema(BaseModel):
    iteration: int
    mutations_applied: List[RoomMutationSchema]
    n_mutations: int
    criteria_targeted: List[int]
    eco_score_before: float
    eco_score_after: float
    score_delta: float
    improvement: bool


class IterationSnapshotSchema(BaseModel):
    iteration: int
    eco_score: float
    n_criteria_passed: int
    n_criteria_failed: int
    correction: Optional[CorrectionResultSchema] = None
    cumulative_fixes: List[str]
    audit: EcoAuditReportSchema
    rooms: List[Room] = Field(default_factory=list)
    windows: List[Window] = Field(default_factory=list)
    walls: List[Wall] = Field(default_factory=list)
    variant_index: Optional[int] = None


class IterationHistorySchema(BaseModel):
    total_iterations: int
    converged: bool
    convergence_reason: str
    initial_eco_score: float
    final_eco_score: float
    total_improvement: float
    eco_score_curve: List[float]
    snapshots: List[IterationSnapshotSchema]
    corrections_applied: List[str]


class FloorPlanVariant(BaseModel):
    id: int
    algorithm: str = "Deterministic"
    style: str
    layout: List[Room]
    walls: Optional[List[Wall]] = None
    doors: Optional[List[Door]] = None
    windows: Optional[List[Window]] = None
    total_area: float
    eco_score: float
    solar_score: float
    ventilation_score: float
    structural_score: float = 0.0
    flood_score: float = 0.0
    tree_score: float = 0.0
    is_best: bool
    fitness_score: float
    convergence_curve: Optional[List[float]] = None
    generations_run: Optional[int] = None
    converged_early: Optional[bool] = None
    runtime_ms: Optional[int] = None
    eco_audit: Optional[EcoAuditReportSchema] = None


class FloorPlanResponse(BaseModel):
    plot_id: str
    layout: List[Room]
    walls: Optional[List[Wall]] = None
    doors: Optional[List[Door]] = None
    windows: Optional[List[Window]] = None
    total_area: float
    fitness_score: float
    eco_score: float
    solar_score: Optional[float] = None
    generation_count: int
    sunlight_score: float
    ventilation_score: float
    structural_score: float = 0.0
    flood_score: float = 0.0
    tree_score: float = 0.0
    tree_preserved_count: int
    orientation_degrees: float
    variants: Optional[List[FloorPlanVariant]] = None
    best_variant_index: Optional[int] = None
    algorithms_used: Optional[List[str]] = None
    convergence_data: Optional[dict[str, Any]] = None
    iteration_history: Optional[IterationHistorySchema] = None
    generation_method: str = "deterministic"


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
