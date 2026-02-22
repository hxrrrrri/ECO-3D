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
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#080e0e" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <div style={{ width: 32, height: 32, border: "2px solid #0df2f2", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.9s linear infinite" }}/>
        <p style={{ fontSize: 10, color: "rgba(13,242,242,0.5)", textTransform: "uppercase", letterSpacing: "0.2em", fontFamily: "monospace" }}>Loading Map...</p>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  ),
});

const ANALYSIS_STEPS = [
  "Querying OpenTopoData SRTM30m elevation...",
  "Fetching SoilGrids 2.0 soil properties...",
  "Verifying legal land status (OSM + WDPA + FEMA)...",
  "Classifying seismic hazard zone (USGS ASCE 7-22)...",
  "Computing NDVI vegetation proxy (Open-Meteo ET₀)...",
  "Retrieving Open-Meteo wind & rainfall normals...",
  "Running GloFAS flood discharge model...",
  "Computing AHP-WLC buildability score (Saaty 1980)...",
  "Generating wind/solar optimised floor plan (IRC 2021)...",
];

export default function MapPage() {
  const router = useRouter();
  const {
    selectedLat, selectedLon, currentPlotId, analysis, isAnalyzing, error,
    setSelectedLocation, setAnalysis, setFloorPlan, setAnalyzing, setError,
  } = useEco3DStore();

  const [stage,         setStage]         = useState<"idle"|"locating"|"analyzing"|"done">("idle");
  const [stepIdx,       setStepIdx]       = useState(0);
  const [plotBoundary,  setPlotBoundary]  = useState<number[][]|null>(null);
  const [buildability,  setBuildability]  = useState<{ok:boolean; reason:string}|null>(null);
  const [legalData,     setLegalData]     = useState<any>(null);
  const [drawnPolygon,  setDrawnPolygon]  = useState<number[][]|null>(null);
  const analysisTriggered = useRef(false);

  const handleLocationSelect = useCallback(async (lat: number, lon: number, polygon?: number[][]) => {
    analysisTriggered.current = false;
    setSelectedLocation(lat, lon);
    setDrawnPolygon(polygon || null);
    setStage("locating");
    setBuildability(null);

    try {
      const resp = await fetch(`http://localhost:8000/plot-boundary?lat=${lat}&lon=${lon}`);
      if (resp.ok) {
        const data = await resp.json();
        setPlotBoundary(polygon || data.boundary);
        if (data.legal_verification) setLegalData(data.legal_verification);
        if (!data.is_buildable) {
          setBuildability({ ok: false, reason: data.reason });
          setStage("idle");
          return;
        }
        setBuildability({ ok: true, reason: data.reason });
      }
    } catch { /* silent */ }
    setStage("idle");
  }, [setSelectedLocation]);

  useEffect(() => {
    if (!selectedLat || !selectedLon || !currentPlotId) return;
    if (analysisTriggered.current) return;
    if (buildability && !buildability.ok) return;
    analysisTriggered.current = true;
    runAnalysis();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLat, selectedLon, currentPlotId, buildability]);

  const runAnalysis = async () => {
    if (!selectedLat || !selectedLon || !currentPlotId) return;
    setAnalyzing(true);
    setStage("analyzing");
    setError(null);
    setStepIdx(0);

    // Animate through steps
    let cancelled = false;
    for (let i = 0; i < ANALYSIS_STEPS.length - 1; i++) {
      if (cancelled) break;
      setStepIdx(i);
      await new Promise(r => setTimeout(r, 700));
    }

    try {
      const result = await analyzePlot({
        plot_id: currentPlotId,
        lat: selectedLat,
        lon: selectedLon,
        polygon: drawnPolygon || plotBoundary || undefined,
      });
      setAnalysis(result);
      setStepIdx(ANALYSIS_STEPS.length - 1);

      const fp = await generateFloorPlan({
        plot_id: currentPlotId,
        plot_area_sqm: 220,
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
      setStage("idle");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
      <style>{`body{background:#080e0e;margin:0}*{box-sizing:border-box}.gl{background:rgba(8,20,20,0.85);backdrop-filter:blur(12px);border:1px solid rgba(13,242,242,0.1)}`}</style>

      <div style={{ height:"100vh", width:"100vw", display:"flex", flexDirection:"column", overflow:"hidden", background:"#080e0e", fontFamily:"'Space Grotesk',sans-serif" }}>

        <header style={{ flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 20px", zIndex:50, borderBottom:"1px solid rgba(255,255,255,0.05)", background:"rgba(8,14,14,0.98)" }}>
          <Link href="/" style={{ display:"flex", alignItems:"center", gap:8, textDecoration:"none" }}>
            <span style={{ fontSize:22, color:"#0df2f2" }}>◈</span>
            <span style={{ color:"#fff", fontWeight:700 }}>ECO-3D <span style={{ color:"rgba(13,242,242,0.5)", fontWeight:300 }}>Studio</span></span>
          </Link>
          <div style={{ fontSize:11, color:"#475569", textAlign:"center" }}>
            Click on the map · or draw a boundary · or search for any place on Earth
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 10px", background:"rgba(13,242,242,0.06)", border:"1px solid rgba(13,242,242,0.15)", borderRadius:20 }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:"#22c55e", animation:"pulse 2s infinite", display:"inline-block" }}/>
            <span style={{ fontSize:10, color:"#22c55e", fontFamily:"monospace", textTransform:"uppercase", letterSpacing:"0.12em" }}>
              {isAnalyzing ? "Analyzing…" : "Ready"}
            </span>
          </div>
        </header>

        <div style={{ flex:1, position:"relative", overflow:"hidden", minHeight:0 }}>
          <MapComponent onLocationSelect={handleLocationSelect} plotBoundary={plotBoundary} selectedLat={selectedLat} selectedLon={selectedLon}/>

          {/* Non-buildable warning */}
          {buildability && !buildability.ok && (
            <div className="gl" style={{ position:"absolute", top:16, left:"50%", transform:"translateX(-50%)", padding:"10px 18px", borderRadius:12, display:"flex", alignItems:"center", gap:12, zIndex:50 }}>
              <span style={{ fontSize:20 }}>⚠</span>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:"#f87171" }}>Not Suitable for Construction</div>
                <div style={{ fontSize:11, color:"#64748b", marginTop:2 }}>{buildability.reason}</div>
              </div>
            </div>
          )}

          {/* Legal verification quick-info badge (bottom-right of map) */}
          {legalData && buildability?.ok && (
            <div className="gl" style={{ position:"absolute", bottom:90, right:16, padding:"10px 14px", borderRadius:10, zIndex:50, minWidth:200 }}>
              <div style={{ fontSize:9, textTransform:"uppercase", letterSpacing:"0.15em", color:"#0df2f2", marginBottom:6 }}>Legal Status</div>
              <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                <span>{legalData.is_legally_buildable ? "✅" : "🚫"}</span>
                <span style={{ fontSize:11, fontWeight:700, color:legalData.is_legally_buildable ? "#22c55e" : "#ef4444" }}>
                  {legalData.is_legally_buildable ? "Buildable" : "Restricted"}
                </span>
                <span style={{ marginLeft:"auto", fontSize:14, fontWeight:900, color:legalData.legal_score > 70 ? "#22c55e" : "#f59e0b" }}>
                  {Math.round(legalData.legal_score)}
                </span>
              </div>
              {legalData.flood_zone && (
                <div style={{ fontSize:10, color:"#64748b" }}>Flood: <span style={{ color:"#e2e8f0" }}>{legalData.flood_zone}</span></div>
              )}
              {legalData.seismic_zone && (
                <div style={{ fontSize:10, color:"#64748b" }}>Seismic: <span style={{ color:"#e2e8f0" }}>{legalData.seismic_zone}</span></div>
              )}
              {legalData.warnings?.length > 0 && (
                <div style={{ fontSize:9, color:"#f59e0b", marginTop:4 }}>⚠ {legalData.warnings.length} warning{legalData.warnings.length > 1 ? "s" : ""}</div>
              )}
            </div>
          )}

          {/* Analysis overlay */}
          {(stage === "analyzing" || stage === "locating") && (
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", zIndex:40, background:"rgba(6,14,14,0.82)" }}>
              <div className="gl" style={{ borderRadius:20, padding:"36px 40px", display:"flex", flexDirection:"column", alignItems:"center", gap:18, minWidth:340 }}>
                <div style={{ position:"relative", width:64, height:64 }}>
                  <div style={{ position:"absolute", inset:0, border:"2px solid rgba(13,242,242,0.12)", borderRadius:"50%" }}/>
                  <div style={{ position:"absolute", inset:0, border:"2px solid #0df2f2", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
                  <span style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>🛰</span>
                </div>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontSize:14, fontWeight:700, color:"#fff", marginBottom:4 }}>Analysing Plot</div>
                  <div style={{ fontSize:11, color:"rgba(13,242,242,0.7)", fontFamily:"monospace", maxWidth:260, textAlign:"center" }}>
                    {ANALYSIS_STEPS[Math.min(stepIdx, ANALYSIS_STEPS.length-1)]}
                  </div>
                </div>
                <div style={{ width:"100%", background:"rgba(255,255,255,0.05)", borderRadius:4, height:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", background:"#0df2f2", borderRadius:4, transition:"width 0.7s ease", width:`${Math.round((stepIdx / (ANALYSIS_STEPS.length-1)) * 100)}%` }}/>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, width:"100%" }}>
                  {["SoilGrids 2.0", "OpenTopoData", "Open-Meteo", "OSM Overpass"].map(src => (
                    <div key={src} style={{ fontSize:9, color:"#334155", textAlign:"center", padding:"4px 8px", background:"rgba(255,255,255,0.03)", borderRadius:6, fontFamily:"monospace" }}>{src}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Coords HUD */}
          {selectedLat && stage === "idle" && !isAnalyzing && (
            <div className="gl" style={{ position:"absolute", bottom:24, left:"50%", transform:"translateX(-50%)", padding:"10px 20px", borderRadius:12, display:"flex", alignItems:"center", gap:14, zIndex:40 }}>
              <span style={{ fontSize:16 }}>📍</span>
              <span style={{ fontSize:12, fontFamily:"monospace", color:"#e2e8f0" }}>
                {selectedLat.toFixed(5)}°,&nbsp;{selectedLon?.toFixed(5)}°
              </span>
              {error && <span style={{ fontSize:11, color:"#f87171", maxWidth:280 }}>{error}</span>}
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </>
  );
}
