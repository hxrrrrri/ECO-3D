import { create } from "zustand";
import type { AnalysisResponse, FloorPlanResponse } from "@/lib/api";

interface Eco3DState {
  selectedLat: number | null;
  selectedLon: number | null;
  selectedPolygon: number[][] | null;
  currentPlotId: string | null;
  analysis: AnalysisResponse | null;
  floorPlan: FloorPlanResponse | null;
  floorPlanData: FloorPlanResponse | null;
  environmentalData: AnalysisResponse["environmental"] | null;
  isAnalyzing: boolean;
  isGeneratingFloorPlan: boolean;
  error: string | null;
  setSelectedLocation: (lat: number, lon: number, polygon?: number[][]) => void;
  setAnalysis: (analysis: AnalysisResponse) => void;
  setFloorPlan: (fp: FloorPlanResponse) => void;
  setAnalyzing: (v: boolean) => void;
  setGeneratingFloorPlan: (v: boolean) => void;
  setError: (e: string | null) => void;
  reset: () => void;
}

export const useEco3DStore = create<Eco3DState>((set) => ({
  selectedLat: null, selectedLon: null, selectedPolygon: null, currentPlotId: null,
  analysis: null, floorPlan: null, floorPlanData: null, environmentalData: null,
  isAnalyzing: false, isGeneratingFloorPlan: false, error: null,
  setSelectedLocation: (lat, lon, polygon) => set({
    selectedLat: lat, selectedLon: lon, selectedPolygon: polygon || null,
    currentPlotId: `PLOT-${Math.floor(lat * 1000)}-${Math.floor(lon * 1000)}`,
  }),
  setAnalysis: (analysis) => set({ analysis, environmentalData: analysis.environmental }),
  setFloorPlan: (floorPlan) => set({ floorPlan, floorPlanData: floorPlan }),
  setAnalyzing: (isAnalyzing) => set({ isAnalyzing }),
  setGeneratingFloorPlan: (isGeneratingFloorPlan) => set({ isGeneratingFloorPlan }),
  setError: (error) => set({ error }),
  reset: () => set({ analysis: null, floorPlan: null, floorPlanData: null, environmentalData: null, error: null, isAnalyzing: false, isGeneratingFloorPlan: false }),
}));
