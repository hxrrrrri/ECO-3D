import axios from "axios";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 60000,
  headers: { "Content-Type": "application/json" },
});

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
}

export interface FloorPlanVariant {
  id: number;
  style: string;
  layout: Array<{
    id?: string;
    type: string;
    width: number;
    height: number;
    x: number;
    y: number;
    floor: number;
    orientation: string;
  }>;
  total_area: number;
  solar_score: number;
  ventilation_score: number;
  fitness_score: number;
  eco_score: number;
  is_best: boolean;
  walls?: Array<{
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
  }>;
  doors?: Array<{
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
  }>;
  windows?: Array<{
    id?: string;
    wall: string;
    position: number;
    width: number;
    floor: number;
    sill_height: number;
    head_height: number;
  }>;
}

export interface FloorPlanResponse {
  plot_id: string;
  layout: Array<{
    id?: string;
    type: string;
    width: number;
    height: number;
    x: number;
    y: number;
    floor: number;
    orientation: string;
  }>;
  walls?: Array<{
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
    }>;
  doors?: Array<{
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
  }>;
  windows?: Array<{
    id?: string;
    wall: string;
    position: number;
    width: number;
    floor: number;
    sill_height: number;
    head_height: number;
  }>;
  total_area: number;
  fitness_score: number;
  eco_score: number;
  generation_count: number;
  sunlight_score: number;
  ventilation_score: number;
  tree_preserved_count: number;
  orientation_degrees: number;
  variants?: FloorPlanVariant[];
  best_variant_index?: number;
}

export const analyzePlot = async (req: AnalyzePlotRequest): Promise<AnalysisResponse> => {
  const { data } = await api.post("/analyze-plot", req);
  return data;
};

export const generateFloorPlan = async (
  req: GenerateFloorPlanRequest
): Promise<FloorPlanResponse> => {
  const { data } = await api.post("/generate-floorplan", req);
  return data;
};

export const getReport = async (plotId: string) => {
  const { data } = await api.get(`/report/${plotId}`);
  return data;
};

export const getPlots = async () => {
  const { data } = await api.get("/plots");
  return data;
};

export const healthCheck = async () => {
  const { data } = await api.get("/health");
  return data;
};

export default api;
