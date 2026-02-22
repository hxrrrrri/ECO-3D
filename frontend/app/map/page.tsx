"use client";
import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { analyzePlot, generateFloorPlan } from "@/lib/api";
import dynamic from "next/dynamic";

const MapComponent = dynamic(() => import("@/components/MapComponent"), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#080e0e" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <div style={{ width: 32, height: 32, border: "2px solid rgba(13,242,242,0.3)", borderTop: "2px solid #0df2f2", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
        <p style={{ fontSize: 11, color: "rgba(13,242,242,0.6)", textTransform: "uppercase", letterSpacing: "0.15em" }}>Loading Map...</p>
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

  const handleLocationSelect = useCallback(async (lat: number, lon: number) => {
    setSelectedLocation(lat, lon);
    setStage("locating");
    setStatusMsg("Detecting plot boundary…");
    setBuildability(null);
    setPlotBoundary(null);
    setPlotArea(null);
    setError(null);

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const resp = await fetch(`${apiBase}/plot-boundary?lat=${lat}&lon=${lon}`);
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
      await new Promise(r => setTimeout(r, 500));
      router.push(`/analysis/${currentPlotId}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Analysis failed — is backend running on port 8000?";
      setError(msg);
      setStage("ready");
    } finally {
      setAnalyzing(false);
    }
  };

  const isOverlayVisible = stage === "locating" || stage === "analyzing" || stage === "done";

  // Panel z-index must be > 800 (Leaflet control max) but we use pointer-events to keep map clickable
  const PANEL_Z = 1200;

  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform: translateY(0); } }
      `}</style>

      <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column", overflow: "hidden", background: "#080e0e", fontFamily: "'Space Grotesk', sans-serif" }}>

        {/* Header — sits above everything */}
        <header style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(8,14,14,0.99)", position: "relative", zIndex: PANEL_Z + 100 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 24 }}>deployed_code</span>
            <span style={{ fontWeight: 700, color: "white", fontSize: 15, letterSpacing: "-0.01em" }}>
              ECO-3D <span style={{ color: "rgba(13,242,242,0.6)", fontWeight: 300 }}>Studio</span>
            </span>
          </Link>
          <div style={{ fontSize: 11, color: "#64748b", textAlign: "center" }}>
            Click anywhere on the map to begin real-time environmental analysis
          </div>
          <div style={{ width: 128 }} />
        </header>

        {/* Map container — fills remaining space */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>

          {/* Map itself */}
          <MapComponent
            onLocationSelect={handleLocationSelect}
            plotBoundary={plotBoundary}
            selectedLat={selectedLat}
            selectedLon={selectedLon}
          />

          {/* ── LOCATING / ANALYZING overlay ── */}
          {isOverlayVisible && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(6,14,14,0.82)", zIndex: PANEL_Z, animation: "fadeUp 0.25s ease" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, borderRadius: 20, padding: "32px 40px", minWidth: 320, background: "rgba(8,20,20,0.94)", backdropFilter: "blur(20px)", border: "1px solid rgba(13,242,242,0.15)" }}>
                <div style={{ position: "relative", width: 64, height: 64 }}>
                  <div style={{ position: "absolute", inset: 0, border: "2px solid rgba(13,242,242,0.15)", borderRadius: "50%" }} />
                  <div style={{ position: "absolute", inset: 0, border: "2px solid transparent", borderTop: "2px solid #0df2f2", borderRadius: "50%", animation: stage === "done" ? "none" : "spin 1s linear infinite" }} />
                  <span className="material-symbols-outlined" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#0df2f2", fontSize: 22 }}>
                    {stage === "done" ? "check_circle" : "satellite_alt"}
                  </span>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "white", marginBottom: 6 }}>
                    {stage === "locating" ? "Detecting Plot Boundary" : stage === "done" ? "Analysis Complete" : "Analysing Plot"}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(13,242,242,0.7)" }}>{statusMsg}</div>
                </div>
                <div style={{ width: "100%", height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", background: "#0df2f2", borderRadius: 2, transition: "width 0.6s ease", width: stage === "done" ? "100%" : stage === "locating" ? "30%" : "70%" }} />
                </div>
                <div style={{ fontSize: 10, color: "#475569", textAlign: "center" }}>Fetching data from Open-Elevation, Open-Meteo &amp; OSM</div>
              </div>
            </div>
          )}

          {/* ── READY panel — appears after boundary loaded ── */}
          {stage === "ready" && selectedLat && (
            <div style={{
              position: "absolute", bottom: 32, left: "50%", transform: "translateX(-50%)",
              display: "flex", flexDirection: "column", gap: 12,
              borderRadius: 20, padding: 20, minWidth: 360, maxWidth: 440, width: "calc(100% - 48px)",
              background: "rgba(8,20,20,0.97)", backdropFilter: "blur(20px)",
              border: "1px solid rgba(13,242,242,0.2)", zIndex: PANEL_Z,
              boxShadow: "0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(13,242,242,0.06)",
              animation: "fadeUp 0.3s ease",
            }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 22 }}>location_on</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", color: "#0df2f2", fontWeight: 700, marginBottom: 2 }}>Plot Selected</div>
                  <div style={{ fontSize: 12, fontFamily: "monospace", color: "white" }}>
                    {selectedLat.toFixed(5)}°N &nbsp;·&nbsp; {selectedLon?.toFixed(5)}°E
                  </div>
                </div>
                <div style={{
                  padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                  background: buildability?.ok === false ? "rgba(239,68,68,0.15)" : "rgba(13,242,242,0.1)",
                  color: buildability?.ok === false ? "#f87171" : "#0df2f2",
                  border: `1px solid ${buildability?.ok === false ? "rgba(239,68,68,0.3)" : "rgba(13,242,242,0.2)"}`,
                }}>
                  {buildability?.ok === false ? "⚠ Restricted" : "✓ Buildable"}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "Plot Area", value: plotArea ? `${plotArea.toLocaleString()} m²` : "—" },
                  { label: "Boundary", value: plotBoundary ? `${plotBoundary.length} pts` : "Auto" },
                  { label: "Plot ID", value: currentPlotId?.slice(0, 14) ?? "—" },
                ].map(({ label, value }) => (
                  <div key={label} style={{ borderRadius: 10, padding: "8px 12px", background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)" }}>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.15em", color: "#475569", marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 700, color: "white" }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Warning */}
              {buildability?.ok === false && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, borderRadius: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                  <span className="material-symbols-outlined" style={{ color: "#f87171", fontSize: 16, marginTop: 1 }}>warning</span>
                  <span style={{ fontSize: 11, color: "#fca5a5", lineHeight: 1.5 }}>{buildability.reason}</span>
                </div>
              )}

              {/* Error */}
              {error && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, borderRadius: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                  <span className="material-symbols-outlined" style={{ color: "#f87171", fontSize: 16, marginTop: 1 }}>error</span>
                  <span style={{ fontSize: 11, color: "#fca5a5", lineHeight: 1.5 }}>{error}</span>
                </div>
              )}

              {/* CTA */}
              <button
                onClick={runAnalysis}
                disabled={isAnalyzing || buildability?.ok === false}
                style={{
                  width: "100%", padding: "14px 0", borderRadius: 14, fontSize: 13,
                  fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                  background: buildability?.ok === false ? "rgba(255,255,255,0.04)" : "#0df2f2",
                  color: buildability?.ok === false ? "#475569" : "#080e0e",
                  border: "none", cursor: buildability?.ok === false ? "not-allowed" : "pointer",
                  boxShadow: buildability?.ok === false ? "none" : "0 0 24px rgba(13,242,242,0.35)",
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                  {error ? "refresh" : "analytics"}
                </span>
                {error ? "Retry Analysis" : "Analyse Plot"}
              </button>

              <div style={{ fontSize: 10, color: "#334155", textAlign: "center" }}>
                Or click a different point on the map to reselect
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
