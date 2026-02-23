"use client";
import { useState, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";

type ExportFormat = "json" | "csv" | "txt" | "bim";

function ExportCard({
  icon, title, desc, format, onExport, disabled,
}: {
  icon: string; title: string; desc: string; format: ExportFormat;
  onExport: (f: ExportFormat) => void; disabled?: boolean;
}) {
  const [done, setDone] = useState(false);
  const handle = () => {
    if (disabled) return;
    onExport(format);
    setDone(true);
    setTimeout(() => setDone(false), 2200);
  };
  return (
    <div style={{
      background: "rgba(13,242,242,0.03)", border: "1px solid rgba(13,242,242,0.1)",
      borderRadius: 12, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 22 }}>{icon}</span>
        <div>
          <div style={{ color: "white", fontWeight: 700, fontSize: 13 }}>{title}</div>
          <div style={{ color: "#64748b", fontSize: 11, marginTop: 2 }}>{desc}</div>
        </div>
      </div>
      <button
        onClick={handle}
        disabled={!!disabled}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "9px 16px", borderRadius: 8, fontSize: 11, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.1em", cursor: disabled ? "not-allowed" : "pointer",
          background: done ? "rgba(34,197,94,0.15)" : disabled ? "rgba(255,255,255,0.03)" : "rgba(13,242,242,0.1)",
          border: `1px solid ${done ? "rgba(34,197,94,0.4)" : disabled ? "rgba(255,255,255,0.06)" : "rgba(13,242,242,0.25)"}`,
          color: done ? "#22c55e" : disabled ? "#334155" : "#0df2f2",
          transition: "all 0.2s", fontFamily: "'Space Grotesk',sans-serif",
        }}>
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
          {done ? "check_circle" : disabled ? "lock" : "download"}
        </span>
        {done ? "Downloaded" : disabled ? "No data" : `Export .${format.toUpperCase()}`}
      </button>
    </div>
  );
}

function DataRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <span style={{ fontSize: 11, color: "#64748b" }}>{label}</span>
      <span style={{ fontSize: 11, fontFamily: "monospace", color: highlight ? "#0df2f2" : "#cbd5e1", fontWeight: highlight ? 700 : 400 }}>{value}</span>
    </div>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div style={{ fontSize: 9, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.18em", fontWeight: 700, marginTop: 16, marginBottom: 6 }}>{title}</div>
  );
}

export default function ExportPage() {
  const params = useParams();
  const plotId = params.id as string;
  const { analysis, floorPlan } = useEco3DStore();
  const [exportLog, setExportLog] = useState<string[]>([]);

  const log = (msg: string) => setExportLog(p => [`${new Date().toLocaleTimeString()} — ${msg}`, ...p].slice(0, 8));

  const handleExport = (format: ExportFormat) => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ECO3D_${plotId}_${ts}`;

    if (format === "json" || format === "bim") {
      const payload = {
        meta: {
          version: "1.0", platform: "ECO-3D",
          exported: new Date().toISOString(), plot_id: plotId,
        },
        analysis: analysis ? {
          buildability_score: analysis.buildability_score,
          flood_probability: analysis.flood_probability,
          status: analysis.status,
          environmental: analysis.environmental,
          segmentation: analysis.segmentation,
          tree_count: analysis.tree_coordinates?.length ?? 0,
        } : null,
        floor_plan: floorPlan ? {
          total_area_m2: floorPlan.total_area,
          fitness_score: floorPlan.fitness_score,
          sunlight_score: floorPlan.sunlight_score,
          ventilation_score: floorPlan.ventilation_score,
          tree_preserved_count: floorPlan.tree_preserved_count,
          generation_count: floorPlan.generation_count,
          rooms: floorPlan.layout.map(r => ({
            type: r.type, floor: r.floor, orientation: r.orientation,
            width_m: r.width, depth_m: r.height,
            area_m2: parseFloat((r.width * r.height).toFixed(2)),
            position: { x: r.x, y: r.y },
          })),
        } : null,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `${filename}.${format === "bim" ? "bim.json" : "json"}`;
      a.click(); URL.revokeObjectURL(url);
      log(`Exported ${format.toUpperCase()} — ${filename}`);
    }

    if (format === "csv") {
      if (!floorPlan) return;
      const header = "Room Type,Floor,Width (m),Depth (m),Area (m²),Orientation,X,Y\n";
      const rows = floorPlan.layout.map(r =>
        `${r.type},${r.floor},${r.width},${r.height},${(r.width * r.height).toFixed(2)},${r.orientation},${r.x},${r.y}`
      ).join("\n");
      const blob = new Blob([header + rows], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${filename}.csv`;
      a.click(); URL.revokeObjectURL(url);
      log(`Exported CSV — ${floorPlan.layout.length} rooms`);
    }

    if (format === "txt") {
      const lines: string[] = [
        "═══════════════════════════════════════════════════",
        `  ECO-3D SITE ANALYSIS REPORT`,
        `  Plot ID : ${plotId}`,
        `  Date    : ${new Date().toLocaleString()}`,
        "═══════════════════════════════════════════════════",
        "",
      ];
      if (analysis) {
        lines.push("SITE SCORES");
        lines.push(`  Buildability Score : ${analysis.buildability_score.toFixed(0)} / 100`);
        lines.push(`  Flood Risk         : ${(analysis.flood_probability * 100).toFixed(0)}%`);
        lines.push(`  Status             : ${analysis.status}`);
        lines.push("");
        lines.push("ENVIRONMENTAL DATA");
        lines.push(`  Elevation          : ${analysis.environmental.elevation.toFixed(0)} m`);
        lines.push(`  Slope              : ${analysis.environmental.slope?.toFixed(1) ?? "—"}°`);
        lines.push(`  Rainfall           : ${analysis.environmental.rainfall_mm.toFixed(0)} mm/yr`);
        lines.push(`  Wind               : ${analysis.environmental.wind_ms?.toFixed(1) ?? "—"} m/s ${analysis.environmental.wind_direction}`);
        lines.push(`  Sun Hours          : ${analysis.environmental.sun_exposure_hours.toFixed(1)} h/day`);
        lines.push(`  NDVI               : ${analysis.environmental.ndvi.toFixed(3)}`);
        lines.push(`  Soil Type          : ${analysis.environmental.soil_type}`);
        if (analysis.environmental.clay_pct != null) lines.push(`  Clay               : ${(analysis.environmental.clay_pct as number).toFixed(1)}%`);
        if (analysis.environmental.sand_pct != null) lines.push(`  Sand               : ${(analysis.environmental.sand_pct as number).toFixed(1)}%`);
        if (analysis.environmental.soil_ph != null) lines.push(`  Soil pH            : ${(analysis.environmental.soil_ph as number).toFixed(1)}`);
        if (analysis.environmental.bulk_density != null) lines.push(`  Bulk Density       : ${(analysis.environmental.bulk_density as number).toFixed(2)} g/cm³`);
        lines.push(`  Soil Buildable     : ${analysis.environmental.soil_buildable === false ? "No" : "Yes"}`);
        lines.push("");
      }
      if (floorPlan) {
        lines.push("FLOOR PLAN SUMMARY");
        lines.push(`  Total Area         : ${floorPlan.total_area.toFixed(0)} m²`);
        lines.push(`  Fitness Score      : ${(floorPlan.fitness_score * 100).toFixed(0)}%`);
        lines.push(`  Sunlight Score     : ${(floorPlan.sunlight_score * 100).toFixed(0)}%`);
        lines.push(`  Ventilation Score  : ${(floorPlan.ventilation_score * 100).toFixed(0)}%`);
        lines.push(`  Trees Preserved    : ${floorPlan.tree_preserved_count}`);
        lines.push(`  Rooms              : ${floorPlan.layout.length}`);
        lines.push("");
        lines.push("ROOM SCHEDULE");
        floorPlan.layout.forEach((r, i) => {
          lines.push(`  ${String(i + 1).padStart(2, "0")}. ${r.type.padEnd(14)} Floor ${r.floor}  ${r.width}m × ${r.height}m = ${(r.width * r.height).toFixed(1)}m²  [${r.orientation}]`);
        });
        lines.push("");
      }
      lines.push("═══════════════════════════════════════════════════");
      lines.push("  Generated by ECO-3D Spatial Intelligence Platform");
      lines.push("═══════════════════════════════════════════════════");
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${filename}.txt`;
      a.click(); URL.revokeObjectURL(url);
      log(`Exported TXT report — ${lines.length} lines`);
    }
  };

  const hasAnalysis = !!analysis;
  const hasPlan = !!floorPlan;

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />

      <div style={{ minHeight: "100vh", background: "#080e0e", fontFamily: "'Space Grotesk',sans-serif", color: "white" }}>

        {/* Header */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", background: "rgba(8,14,14,0.98)", borderBottom: "1px solid rgba(13,242,242,0.08)", position: "sticky", top: 0, zIndex: 50 }}>
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 22 }}>deployed_code</span>
            <div>
              <div style={{ color: "white", fontWeight: 700, fontSize: 15 }}>ECO-3D <span style={{ color: "rgba(13,242,242,0.5)", fontWeight: 300 }}>Studio</span></div>
              <div style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em" }}>AI GENERATIVE ARCHITECTURE</div>
            </div>
          </Link>
          <nav style={{ display: "flex", gap: 4 }}>
            {[
              { l: "Blueprint Generator", h: `/analysis/${plotId}` },
              { l: "Environmental Data",  h: `/environment/${plotId}` },
              { l: "3D Model",            h: `/model3d/${plotId}` },
              { l: "Export",              h: `/report/${plotId}`, a: true },
            ].map(item => (
              <Link key={item.l} href={item.h} style={{
                padding: "8px 14px", fontSize: 12, fontWeight: 500, textDecoration: "none",
                color: (item as any).a ? "#0df2f2" : "#64748b",
                borderBottom: (item as any).a ? "2px solid #0df2f2" : "2px solid transparent",
              }}>{item.l}</Link>
            ))}
          </nav>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#475569" }}>{plotId}</span>
        </header>

        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 24px", display: "grid", gridTemplateColumns: "1fr 320px", gap: 32 }}>

          {/* Left — export options + preview */}
          <div>
            <div style={{ marginBottom: 28 }}>
              <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>Export Report</h1>
              <p style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>
                Download your full site analysis and floor plan in multiple formats.
              </p>
            </div>

            {/* Export cards */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 28 }}>
              <ExportCard
                icon="data_object" title="Full Report (JSON)"
                desc="All analysis data, environmental readings, floor plan, and scores in structured JSON."
                format="json" onExport={handleExport} disabled={!hasAnalysis && !hasPlan}
              />
              <ExportCard
                icon="table_chart" title="Room Schedule (CSV)"
                desc="Spreadsheet-ready room schedule with dimensions, area, floor, and orientation."
                format="csv" onExport={handleExport} disabled={!hasPlan}
              />
              <ExportCard
                icon="description" title="Site Report (TXT)"
                desc="Human-readable plain text report with all site scores, environmental data, and room schedule."
                format="txt" onExport={handleExport} disabled={!hasAnalysis && !hasPlan}
              />
              <ExportCard
                icon="view_in_ar" title="BIM Export (JSON)"
                desc="Building Information Model JSON with room geometry, eco-scores, and metadata for BIM tools."
                format="bim" onExport={handleExport} disabled={!hasPlan}
              />
            </div>

            {/* Export activity log */}
            {exportLog.length > 0 && (
              <div style={{ background: "rgba(13,242,242,0.02)", border: "1px solid rgba(13,242,242,0.08)", borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ fontSize: 9, color: "rgba(13,242,242,0.4)", textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 8 }}>Export Activity</div>
                {exportLog.map((entry, i) => (
                  <div key={i} style={{ fontSize: 11, color: i === 0 ? "#0df2f2" : "#475569", fontFamily: "monospace", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                    {entry}
                  </div>
                ))}
              </div>
            )}

            {/* No data notice */}
            {!hasAnalysis && !hasPlan && (
              <div style={{ background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 10, padding: "16px 20px", display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
                <span className="material-symbols-outlined" style={{ color: "#f59e0b", fontSize: 22 }}>info</span>
                <div>
                  <div style={{ color: "#fbbf24", fontWeight: 700, fontSize: 13 }}>No analysis data found</div>
                  <div style={{ color: "#64748b", fontSize: 12, marginTop: 3 }}>Run a site analysis first to generate data for export.</div>
                  <Link href="/map" style={{ color: "#0df2f2", fontSize: 12, marginTop: 6, display: "inline-block" }}>Go to Map →</Link>
                </div>
              </div>
            )}
          </div>

          {/* Right — data summary */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "rgba(13,242,242,0.03)", border: "1px solid rgba(13,242,242,0.1)", borderRadius: 12, padding: "18px 20px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "white", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Data Summary
              </div>

              {hasAnalysis && analysis ? (
                <>
                  <Section title="Site Scores" />
                  <DataRow label="Buildability" value={`${analysis.buildability_score.toFixed(0)} / 100`} highlight />
                  <DataRow label="Flood Risk" value={`${(analysis.flood_probability * 100).toFixed(0)}%`} />
                  <DataRow label="Status" value={analysis.status} highlight />

                  <Section title="Environmental" />
                  <DataRow label="Elevation" value={`${analysis.environmental.elevation.toFixed(0)} m`} />
                  <DataRow label="Slope" value={`${analysis.environmental.slope?.toFixed(1) ?? "—"}°`} />
                  <DataRow label="Rainfall" value={`${analysis.environmental.rainfall_mm.toFixed(0)} mm/yr`} />
                  <DataRow label="Wind" value={`${analysis.environmental.wind_ms?.toFixed(1) ?? "—"} m/s ${analysis.environmental.wind_direction}`} />
                  <DataRow label="Sun Hours" value={`${analysis.environmental.sun_exposure_hours.toFixed(1)} h/day`} />
                  <DataRow label="NDVI" value={analysis.environmental.ndvi.toFixed(3)} />

                  <Section title="Soil (SoilGrids v2)" />
                  <DataRow label="Type" value={analysis.environmental.soil_type} />
                  <DataRow label="pH" value={analysis.environmental.soil_ph != null ? `${(analysis.environmental.soil_ph as number).toFixed(1)}` : "—"} />
                  <DataRow label="Clay" value={analysis.environmental.clay_pct != null ? `${(analysis.environmental.clay_pct as number).toFixed(1)}%` : "—"} />
                  <DataRow label="Sand" value={analysis.environmental.sand_pct != null ? `${(analysis.environmental.sand_pct as number).toFixed(1)}%` : "—"} />
                  <DataRow label="Buildable" value={analysis.environmental.soil_buildable === false ? "No" : "Yes"} highlight />
                </>
              ) : (
                <div style={{ color: "#334155", fontSize: 12, padding: "12px 0" }}>No analysis data</div>
              )}

              {hasPlan && floorPlan ? (
                <>
                  <Section title="Floor Plan" />
                  <DataRow label="Total Area" value={`${floorPlan.total_area.toFixed(0)} m²`} highlight />
                  <DataRow label="Rooms" value={`${floorPlan.layout.length}`} />
                  <DataRow label="Fitness" value={`${(floorPlan.fitness_score * 100).toFixed(0)}%`} highlight />
                  <DataRow label="Sunlight" value={`${(floorPlan.sunlight_score * 100).toFixed(0)}%`} />
                  <DataRow label="Ventilation" value={`${(floorPlan.ventilation_score * 100).toFixed(0)}%`} />
                  <DataRow label="Trees Saved" value={`${floorPlan.tree_preserved_count}`} />
                </>
              ) : (
                <div style={{ color: "#334155", fontSize: 12, padding: "8px 0" }}>No floor plan data</div>
              )}
            </div>

            {/* Quick nav */}
            <div style={{ background: "rgba(13,242,242,0.02)", border: "1px solid rgba(13,242,242,0.08)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, color: "rgba(13,242,242,0.4)", textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 10 }}>Quick Navigation</div>
              {[
                { icon: "architecture", label: "Blueprint Generator", href: `/analysis/${plotId}` },
                { icon: "view_in_ar",   label: "3D Model",            href: `/model3d/${plotId}` },
                { icon: "map",          label: "Back to Map",         href: "/map" },
              ].map(item => (
                <Link key={item.label} href={item.href} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", textDecoration: "none", color: "#64748b", fontSize: 12 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#0df2f2" }}>{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
