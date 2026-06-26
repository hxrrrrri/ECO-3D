"use client";
import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import {
  API_BASE_URL_CONFIG_ERROR,
  analyzePlot,
  ensureApiBaseUrlConfigured,
  generateFloorPlan,
  getPlotBoundary,
  getRequestErrorMessage,
} from "@/lib/api";
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

// ── Indian States list ─────────────────────────────────────────────────────────
const INDIAN_STATES = [
  { id: "andhra_pradesh", name: "Andhra Pradesh" },
  { id: "assam", name: "Assam" },
  { id: "bihar", name: "Bihar" },
  { id: "chhattisgarh", name: "Chhattisgarh" },
  { id: "delhi", name: "Delhi" },
  { id: "goa", name: "Goa" },
  { id: "gujarat", name: "Gujarat" },
  { id: "haryana", name: "Haryana" },
  { id: "himachal_pradesh", name: "Himachal Pradesh" },
  { id: "jharkhand", name: "Jharkhand" },
  { id: "karnataka", name: "Karnataka" },
  { id: "kerala", name: "Kerala" },
  { id: "madhya_pradesh", name: "Madhya Pradesh" },
  { id: "maharashtra", name: "Maharashtra" },
  { id: "manipur", name: "Manipur" },
  { id: "meghalaya", name: "Meghalaya" },
  { id: "odisha", name: "Odisha" },
  { id: "punjab", name: "Punjab" },
  { id: "rajasthan", name: "Rajasthan" },
  { id: "tamil_nadu", name: "Tamil Nadu" },
  { id: "telangana", name: "Telangana" },
  { id: "uttar_pradesh", name: "Uttar Pradesh" },
  { id: "uttarakhand", name: "Uttarakhand" },
  { id: "west_bengal", name: "West Bengal" },
];

// States with Bhu Naksha (better boundary data)
const BHU_NAKSHA_STATES = new Set([
  "bihar", "chhattisgarh", "jharkhand", "karnataka", "madhya_pradesh",
  "maharashtra", "odisha", "rajasthan", "uttar_pradesh", "uttarakhand",
]);

function normalizeBoundaryLonLat(
  boundary: unknown,
  anchor?: { lat: number; lon: number },
): number[][] | null {
  if (!Array.isArray(boundary)) return null;

  const raw = boundary
    .filter((item): item is number[] => Array.isArray(item) && item.length >= 2)
    .map((pair) => [Number(pair[0]), Number(pair[1])]);

  if (raw.length < 3) return null;

  const candidateFromOrder = (lonIdx: 0 | 1, latIdx: 0 | 1) => {
    const points: number[][] = [];
    for (const pair of raw) {
      const lon = Number(pair[lonIdx]);
      const lat = Number(pair[latIdx]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
      points.push([lon, lat]);
    }

    if (points.length < 3) return null;

    const closed = [...points];
    const first = closed[0];
    const last = closed[closed.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      closed.push([first[0], first[1]]);
    }

    const open = closed.slice(0, -1);
    const centroidLon = open.reduce((acc, p) => acc + p[0], 0) / Math.max(open.length, 1);
    const centroidLat = open.reduce((acc, p) => acc + p[1], 0) / Math.max(open.length, 1);

    let score = 0;
    if (anchor) {
      score += Math.abs(centroidLat - anchor.lat) + Math.abs(centroidLon - anchor.lon);
    } else {
      // Bias toward India bounds when no anchor exists (land-record-first lookup flow).
      if (centroidLat < 5 || centroidLat > 38) score += 1000;
      if (centroidLon < 67 || centroidLon > 98) score += 1000;
    }

    return { points: closed, score };
  };

  const candidates = [candidateFromOrder(0, 1), candidateFromOrder(1, 0)]
    .filter((c): c is { points: number[][]; score: number } => c !== null)
    .sort((a, b) => a.score - b.score);

  return candidates.length > 0 ? candidates[0].points : null;
}

export default function MapPage() {
  const router = useRouter();
  const {
    selectedLat, selectedLon, currentPlotId, isAnalyzing, error,
    setSelectedLocation, setSelectedPlotArea, setAnalysis, setFloorPlan, setAnalyzing, setError,
  } = useEco3DStore();

  const [stage, setStage] = useState<"idle" | "locating" | "ready" | "analyzing" | "done">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [plotBoundary, setPlotBoundary] = useState<number[][] | null>(null);
  const [buildability, setBuildability] = useState<{ ok: boolean; reason: string } | null>(null);
  const [plotArea, setPlotArea] = useState<number | null>(null);

  // ── Land Record lookup state ──
  const [showLandPanel, setShowLandPanel] = useState(false);
  const [lrState, setLrState] = useState("karnataka");
  const [lrDistrict, setLrDistrict] = useState("");
  const [lrSurvey, setLrSurvey] = useState("");
  const [lrLoading, setLrLoading] = useState(false);
  const [lrResult, setLrResult] = useState<any>(null);
  const [lrError, setLrError] = useState("");

  const handleLocationSelect = useCallback(async (lat: number, lon: number) => {
    setSelectedLocation(lat, lon);
    setStage("locating");
    setStatusMsg("Detecting plot boundary…");
    setBuildability(null);
    setPlotBoundary(null);
    setPlotArea(null);
    setError(null);

    try {
      const data = await getPlotBoundary(lat, lon);
      const normalizedBoundary = normalizeBoundaryLonLat(data.boundary, { lat, lon });
      setPlotBoundary(normalizedBoundary);
      setBuildability({ ok: !!data.is_buildable, reason: data.reason ?? "" });
      if (normalizedBoundary && data.area_sqm) {
        const area = Math.round(data.area_sqm);
        setPlotArea(area);
        setSelectedPlotArea(area);
      } else {
        if (!normalizedBoundary) {
          setBuildability({ ok: false, reason: "Boundary source returned invalid coordinates. Please try land-record lookup or another point." });
        }
        setSelectedPlotArea(null);
      }
    } catch (e: unknown) {
      const msg = getRequestErrorMessage(e, "Boundary check unavailable — proceeding.");
      if (msg.includes("NEXT_PUBLIC_API_URL") || msg.includes(API_BASE_URL_CONFIG_ERROR)) {
        setError(msg);
        setBuildability({ ok: false, reason: msg });
      } else {
        setBuildability({ ok: true, reason: "Boundary check unavailable — proceeding." });
      }
      setSelectedPlotArea(null);
    }

    setStage("ready");
    setStatusMsg("");
  }, [setSelectedLocation, setSelectedPlotArea, setError]);

  const handleLandLookup = async () => {
    setLrLoading(true);
    setLrError("");
    setLrResult(null);
    try {
      const apiBaseUrl = ensureApiBaseUrlConfigured();
      const params = new URLSearchParams({
        state: lrState,
        district: lrDistrict,
        survey_number: lrSurvey,
        ...(selectedLat ? { lat: String(selectedLat) } : {}),
        ...(selectedLon ? { lon: String(selectedLon) } : {}),
      });
      const resp = await fetch(`${apiBaseUrl}/land-record/lookup?${params}`);
      const data = await resp.json();
      if (data.error) {
        setLrError(data.error);
      } else {
        setLrResult(data);
        // If we got a boundary back, use it as the plot boundary
        if (data.boundary && data.boundary.length >= 3) {
          const normalizedBoundary = normalizeBoundaryLonLat(
            data.boundary,
            selectedLat && selectedLon ? { lat: selectedLat, lon: selectedLon } : undefined,
          );
          if (!normalizedBoundary) {
            setLrError("Boundary payload is invalid for this lookup. Please try a nearby location.");
            return;
          }
          setPlotBoundary(normalizedBoundary);
          if (data.area_sqm) {
            setPlotArea(data.area_sqm);
            setSelectedPlotArea(data.area_sqm);
          }
          if (!selectedLat && normalizedBoundary[0]) {
            setSelectedLocation(normalizedBoundary[0][1], normalizedBoundary[0][0]);
          }
          setStage("ready");
          setBuildability({ ok: true, reason: "Boundary loaded from land records." });
        }
      }
    } catch (e) {
      setLrError(e instanceof Error ? e.message : "Could not reach backend. Make sure the server is running.");
    } finally {
      setLrLoading(false);
    }
  };

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
        plot_area_sqm: plotArea ?? 240,
        num_floors: 2,
        preserve_trees: true,
        layout_mode: "fit_boundary",
      });
      setFloorPlan(fp);
      setStage("done");
      await new Promise(r => setTimeout(r, 500));
      router.push(`/analysis/${currentPlotId}`);
    } catch (e: unknown) {
      const msg = getRequestErrorMessage(e, "Analysis failed — is backend running on the configured API URL?");
      setError(msg);
      setStage("ready");
    } finally {
      setAnalyzing(false);
    }
  };

  const isOverlayVisible = stage === "locating" || stage === "analyzing" || stage === "done";
  const PANEL_Z = 1200;
  const hasBhuNaksha = BHU_NAKSHA_STATES.has(lrState);

  return (
    <>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform: translateY(0); } }
        .lr-input { background: rgba(13,242,242,0.04); border: 1px solid rgba(13,242,242,0.12); border-radius: 8px; padding: 8px 12px; color: white; font-size: 12px; font-family: inherit; width: 100%; outline: none; }
        .lr-input:focus { border-color: rgba(13,242,242,0.35); }
        .lr-input option { background: #0a1a1a; }
        .lr-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; }
      `}</style>

      <div style={{ height: "100vh", width: "100vw", display: "flex", flexDirection: "column", overflow: "hidden", background: "#080e0e", fontFamily: "'Space Grotesk', sans-serif" }}>

        {/* Header */}
        <header style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(8,14,14,0.99)", position: "relative", zIndex: PANEL_Z + 100 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 24 }}>deployed_code</span>
            <span style={{ fontWeight: 700, color: "white", fontSize: 15, letterSpacing: "-0.01em" }}>
              ECO-3D <span style={{ color: "rgba(13,242,242,0.6)", fontWeight: 300 }}>Studio</span>
            </span>
          </Link>
          <div style={{ fontSize: 11, color: "#64748b", textAlign: "center" }}>
            Click anywhere on the map · or use the Land Record panel to locate by survey number
          </div>
          {/* Land Record toggle button */}
          <button
            onClick={() => setShowLandPanel(p => !p)}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 16px",
              borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: "pointer",
              background: showLandPanel ? "rgba(13,242,242,0.12)" : "rgba(13,242,242,0.04)",
              border: `1px solid ${showLandPanel ? "rgba(13,242,242,0.4)" : "rgba(13,242,242,0.12)"}`,
              color: showLandPanel ? "#0df2f2" : "#64748b",
              transition: "all 0.2s",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>domain</span>
            Land Records
          </button>
        </header>

        {/* Map container */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>

          <MapComponent
            onLocationSelect={handleLocationSelect}
            plotBoundary={plotBoundary}
            selectedLat={selectedLat}
            selectedLon={selectedLon}
          />

          {/* ── LAND RECORDS PANEL ── */}
          {showLandPanel && (
            <div style={{
              position: "absolute", top: 16, left: 16,
              width: 340, maxHeight: "calc(100vh - 120px)", overflowY: "auto",
              borderRadius: 16, padding: 20,
              background: "rgba(8,18,18,0.97)", backdropFilter: "blur(20px)",
              border: "1px solid rgba(13,242,242,0.18)",
              boxShadow: "0 8px 40px rgba(0,0,0,0.7)",
              zIndex: PANEL_Z + 50, animation: "fadeUp 0.25s ease",
              fontFamily: "'Space Grotesk', sans-serif",
            }}>
              {/* Panel header */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 20 }}>domain</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "white" }}>Indian Land Records</div>
                    <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em" }}>Bhu Naksha / Bhulekh Lookup</div>
                  </div>
                </div>
                <button onClick={() => setShowLandPanel(false)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", padding: 4 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>

              {/* Info note */}
              <div style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.15)", marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: "#fbbf24", lineHeight: 1.5 }}>
                  Enter your survey/khasra number and state to look up official plot boundaries. For states with Bhu Naksha, real cadastral boundaries are fetched. Others link to the official state portal.
                </div>
              </div>

              {/* State select */}
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", display: "block", marginBottom: 5 }}>State</label>
                <div style={{ position: "relative" }}>
                  <select
                    value={lrState}
                    onChange={e => setLrState(e.target.value)}
                    className="lr-input"
                  >
                    {INDIAN_STATES.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                {/* Bhu Naksha badge */}
                <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="lr-tag" style={{
                    background: hasBhuNaksha ? "rgba(13,242,242,0.1)" : "rgba(100,116,139,0.1)",
                    color: hasBhuNaksha ? "#0df2f2" : "#64748b",
                    border: `1px solid ${hasBhuNaksha ? "rgba(13,242,242,0.25)" : "rgba(100,116,139,0.25)"}`,
                  }}>
                    {hasBhuNaksha ? "Bhu Naksha" : "Bhulekh Portal"}
                  </span>
                  <span style={{ fontSize: 9, color: "#475569" }}>
                    {hasBhuNaksha ? "Cadastral boundary available" : "Portal link — manual lookup"}
                  </span>
                </div>
              </div>

              {/* District */}
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", display: "block", marginBottom: 5 }}>District (optional)</label>
                <input
                  type="text"
                  value={lrDistrict}
                  onChange={e => setLrDistrict(e.target.value)}
                  placeholder="e.g. Bengaluru Urban"
                  className="lr-input"
                />
              </div>

              {/* Survey / Khasra number */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.1em", display: "block", marginBottom: 5 }}>Survey / Khasra Number</label>
                <input
                  type="text"
                  value={lrSurvey}
                  onChange={e => setLrSurvey(e.target.value)}
                  placeholder="e.g. 45/A or 1234/2"
                  className="lr-input"
                />
              </div>

              {/* Tip: also click map */}
              {selectedLat && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, padding: "6px 10px", borderRadius: 8, background: "rgba(13,242,242,0.05)", border: "1px solid rgba(13,242,242,0.1)" }}>
                  <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 14 }}>location_on</span>
                  <span style={{ fontSize: 10, color: "rgba(13,242,242,0.7)" }}>
                    Using map pin: {selectedLat.toFixed(5)}°N, {selectedLon?.toFixed(5)}°E
                  </span>
                </div>
              )}

              {/* Lookup button */}
              <button
                onClick={handleLandLookup}
                disabled={lrLoading}
                style={{
                  width: "100%", padding: "11px 0", borderRadius: 10, fontSize: 12,
                  fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  background: lrLoading ? "rgba(13,242,242,0.2)" : "#0df2f2",
                  color: "#080e0e", border: "none", cursor: lrLoading ? "wait" : "pointer",
                  boxShadow: lrLoading ? "none" : "0 0 16px rgba(13,242,242,0.2)",
                  marginBottom: 14,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16, animation: lrLoading ? "spin 1s linear infinite" : "none" }}>
                  {lrLoading ? "sync" : "search"}
                </span>
                {lrLoading ? "Fetching Records…" : "Lookup Land Record"}
              </button>

              {/* Error */}
              {lrError && (
                <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: "#fca5a5" }}>{lrError}</div>
                </div>
              )}

              {/* Result */}
              {lrResult && (
                <div style={{ borderRadius: 10, border: "1px solid rgba(13,242,242,0.12)", overflow: "hidden" }}>
                  {/* Result header */}
                  <div style={{ padding: "10px 14px", background: "rgba(13,242,242,0.06)", borderBottom: "1px solid rgba(13,242,242,0.08)" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#0df2f2" }}>{lrResult.state}</div>
                    <div style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>{lrResult.source}</div>
                  </div>

                  {/* Data rows */}
                  {[
                    { k: "Survey / Khasra", v: lrResult.survey_number },
                    { k: "District", v: lrResult.district },
                    { k: "Owner (Listed)", v: lrResult.owner_name },
                    { k: "Land Type", v: lrResult.land_type },
                    { k: "Area", v: lrResult.area_sqm ? `${lrResult.area_sqm.toLocaleString()} m²` : "—" },
                    { k: "Boundary Pts", v: lrResult.boundary ? `${lrResult.boundary.length} coordinates` : "—" },
                  ].map(({ k, v }) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 14px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      <span style={{ fontSize: 10, color: "#64748b" }}>{k}</span>
                      <span style={{ fontSize: 10, color: "#e2e8f0", fontFamily: "monospace", maxWidth: 160, textAlign: "right", wordBreak: "break-all" }}>{v || "—"}</span>
                    </div>
                  ))}

                  {/* Note */}
                  {lrResult.note && (
                    <div style={{ padding: "8px 14px", background: "rgba(251,191,36,0.04)" }}>
                      <div style={{ fontSize: 9, color: "#a16207", lineHeight: 1.5 }}>{lrResult.note}</div>
                    </div>
                  )}

                  {/* Portal link */}
                  {lrResult.portal_url && (
                    <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 10, color: "#64748b" }}>{lrResult.portal_name}</span>
                      <a
                        href={lrResult.portal_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 10, color: "#0df2f2", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}
                      >
                        Open Portal
                        <span className="material-symbols-outlined" style={{ fontSize: 12 }}>open_in_new</span>
                      </a>
                    </div>
                  )}

                  {/* If we got a boundary, show Use This Plot button */}
                  {lrResult.boundary && lrResult.boundary.length >= 3 && (
                    <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(13,242,242,0.08)" }}>
                      <div style={{ fontSize: 9, color: "rgba(13,242,242,0.6)", marginBottom: 4 }}>Boundary loaded onto map. Ready to analyse.</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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

          {/* ── READY panel ── */}
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
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", color: "#0df2f2", fontWeight: 700, marginBottom: 2 }}>
                    {lrResult?.boundary ? "Plot from Land Records" : "Plot Selected"}
                  </div>
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
                  {buildability?.ok === false ? "Restricted" : "Buildable"}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "Plot Area", value: plotArea ? `${plotArea.toLocaleString()} m²` : "—" },
                  { label: "Boundary", value: lrResult?.boundary ? "Land Records" : plotBoundary ? `${plotBoundary.length} pts` : "Auto" },
                  { label: "Plot ID", value: currentPlotId?.slice(0, 14) ?? "—" },
                ].map(({ label, value }) => (
                  <div key={label} style={{ borderRadius: 10, padding: "8px 12px", background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)" }}>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.15em", color: "#475569", marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 700, color: "white" }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Land record badge */}
              {lrResult?.survey_number && lrResult.survey_number !== "—" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 8, background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.1)" }}>
                  <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 14 }}>gavel</span>
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>Survey No. <span style={{ color: "white", fontFamily: "monospace" }}>{lrResult.survey_number}</span> · {lrResult.state}</span>
                </div>
              )}

              {/* Warning */}
              {buildability?.ok === false && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8, borderRadius: 10, padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}>
                  <span className="material-symbols-outlined" style={{ color: "#f87171", fontSize: 16, marginTop: 1 }}>warning</span>
                  <span style={{ fontSize: 11, color: "#fca5a5", lineHeight: 1.5 }}>{buildability.reason}</span>
                </div>
              )}

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
