"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { analyzePlot, generateFloorPlan } from "@/lib/api";
import dynamic from "next/dynamic";

const MapComponent = dynamic(() => import("@/components/MapComponent"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center" style={{ background: "#080e0e" }}>
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-xs text-primary/60 uppercase tracking-widest">Loading Map...</p>
      </div>
    </div>
  ),
});

export default function MapPage() {
  const router = useRouter();
  const {
    selectedLat, selectedLon, currentPlotId, isAnalyzing, error,
    setSelectedLocation, setAnalysis, setFloorPlan, setAnalyzing, setError,
  } = useEco3DStore();

  const [stage, setStage] = useState<"idle" | "locating" | "ready" | "analyzing" | "done">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [plotBoundary, setPlotBoundary] = useState<number[][] | null>(null);
  const [buildability, setBuildability] = useState<{ ok: boolean; reason: string } | null>(null);
  const [plotArea, setPlotArea] = useState<number | null>(null);

  // ── Map click → fetch boundary only, then wait for user to click Analyse ──
  const handleLocationSelect = useCallback(async (lat: number, lon: number) => {
    setSelectedLocation(lat, lon);
    setStage("locating");
    setStatusMsg("Detecting plot boundary…");
    setBuildability(null);
    setPlotBoundary(null);
    setPlotArea(null);
    setError(null);

    try {
      const resp = await fetch(`http://localhost:8000/plot-boundary?lat=${lat}&lon=${lon}`);
      if (resp.ok) {
        const data = await resp.json();
        setPlotBoundary(data.boundary ?? null);
        setBuildability({ ok: !!data.is_buildable, reason: data.reason ?? "" });
        if (data.area_sqm) setPlotArea(Math.round(data.area_sqm));
      } else {
        setBuildability({ ok: true, reason: "Boundary check unavailable — proceeding." });
      }
    } catch {
      setBuildability({ ok: true, reason: "Boundary check unavailable — proceeding." });
    }

    setStage("ready");
    setStatusMsg("");
  }, [setSelectedLocation, setError]);

  // ── User clicks "Analyse Plot" ────────────────────────────────────────────
  const runAnalysis = async () => {
    if (!selectedLat || !selectedLon || !currentPlotId) return;
    setAnalyzing(true);
    setStage("analyzing");
    setError(null);

    const steps = [
      "Fetching real elevation data…",
      "Querying soil classification…",
      "Computing NDVI from Open-Meteo…",
      "Retrieving wind & rainfall data…",
      "Calculating flood risk…",
      "Computing buildability score…",
      "Generating adaptive floor plan…",
    ];

    for (let i = 0; i < steps.length - 1; i++) {
      setStatusMsg(steps[i]);
      await new Promise(r => setTimeout(r, 600));
    }

    try {
      const result = await analyzePlot({
        plot_id: currentPlotId,
        lat: selectedLat,
        lon: selectedLon,
        polygon: plotBoundary || undefined,
      });
      setAnalysis(result);
      setStatusMsg(steps[steps.length - 1]);

      const fp = await generateFloorPlan({
        plot_id: currentPlotId,
        plot_area_sqm: plotArea ?? 200,
        num_floors: 2,
        preserve_trees: true,
      });
      setFloorPlan(fp);
      setStage("done");
      await new Promise(r => setTimeout(r, 400));
      router.push(`/analysis/${currentPlotId}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Analysis failed — is backend running on port 8000?";
      setError(msg);
      setStage("ready");   // return to ready so user can retry
    } finally {
      setAnalyzing(false);
    }
  };

  const isOverlayVisible = stage === "locating" || stage === "analyzing" || stage === "done";

  return (
    <>
      {/* ─── page shell ─────────────────────────────────────────── */}
      <div
        className="h-screen w-screen flex flex-col overflow-hidden"
        style={{ background: "#080e0e", fontFamily: "'Space Grotesk', sans-serif" }}
      >
        {/* Nav */}
        <header
          className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/5"
          style={{ background: "rgba(8,14,14,0.98)", zIndex: 2000, position: "relative" }}
        >
          <Link href="/" className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-2xl">deployed_code</span>
            <span className="font-bold text-white tracking-tight">
              ECO-3D <span className="text-primary/60 font-light">Studio</span>
            </span>
          </Link>
          <div className="text-[11px] text-slate-400 text-center">
            Click anywhere on the map to begin real-time environmental analysis
          </div>
          <div className="w-32" />
        </header>

        {/* Map + overlays */}
        <div className="flex-1 relative overflow-hidden" style={{ minHeight: 0 }}>
          <MapComponent
            onLocationSelect={handleLocationSelect}
            plotBoundary={plotBoundary}
            selectedLat={selectedLat}
            selectedLon={selectedLon}
          />

          {/* ── LOCATING / ANALYZING spinner overlay
              z-index MUST beat Leaflet tile pane (400) + popup pane (700)
              Use inline style so Tailwind purge doesn't kill it ── */}
          {isOverlayVisible && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ background: "rgba(6,14,14,0.82)", zIndex: 1100 }}
            >
              <div
                className="flex flex-col items-center gap-4 rounded-2xl p-8 min-w-[320px]"
                style={{
                  background: "rgba(8,20,20,0.92)",
                  backdropFilter: "blur(16px)",
                  border: "1px solid rgba(13,242,242,0.15)",
                }}
              >
                <div className="relative w-16 h-16">
                  <div className="absolute inset-0 border-2 border-primary/20 rounded-full" />
                  <div className="absolute inset-0 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <span className="absolute inset-0 flex items-center justify-center material-symbols-outlined text-primary text-xl">
                    {stage === "done" ? "check_circle" : "satellite_alt"}
                  </span>
                </div>
                <div className="text-center">
                  <div className="text-sm font-bold text-white mb-1">
                    {stage === "locating" ? "Detecting Plot Boundary" :
                      stage === "done" ? "Analysis Complete" :
                        "Analysing Plot"}
                  </div>
                  <div className="text-[11px] text-primary/70">{statusMsg}</div>
                </div>
                <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{
                      width: stage === "done" ? "100%" : "60%", transition: "width 0.6s ease",
                      animation: stage === "done" ? "none" : undefined
                    }}
                  />
                </div>
                <div className="text-[10px] text-slate-500 text-center">
                  Fetching real data from Open-Elevation, Open-Meteo, OpenLandMap &amp; OSM
                </div>
              </div>
            </div>
          )}

          {/* ── READY panel — shown after boundary loaded ── */}
          {stage === "ready" && selectedLat && (
            <div
              className="absolute left-1/2 bottom-8 -translate-x-1/2 flex flex-col gap-3 rounded-2xl p-5 min-w-[360px] max-w-[440px] w-full"
              style={{
                background: "rgba(8,20,20,0.95)",
                backdropFilter: "blur(16px)",
                border: "1px solid rgba(13,242,242,0.18)",
                zIndex: 1100,
                boxShadow: "0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(13,242,242,0.06)",
              }}
            >
              {/* Header row */}
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary text-xl">location_on</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-primary font-bold mb-0.5">
                    Plot Selected
                  </div>
                  <div className="text-[12px] font-mono text-white truncate">
                    {selectedLat.toFixed(5)}°N &nbsp;·&nbsp; {selectedLon?.toFixed(5)}°W
                  </div>
                </div>
                {/* Pixel indicator */}
                <div
                  className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider"
                  style={{
                    background: buildability?.ok === false ? "rgba(239,68,68,0.15)" : "rgba(13,242,242,0.1)",
                    color: buildability?.ok === false ? "#f87171" : "#0df2f2",
                    border: `1px solid ${buildability?.ok === false ? "rgba(239,68,68,0.3)" : "rgba(13,242,242,0.2)"}`,
                  }}
                >
                  {buildability?.ok === false ? "⚠ Restricted" : "✓ Buildable"}
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Plot Area", value: plotArea ? `${plotArea.toLocaleString()} m²` : "—" },
                  { label: "Boundary", value: plotBoundary ? `${plotBoundary.length} pts` : "Auto" },
                  { label: "Plot ID", value: currentPlotId?.slice(0, 14) ?? "—" },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    className="rounded-lg px-3 py-2"
                    style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)" }}
                  >
                    <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-0.5">{label}</div>
                    <div className="text-[12px] font-mono font-bold text-white">{value}</div>
                  </div>
                ))}
              </div>

              {/* Warning if not buildable */}
              {buildability?.ok === false && (
                <div
                  className="flex items-start gap-2 rounded-lg px-3 py-2.5"
                  style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
                >
                  <span className="material-symbols-outlined text-red-400 text-sm mt-0.5">warning</span>
                  <span className="text-[11px] text-red-300 leading-relaxed">{buildability.reason}</span>
                </div>
              )}

              {/* Error from previous attempt */}
              {error && (
                <div
                  className="flex items-start gap-2 rounded-lg px-3 py-2.5"
                  style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
                >
                  <span className="material-symbols-outlined text-red-400 text-sm mt-0.5">error</span>
                  <span className="text-[11px] text-red-300 leading-relaxed">{error}</span>
                </div>
              )}

              {/* CTA button */}
              <button
                onClick={runAnalysis}
                disabled={isAnalyzing || buildability?.ok === false}
                className="w-full py-3.5 rounded-xl font-bold text-[13px] tracking-widest uppercase flex items-center justify-center gap-2.5 transition-all"
                style={{
                  background: buildability?.ok === false ? "rgba(255,255,255,0.04)" : "#0df2f2",
                  color: buildability?.ok === false ? "#475569" : "#080e0e",
                  boxShadow: buildability?.ok === false ? "none" : "0 0 24px rgba(13,242,242,0.35)",
                  cursor: buildability?.ok === false ? "not-allowed" : "pointer",
                }}
              >
                <span className="material-symbols-outlined text-lg">
                  {error ? "refresh" : "analytics"}
                </span>
                {error ? "Retry Analysis" : "Analyse Plot"}
              </button>

              <div className="text-[10px] text-slate-600 text-center">
                Or click a different point on the map to reselect
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Override Leaflet z-indices so our overlays always sit on top */}
      <style>{`
        .leaflet-pane          { z-index: 400 !important; }
        .leaflet-tile-pane     { z-index: 200 !important; }
        .leaflet-overlay-pane  { z-index: 400 !important; }
        .leaflet-shadow-pane   { z-index: 500 !important; }
        .leaflet-marker-pane   { z-index: 600 !important; }
        .leaflet-tooltip-pane  { z-index: 650 !important; }
        .leaflet-popup-pane    { z-index: 700 !important; }
        .leaflet-map-pane      { z-index: 0 !important; }
        .leaflet-control       { z-index: 800 !important; }
        .leaflet-container     { background: #080e0e !important; }
        .leaflet-tile-pane     { filter: brightness(0.9) saturate(0.75); }
        .leaflet-control-zoom a {
          background: rgba(10,26,26,0.92) !important;
          color: #0df2f2 !important;
          border-color: rgba(13,242,242,0.3) !important;
        }
        .leaflet-control-zoom a:hover {
          background: rgba(13,242,242,0.12) !important;
        }
      `}</style>
    </>
  );
}
