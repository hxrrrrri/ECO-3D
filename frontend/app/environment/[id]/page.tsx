"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useEco3DStore } from "@/store/useEco3DStore";

function MetricCard({
  icon, label, value, unit, sub, color = "#0df2f2",
}: {
  icon: string; label: string; value: string | number | null; unit?: string;
  sub?: string; color?: string;
}) {
  return (
    <div style={{
      background: "rgba(10,26,26,0.6)", border: "1px solid rgba(13,242,242,0.1)",
      borderRadius: 14, padding: "20px 22px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span className="material-symbols-outlined" style={{ color, fontSize: 20 }}>{icon}</span>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", color: "rgba(148,163,184,0.7)" }}>
          {label}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 28, fontWeight: 800, color: "white", fontFamily: "monospace" }}>
          {value ?? "—"}
        </span>
        {unit && <span style={{ fontSize: 13, color: "rgba(148,163,184,0.6)" }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 11, color: "rgba(148,163,184,0.5)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function SegBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 12, color: "#94a3b8", textTransform: "capitalize" }}>{label}</span>
        <span style={{ fontSize: 12, fontFamily: "monospace", color: "white", fontWeight: 700 }}>
          {(value * 100).toFixed(1)}%
        </span>
      </div>
      <div style={{ height: 6, background: "rgba(255,255,255,0.05)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${value * 100}%`, background: color,
          boxShadow: `0 0 8px ${color}88`, borderRadius: 3, transition: "width 1.2s ease",
        }} />
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid rgba(13,242,242,0.08)" }}>
        <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 20 }}>{icon}</span>
        <h2 style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.18em", color: "#0df2f2", margin: 0 }}>
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

export default function EnvironmentPage() {
  const params = useParams();
  const plotId = params.id as string;
  const { analysis, selectedLat, selectedLon } = useEco3DStore();

  const env = analysis?.environmental;
  const seg = analysis?.segmentation;

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />

      <div style={{ minHeight: "100vh", background: "#080e0e", fontFamily: "'Space Grotesk', sans-serif" }}>

        {/* Header */}
        <header style={{
          position: "sticky", top: 0, zIndex: 50,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.05)",
          background: "rgba(8,14,14,0.98)", backdropFilter: "blur(12px)",
        }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 22 }}>deployed_code</span>
            <div>
              <span style={{ color: "white", fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em" }}>ECO-3D</span>
              <span style={{ color: "rgba(13,242,242,0.6)", fontWeight: 300, fontSize: 13, marginLeft: 6 }}>Studio</span>
            </div>
          </Link>

          <nav style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {[
              { l: "Project Alpha", h: "/map" },
              { l: "Blueprint Generator", h: `/analysis/${plotId}` },
              { l: "Environmental Data", h: `/environment/${plotId}`, a: true },
              { l: "Export", h: `/report/${plotId}` },
            ].map(item => (
              <Link key={item.l} href={item.h} style={{
                padding: "8px 14px", fontSize: 12, fontWeight: 500, textDecoration: "none",
                color: (item as any).a ? "#0df2f2" : "#94a3b8",
                borderBottom: (item as any).a ? "2px solid #0df2f2" : "2px solid transparent",
                transition: "color 0.2s",
              }}>{item.l}</Link>
            ))}
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Link href={`/model3d/${plotId}`} style={{
              padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none",
              background: "#0df2f2", color: "#080e0e",
            }}>
              View 3D Model
            </Link>
          </div>
        </header>

        {/* Content */}
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 24px" }}>

          {/* Page title */}
          <div style={{ marginBottom: 36 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 28 }}>eco</span>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: "white", margin: 0 }}>Environmental Analysis</h1>
            </div>
            <div style={{ fontSize: 13, color: "#64748b" }}>
              Plot ID: <span style={{ color: "#0df2f2", fontFamily: "monospace" }}>{plotId}</span>
              {selectedLat && selectedLon && (
                <span style={{ marginLeft: 16 }}>
                  {selectedLat.toFixed(5)}°N &nbsp;·&nbsp; {selectedLon.toFixed(5)}°E
                </span>
              )}
            </div>
          </div>

          {/* No data state */}
          {!analysis && (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
              padding: "80px 40px", borderRadius: 20, textAlign: "center",
              border: "1px solid rgba(13,242,242,0.08)", background: "rgba(10,26,26,0.55)",
            }}>
              <span className="material-symbols-outlined" style={{ fontSize: 56, color: "rgba(13,242,242,0.3)" }}>nature</span>
              <p style={{ color: "#94a3b8", fontSize: 14, margin: 0 }}>
                No environmental data available.<br />Please run a plot analysis first.
              </p>
              <Link href="/map" style={{
                marginTop: 8, padding: "10px 24px", borderRadius: 12, fontSize: 12,
                fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
                textDecoration: "none", background: "#0df2f2", color: "#080e0e",
              }}>
                Go to Map →
              </Link>
            </div>
          )}

          {analysis && env && (
            <>
              {/* Score summary bar */}
              <div style={{
                display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16,
                padding: "20px 24px", borderRadius: 16, marginBottom: 36,
                background: "rgba(10,26,26,0.7)", border: "1px solid rgba(13,242,242,0.12)",
              }}>
                {[
                  { label: "Buildability Score", value: `${Math.round(analysis.buildability_score)}%`, color: analysis.buildability_score >= 70 ? "#2ecc71" : analysis.buildability_score >= 40 ? "#f1c40f" : "#e74c3c" },
                  { label: "Flood Risk", value: `${Math.round(analysis.flood_probability * 100)}%`, color: analysis.flood_probability < 0.2 ? "#2ecc71" : analysis.flood_probability < 0.5 ? "#f1c40f" : "#e74c3c" },
                  { label: "Site Status", value: analysis.status, color: analysis.status === "EXCELLENT" ? "#0df2f2" : analysis.status === "GOOD" ? "#2ecc71" : "#f1c40f" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: "monospace" }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Atmospheric conditions */}
              <Section title="Atmospheric & Terrain Conditions" icon="thermostat">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
                  <MetricCard icon="terrain" label="Elevation" value={env.elevation.toFixed(1)} unit="m" color="#0df2f2" />
                  <MetricCard icon="slope" label="Slope" value={env.slope.toFixed(1)} unit="°" sub={env.slope < 5 ? "Flat — ideal for building" : env.slope < 15 ? "Gentle slope" : "Steep — extra engineering needed"} color="#f59e0b" />
                  <MetricCard icon="water_drop" label="Annual Rainfall" value={env.rainfall_mm.toFixed(0)} unit="mm/yr" sub={env.rainfall_mm > 1200 ? "High — drainage planning critical" : env.rainfall_mm > 600 ? "Moderate" : "Low — drought-resistant design"} color="#3b82f6" />
                  <MetricCard icon="wb_sunny" label="Sun Exposure" value={env.sun_exposure_hours.toFixed(1)} unit="hrs/day" sub={env.sun_exposure_hours > 7 ? "Excellent solar potential" : "Moderate solar access"} color="#f59e0b" />
                  <MetricCard icon="air" label="Wind Direction" value={env.wind_direction} sub="Prevailing wind for ventilation design" color="#2ecc71" />
                  <MetricCard icon="foundation" label="Soil Type" value={env.soil_type} sub="Foundation engineering reference" color="#e67e22" />
                </div>
              </Section>

              {/* Vegetation */}
              <Section title="Vegetation & Land Cover" icon="park">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                  <div>
                    <MetricCard
                      icon="grass" label="NDVI — Vegetation Index"
                      value={env.ndvi.toFixed(3)} unit=""
                      sub={env.ndvi > 0.5 ? "Dense vegetation — high biodiversity" : env.ndvi > 0.3 ? "Moderate vegetation" : "Sparse vegetation / bare land"}
                      color="#2ecc71"
                    />
                    <div style={{ marginTop: 16, padding: 16, background: "rgba(46,204,113,0.05)", border: "1px solid rgba(46,204,113,0.1)", borderRadius: 12 }}>
                      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>NDVI Scale Reference</div>
                      {[["< 0.1", "Bare soil / urban", "#94a3b8"], ["0.1–0.3", "Grassland / scrub", "#f59e0b"], ["0.3–0.5", "Moderate vegetation", "#84cc16"], ["> 0.5", "Dense forest / crops", "#2ecc71"]].map(([range, label, color]) => (
                        <div key={range} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <span style={{ fontSize: 11, fontFamily: "monospace", color: color as string }}>{range}</span>
                          <span style={{ fontSize: 11, color: "#64748b" }}>{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {seg && (
                    <div style={{ padding: 20, background: "rgba(10,26,26,0.6)", border: "1px solid rgba(13,242,242,0.1)", borderRadius: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", color: "rgba(13,242,242,0.6)", marginBottom: 16 }}>
                        Land Classification (AI Segmentation)
                      </div>
                      <SegBar label="Vegetation" value={seg.vegetation} color="#2ecc71" />
                      <SegBar label="Urban" value={seg.urban} color="#3b82f6" />
                      <SegBar label="Bare Soil" value={seg.bare_soil} color="#f59e0b" />
                      <SegBar label="Water" value={seg.water} color="#0ea5e9" />
                      <SegBar label="Road" value={seg.road} color="#64748b" />
                    </div>
                  )}
                </div>
              </Section>

              {/* Tree detection */}
              {analysis.tree_coordinates && analysis.tree_coordinates.length > 0 && (
                <Section title="Detected Trees" icon="forest">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
                    {analysis.tree_coordinates.slice(0, 8).map((tree, i) => (
                      <div key={i} style={{ padding: "12px 16px", background: "rgba(46,204,113,0.06)", border: "1px solid rgba(46,204,113,0.12)", borderRadius: 10, display: "flex", alignItems: "center", gap: 12 }}>
                        <span className="material-symbols-outlined" style={{ color: "#2ecc71", fontSize: 20 }}>park</span>
                        <div>
                          <div style={{ fontSize: 11, color: "#2ecc71", fontWeight: 700 }}>Tree T{String(i + 1).padStart(2, "0")}</div>
                          <div style={{ fontSize: 10, fontFamily: "monospace", color: "#94a3b8" }}>
                            {tree.lat.toFixed(4)}°, {tree.lon.toFixed(4)}°
                          </div>
                          <div style={{ fontSize: 10, color: "#64748b" }}>
                            Confidence: <span style={{ color: "#2ecc71" }}>{(tree.confidence * 100).toFixed(0)}%</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {analysis.tree_coordinates.length > 8 && (
                    <div style={{ marginTop: 10, fontSize: 11, color: "#64748b", textAlign: "center" }}>
                      + {analysis.tree_coordinates.length - 8} more trees detected
                    </div>
                  )}
                </Section>
              )}

              {/* Methodology */}
              {analysis.score_references && analysis.score_references.length > 0 && (
                <Section title="Methodology & Standards" icon="menu_book">
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {analysis.score_references.map((ref, i) => (
                      <div key={i} style={{ display: "flex", gap: 12, padding: "12px 16px", background: "rgba(10,26,26,0.5)", border: "1px solid rgba(13,242,242,0.07)", borderRadius: 10, borderLeft: "3px solid rgba(13,242,242,0.4)" }}>
                        <span className="material-symbols-outlined" style={{ color: "rgba(13,242,242,0.5)", fontSize: 16, flexShrink: 0, marginTop: 1 }}>bookmark</span>
                        <span style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>{ref}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Action buttons */}
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <Link href={`/analysis/${plotId}`} style={{ padding: "10px 20px", borderRadius: 10, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none", background: "rgba(13,242,242,0.08)", color: "#0df2f2", border: "1px solid rgba(13,242,242,0.2)" }}>
                  ← Blueprint Generator
                </Link>
                <Link href={`/floorplan/${plotId}`} style={{ padding: "10px 20px", borderRadius: 10, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none", background: "rgba(13,242,242,0.08)", color: "#0df2f2", border: "1px solid rgba(13,242,242,0.2)" }}>
                  Floor Plan →
                </Link>
                <Link href={`/report/${plotId}`} style={{ padding: "10px 20px", borderRadius: 10, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", textDecoration: "none", background: "#0df2f2", color: "#080e0e" }}>
                  Export Report →
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
