import { create } from "zustand";
import type {
  AnalysisResponse,
  EcoAuditReportSchema,
  FloorPlanResponse,
  FloorPlanVariant,
  RoomSchema,
  WallSchema,
  WindowSchema,
} from "@/lib/api";

interface Eco3DState {
  selectedLat: number | null;
  selectedLon: number | null;
  selectedPolygon: number[][] | null;
  selectedPlotArea: number | null;
  currentPlotId: string | null;
  analysis: AnalysisResponse | null;
  floorPlan: FloorPlanResponse | null;
  floorPlanData: FloorPlanResponse | null;
  floorPlanVariants: FloorPlanVariant[];
  activeVariantIndex: number;
  activeIterationIndex: number;
  activeAudit: EcoAuditReportSchema | null;
  activeRooms: RoomSchema[];
  activeWalls: WallSchema[];
  activeWindows: WindowSchema[];
  selectedAlgorithm: string | null;
  environmentalData: AnalysisResponse["environmental"] | null;
  isAnalyzing: boolean;
  isGeneratingFloorPlan: boolean;
  error: string | null;
  setSelectedLocation: (lat: number, lon: number, polygon?: number[][]) => void;
  setSelectedPlotArea: (area: number | null) => void;
  setAnalysis: (analysis: AnalysisResponse) => void;
  setFloorPlan: (fp: FloorPlanResponse) => void;
  setFloorPlanVariants: (variants: FloorPlanVariant[], bestIndex: number) => void;
  setActiveVariantIndex: (i: number) => void;
  setActiveIterationIndex: (i: number) => void;
  setActiveAudit: (a: EcoAuditReportSchema | null) => void;
  setActiveLayout: (rooms: RoomSchema[], walls: WallSchema[], windows: WindowSchema[]) => void;
  setAnalyzing: (v: boolean) => void;
  setGeneratingFloorPlan: (v: boolean) => void;
  setError: (e: string | null) => void;
  reset: () => void;
}

export const useEco3DStore = create<Eco3DState>((set, get) => ({
  selectedLat: null, selectedLon: null, selectedPolygon: null, selectedPlotArea: null, currentPlotId: null,
  analysis: null, floorPlan: null, floorPlanData: null,
  floorPlanVariants: [], activeVariantIndex: 0,
  activeIterationIndex: 0,
  activeAudit: null,
  activeRooms: [],
  activeWalls: [],
  activeWindows: [],
  selectedAlgorithm: null,
  environmentalData: null,
  isAnalyzing: false, isGeneratingFloorPlan: false, error: null,

  setSelectedLocation: (lat, lon, polygon) => set({
    selectedLat: lat, selectedLon: lon, selectedPolygon: polygon || null,
    currentPlotId: `PLOT${Math.abs(Math.floor(lat * 1000))}X${Math.abs(Math.floor(lon * 1000))}`,
  }),
  setSelectedPlotArea: (selectedPlotArea) => set({ selectedPlotArea }),
  setAnalysis: (analysis) => set({ analysis, environmentalData: analysis.environmental }),
  setFloorPlan: (floorPlan) => {
    const snapshots = floorPlan.iteration_history?.snapshots ?? [];
    const bestIndex = floorPlan.best_variant_index ?? 0;
    const bestVariant = floorPlan.variants?.[bestIndex] ?? null;
    const mappedSnapshot = snapshots.find((snap) => snap.variant_index === bestIndex);
    const finalSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    const activeSnapshot = mappedSnapshot ?? finalSnapshot;
    set({
      floorPlan,
      floorPlanData: floorPlan,
      selectedAlgorithm: bestVariant?.algorithm ?? null,
      activeIterationIndex: activeSnapshot?.iteration ?? 0,
      activeAudit: activeSnapshot?.audit ?? bestVariant?.eco_audit ?? null,
      activeRooms: activeSnapshot?.rooms ?? bestVariant?.layout ?? floorPlan.layout ?? [],
      activeWalls: activeSnapshot?.walls ?? bestVariant?.walls ?? floorPlan.walls ?? [],
      activeWindows: activeSnapshot?.windows ?? bestVariant?.windows ?? floorPlan.windows ?? [],
    });
  },
  setFloorPlanVariants: (variants, bestIndex) => set((state) => {
    const clampedIndex = variants.length > 0
      ? Math.max(0, Math.min(bestIndex, variants.length - 1))
      : 0;
    const selectedVariant = variants[clampedIndex];
    const snapshots = state.floorPlan?.iteration_history?.snapshots ?? [];
    const mappedSnapshot = snapshots.find((snap) => snap.variant_index === clampedIndex);
    const finalSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    const activeSnapshot = mappedSnapshot ?? (clampedIndex === 0 ? finalSnapshot : null);

    return {
      floorPlanVariants: variants,
      activeVariantIndex: clampedIndex,
      selectedAlgorithm: selectedVariant?.algorithm ?? null,
      activeIterationIndex: activeSnapshot?.iteration ?? state.activeIterationIndex,
      activeAudit: activeSnapshot?.audit ?? selectedVariant?.eco_audit ?? state.activeAudit,
      activeRooms: activeSnapshot?.rooms ?? selectedVariant?.layout ?? state.activeRooms,
      activeWalls: activeSnapshot?.walls ?? selectedVariant?.walls ?? state.activeWalls,
      activeWindows: activeSnapshot?.windows ?? selectedVariant?.windows ?? state.activeWindows,
    };
  }),
  setActiveVariantIndex: (activeVariantIndex) => {
    set((state) => {
      const variants = state.floorPlanVariants;
      if (variants.length === 0) {
        return { activeVariantIndex: 0, selectedAlgorithm: null };
      }

      const clampedIndex = Math.max(0, Math.min(activeVariantIndex, variants.length - 1));
      const selectedVariant = variants[clampedIndex];
      const snapshots = state.floorPlan?.iteration_history?.snapshots ?? [];
      const mappedSnapshot = snapshots.find((snap) => snap.variant_index === clampedIndex);
      const finalSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
      const activeSnapshot = mappedSnapshot ?? (clampedIndex === 0 ? finalSnapshot : null);

      return {
        activeVariantIndex: clampedIndex,
        selectedAlgorithm: selectedVariant?.algorithm ?? null,
        activeIterationIndex: activeSnapshot?.iteration ?? state.activeIterationIndex,
        activeAudit: activeSnapshot?.audit ?? selectedVariant?.eco_audit ?? state.activeAudit,
        activeRooms: activeSnapshot?.rooms ?? selectedVariant?.layout ?? state.activeRooms,
        activeWalls: activeSnapshot?.walls ?? selectedVariant?.walls ?? state.activeWalls,
        activeWindows: activeSnapshot?.windows ?? selectedVariant?.windows ?? state.activeWindows,
      };
    });
  },
  setActiveIterationIndex: (activeIterationIndex) => {
    set((state) => {
      const snapshots = state.floorPlan?.iteration_history?.snapshots ?? [];
      if (snapshots.length === 0) {
        return { activeIterationIndex };
      }

      const clampedIndex = Math.max(0, Math.min(activeIterationIndex, snapshots.length - 1));
      const snapshot = snapshots[clampedIndex];
      const mappedVariantIndex = snapshot?.variant_index;
      const mappedVariant = (
        mappedVariantIndex !== undefined &&
        mappedVariantIndex !== null &&
        mappedVariantIndex >= 0 &&
        mappedVariantIndex < state.floorPlanVariants.length
      )
        ? state.floorPlanVariants[mappedVariantIndex]
        : null;

      return {
        activeIterationIndex: clampedIndex,
        activeVariantIndex: mappedVariantIndex ?? state.activeVariantIndex,
        selectedAlgorithm: mappedVariant?.algorithm ?? state.selectedAlgorithm,
        activeAudit: snapshot?.audit ?? state.activeAudit,
        activeRooms: snapshot?.rooms ?? state.activeRooms,
        activeWalls: snapshot?.walls ?? state.activeWalls,
        activeWindows: snapshot?.windows ?? state.activeWindows,
      };
    });
  },
  setActiveAudit: (activeAudit) => set({ activeAudit }),
  setActiveLayout: (activeRooms, activeWalls, activeWindows) =>
    set({ activeRooms, activeWalls, activeWindows }),
  setAnalyzing:             (isAnalyzing)             => set({ isAnalyzing }),
  setGeneratingFloorPlan:   (isGeneratingFloorPlan)   => set({ isGeneratingFloorPlan }),
  setError:                 (error)                   => set({ error }),
  reset: () => set({
    analysis: null, floorPlan: null, floorPlanData: null,
    floorPlanVariants: [], activeVariantIndex: 0,
    activeIterationIndex: 0,
    activeAudit: null,
    activeRooms: [],
    activeWalls: [],
    activeWindows: [],
    selectedAlgorithm: null,
    environmentalData: null, error: null,
    isAnalyzing: false, isGeneratingFloorPlan: false,
    selectedPlotArea: null,
  }),
}));

// Re-export for convenience
export type { FloorPlanVariant };
