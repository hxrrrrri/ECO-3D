import axios from "axios";

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
const normalizedConfiguredApiUrl = configuredApiUrl ? configuredApiUrl.replace(/\/+$/, "") : "";
const browserHostname = typeof window !== "undefined" ? window.location.hostname : "";
const runningOnLocalhost = browserHostname === "localhost" || browserHostname === "127.0.0.1";
const fallbackLocalApiUrl = "http://127.0.0.1:8000";

export const API_BASE_URL = normalizedConfiguredApiUrl ||
  ((runningOnLocalhost || process.env.NODE_ENV !== "production") ? fallbackLocalApiUrl : "");

export const API_BASE_URL_CONFIG_ERROR =
  "Backend API URL is not configured for this deployment. Set NEXT_PUBLIC_API_URL to your deployed backend URL.";

export function ensureApiBaseUrlConfigured(): string {
  if (API_BASE_URL.length > 0) {
    return API_BASE_URL;
  }
  throw new Error(API_BASE_URL_CONFIG_ERROR);
}

const api = axios.create({
  baseURL: API_BASE_URL || undefined,
  timeout: 60000,
  headers: { "Content-Type": "application/json" },
});

export type CanonicalGenerationMethod = "deterministic" | "ga";
export type GenerationMethodAlias =
  | CanonicalGenerationMethod
  | "gaoptimizer"
  | "ga_optimiser"
  | "ga_optimizer"
  | "ga-optimizer"
  | "ga-optimiser"
  | "genetic"
  | "genetic_algorithm"
  | "genetic-algorithm";

export function normalizeGenerationMethod(method?: string): CanonicalGenerationMethod | undefined {
  if (!method) return undefined;
  const compact = method.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const gaAliases = new Set([
    "ga",
    "gaoptimizer",
    "gaoptimiser",
    "gaoptimization",
    "gaoptimisation",
    "genetic",
    "geneticalgo",
    "geneticalgorithm",
    "evolutionary",
  ]);
  return gaAliases.has(compact) ? "ga" : "deterministic";
}

export interface AnalyzePlotRequest {
  plot_id: string;
  lat: number;
  lon: number;
  polygon?: number[][];
}

export interface AnalysisResponse {
  plot_id: string;
  segmentation: {
    vegetation: number;
    water: number;
    urban: number;
    bare_soil: number;
    road: number;
  };
  tree_coordinates: Array<{ lat: number; lon: number; confidence: number }>;
  environmental: {
    ndvi: number;
    slope: number;
    elevation: number;
    rainfall_mm: number;
    soil_type: string;
    wind_direction: string;
    sun_exposure_hours: number;
    // Extended real-time fields
    wind_ms?: number;
    solar_radiation_kwh?: number;
    distance_to_water_m?: number;
    // Soil profile (SoilGrids v2)
    clay_pct?: number;
    sand_pct?: number;
    silt_pct?: number;
    soil_ph?: number;
    organic_carbon?: number;
    bulk_density?: number;
    soil_buildable?: boolean;
    soil_source?: string;
    // Flood data (GloFAS)
    river_discharge_peak_m3s?: number;
    river_discharge_mean_m3s?: number;
    glofas_flood_index?: number;
    flood_source?: string;
  };
  flood_probability: number;
  buildability_score: number;
  score_references?: string[];
  status: string;
}

export interface GenerateFloorPlanRequest {
  plot_id: string;
  plot_area_sqm?: number;
  num_floors?: number;
  style?: string;
  preserve_trees?: boolean;
  plot_shape?: string;
  house_type?: string;
  room_preferences?: Record<string, number | boolean>;
  maximize_sunlight?: boolean;
  natural_ventilation?: boolean;
  sustainability_priority?: boolean;
  generation_method?: GenerationMethodAlias;
  ga_seed?: number;
  ga_time_budget_ms?: number;
  layout_mode?: "default" | "fit_boundary";
  max_iterations?: number;
  target_eco_score?: number;
}

export interface RoomSchema {
  id?: string;
  type: string;
  width: number;
  height: number;
  x: number;
  y: number;
  floor: number;
  orientation: string;
}

export interface WallSchema {
  id?: string;
  room_id: string;
  type: string;
  orientation: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  length: number;
  thickness: number;
  floor: number;
  height: number;
}

export interface DoorSchema {
  id?: string;
  room_to: string;
  type: string;
  x: number;
  y: number;
  width: number;
  orientation: string;
  symbol: string;
  floor: number;
  height: number;
  wall_id?: string;
}

export interface WindowSchema {
  id?: string;
  wall: string;
  position: number;
  width: number;
  floor: number;
  sill_height: number;
  head_height: number;
}

export interface CriterionResultSchema {
  criterion_id: number;
  criterion_name: string;
  score: number;
  weight: number;
  weighted_score: number;
  passed: boolean;
  pass_threshold: number;
  sub_scores: Record<string, number>;
  findings: string[];
  penalties_applied: string[];
  bonuses_applied: string[];
  recommendations: string[];
  data_sources: string[];
  standard_ref: string;
}

export interface EcoAuditReportSchema {
  variant_id: number;
  algorithm: string;
  timestamp: string;
  criteria: CriterionResultSchema[];
  composite_eco_score: number;
  grade: "A+" | "A" | "B+" | "B" | "C+" | "C" | "D" | "F";
  overall_passed: boolean;
  n_criteria_passed: number;
  n_criteria_failed: number;
  critical_failures: string[];
  top_strengths: string[];
  top_weaknesses: string[];
  priority_fixes: string[];
  climate_context: "hot" | "temperate" | "cold" | string;
  site_risk_level: "high" | "moderate" | "low" | string;
  compliance_citations: string[];
  data_quality: {
    wind: boolean;
    soil: boolean;
    ndvi: boolean;
    flood: boolean;
    elevation: boolean;
    is_fully_live: boolean;
    live_field_count: number;
    fallback_field_count?: number;
  };
}

export interface RoomMutationSchema {
  room_id: string;
  mutation_type: string;
  old_value: Record<string, unknown>;
  new_value: Record<string, unknown>;
  criterion_id: number;
  reason: string;
  confidence: number;
}

export interface CorrectionResultSchema {
  iteration: number;
  mutations_applied: RoomMutationSchema[];
  n_mutations: number;
  criteria_targeted: number[];
  eco_score_before: number;
  eco_score_after: number;
  score_delta: number;
  improvement: boolean;
}

export interface IterationSnapshotSchema {
  iteration: number;
  eco_score: number;
  n_criteria_passed: number;
  n_criteria_failed: number;
  correction?: CorrectionResultSchema | null;
  cumulative_fixes: string[];
  audit: EcoAuditReportSchema;
  rooms: RoomSchema[];
  windows: WindowSchema[];
  walls: WallSchema[];
  variant_index?: number | null;
}

export interface IterationHistorySchema {
  total_iterations: number;
  converged: boolean;
  convergence_reason: string;
  initial_eco_score: number;
  final_eco_score: number;
  total_improvement: number;
  eco_score_curve: number[];
  snapshots: IterationSnapshotSchema[];
  corrections_applied: string[];
}

export interface FloorPlanVariant {
  id: number;
  algorithm: string;
  style: string;
  layout: RoomSchema[];
  total_area: number;
  eco_score: number;
  solar_score: number;
  ventilation_score: number;
  structural_score: number;
  flood_score: number;
  tree_score: number;
  fitness_score: number;
  is_best: boolean;
  convergence_curve?: number[];
  generations_run?: number;
  converged_early?: boolean;
  runtime_ms?: number;
  eco_audit?: EcoAuditReportSchema | null;
  walls?: WallSchema[];
  doors?: DoorSchema[];
  windows?: WindowSchema[];
}

export interface FloorPlanResponse {
  plot_id: string;
  layout: RoomSchema[];
  walls?: WallSchema[];
  doors?: DoorSchema[];
  windows?: WindowSchema[];
  total_area: number;
  fitness_score: number;
  eco_score: number;
  solar_score?: number;
  generation_count: number;
  sunlight_score: number;
  ventilation_score: number;
  structural_score: number;
  flood_score: number;
  tree_score: number;
  tree_preserved_count: number;
  orientation_degrees: number;
  variants?: FloorPlanVariant[];
  best_variant_index?: number;
  algorithms_used?: string[];
  convergence_data?: Record<string, unknown>;
  iteration_history?: IterationHistorySchema | null;
  generation_method?: CanonicalGenerationMethod;
}

export const analyzePlot = async (req: AnalyzePlotRequest): Promise<AnalysisResponse> => {
  ensureApiBaseUrlConfigured();
  const { data } = await api.post("/analyze-plot", req);
  return data;
};

export const generateFloorPlan = async (
  req: GenerateFloorPlanRequest
): Promise<FloorPlanResponse> => {
  ensureApiBaseUrlConfigured();
  const normalizedReq: GenerateFloorPlanRequest = { ...req };
  if (typeof req.generation_method === "string") {
    normalizedReq.generation_method = normalizeGenerationMethod(req.generation_method);
  }
  const { data } = await api.post("/generate-floorplan", normalizedReq);
  return data;
};

export const getReport = async (plotId: string) => {
  ensureApiBaseUrlConfigured();
  const { data } = await api.get(`/report/${plotId}`);
  return data;
};

export const getPlots = async () => {
  ensureApiBaseUrlConfigured();
  const { data } = await api.get("/plots");
  return data;
};

export const healthCheck = async () => {
  ensureApiBaseUrlConfigured();
  const { data } = await api.get("/health");
  return data;
};

export default api;
