import { create } from "zustand";
import type { AnalysisResponse, FloorPlanResponse, FloorPlanVariant } from "@/lib/api";

interface Eco3DState {
  selectedLat: number | null;
  selectedLon: number | null;
  selectedPolygon: number[][] | null;
  currentPlotId: string | null;
  analysis: AnalysisResponse | null;
  floorPlan: FloorPlanResponse | null;
  floorPlanData: FloorPlanResponse | null;
  floorPlanVariants: FloorPlanVariant[];
  activeVariantIndex: number;
  environmentalData: AnalysisResponse["environmental"] | null;
  isAnalyzing: boolean;
  isGeneratingFloorPlan: boolean;
  error: string | null;
  setSelectedLocation: (lat: number, lon: number, polygon?: number[][]) => void;
  setAnalysis: (analysis: AnalysisResponse) => void;
  setFloorPlan: (fp: FloorPlanResponse) => void;
  setFloorPlanVariants: (variants: FloorPlanVariant[], bestIndex: number) => void;
  setActiveVariantIndex: (i: number) => void;
  setAnalyzing: (v: boolean) => void;
  setGeneratingFloorPlan: (v: boolean) => void;
  setError: (e: string | null) => void;
  reset: () => void;
}

export const useEco3DStore = create<Eco3DState>((set) => ({
  selectedLat: null, selectedLon: null, selectedPolygon: null, currentPlotId: null,
  analysis: null, floorPlan: null, floorPlanData: null,
  floorPlanVariants: [], activeVariantIndex: 0,
  environmentalData: null,
  isAnalyzing: false, isGeneratingFloorPlan: false, error: null,

  setSelectedLocation: (lat, lon, polygon) => set({
    selectedLat: lat, selectedLon: lon, selectedPolygon: polygon || null,
    currentPlotId: `PLOT${Math.abs(Math.floor(lat * 1000))}X${Math.abs(Math.floor(lon * 1000))}`,
  }),
  setAnalysis: (analysis) => set({ analysis, environmentalData: analysis.environmental }),
  setFloorPlan: (floorPlan) => set({ floorPlan, floorPlanData: floorPlan }),
  setFloorPlanVariants: (variants, bestIndex) => set({
    floorPlanVariants: variants,
    activeVariantIndex: bestIndex,
  }),
  setActiveVariantIndex: (activeVariantIndex) => set({ activeVariantIndex }),
  setAnalyzing:             (isAnalyzing)             => set({ isAnalyzing }),
  setGeneratingFloorPlan:   (isGeneratingFloorPlan)   => set({ isGeneratingFloorPlan }),
  setError:                 (error)                   => set({ error }),
  reset: () => set({
    analysis: null, floorPlan: null, floorPlanData: null,
    floorPlanVariants: [], activeVariantIndex: 0,
    environmentalData: null, error: null,
    isAnalyzing: false, isGeneratingFloorPlan: false,
  }),
}));

// Re-export for convenience
export type { FloorPlanVariant };
