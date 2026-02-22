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
}

export interface FloorPlanResponse {
  plot_id: string;
  layout: Array<{
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
    length: number;
    thickness: number;
  }>;
  doors?: Array<{
    room_to: string;
    type: string;
    x: number;
    y: number;
    width: number;
    orientation: string;
    symbol: string;
  }>;
  windows?: Array<{
    wall: string;
    position: number;
    width: number;
  }>;
  total_area: number;
  fitness_score: number;
  generation_count: number;
  sunlight_score: number;
  ventilation_score: number;
  tree_preserved_count: number;
  orientation_degrees: number;
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
