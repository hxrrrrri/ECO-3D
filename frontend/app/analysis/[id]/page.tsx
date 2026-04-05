"use client";

import { memo, useCallback, useRef, useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { generateFloorPlan, type CriterionResultSchema, type EcoAuditReportSchema, type FloorPlanVariant, type IterationHistorySchema, type IterationSnapshotSchema } from "@/lib/api";
import { fetchLiveEnvironment } from "@/lib/liveEnvironment";

interface Room { id?: string; type: string; width: number; height: number; x: number; y: number; floor: number; orientation: string; }
interface Wall { id?: string; room_id: string; type: string; orientation: string; x: number; y: number; x2?: number; y2?: number; length: number; thickness: number; floor: number; }
interface Door { id?: string; room_to: string; type: string; x: number; y: number; width: number; orientation: string; floor: number; symbol?: string; }
interface WindowEl { id?: string; wall: string; position?: number; width: number; floor: number; }
interface Tree { lat: number; lon: number; confidence: number; }

// ── Plot shape polygon generators ─────────────────────────────────────────────
function makePlotPolygon(shape: string, area: number): [number,number][] {
  const s = Math.sqrt(area);
  switch(shape.toLowerCase().replace(/[-\s]/g, "")) {
    case "square":
      return [[0,0],[s,0],[s,s],[0,s]];
    case "rectangle":
      return [[0,0],[s*1.4,0],[s*1.4,s*0.72],[0,s*0.72]];
    case "lshape": case "l":
      const lw=s*1.3,lh=s*1.3;
      return [[0,0],[lw,0],[lw,lh*0.45],[lw*0.5,lh*0.45],[lw*0.5,lh],[0,lh]];
    case "tshape": case "t":
      const tw=s*1.5,th=s*1.0,sw2=tw*0.35,cx2=(tw-tw*0.35)/2;
      return [[0,0],[tw,0],[tw,th*0.5],[cx2+sw2,th*0.5],[cx2+sw2,th],[cx2,th],[cx2,th*0.5],[0,th*0.5]];
    case "irregular":
      const iw=s*1.2,ih=s*0.9;
      return [[0,ih*0.15],[iw*0.1,0],[iw*0.85,0],[iw,ih*0.2],[iw*0.95,ih],[iw*0.05,ih*0.9]];
    default:
      return [[0,0],[s*1.4,0],[s*1.4,s*0.72],[0,s*0.72]];
  }
}

function pointInPoly(px:number, py:number, poly:[number,number][]): boolean {
  let inside = false; let j = poly.length - 1;
  for(let i=0;i<poly.length;i++){
    const [xi,yi]=poly[i],[xj,yj]=poly[j];
    if(((yi>py)!=(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi+1e-9)+xi)) inside=!inside;
    j=i;
  }
  return inside;
}

// ── Room limits by area ───────────────────────────────────────────────────────
function computeRoomLimits(area: number) {
  if(area < 60) return {bedrooms:1,bathrooms:1,puja_room:false,garage:false,office:false,dining:false,utility:false};
  if(area < 100) return {bedrooms:2,bathrooms:1,puja_room:true,garage:false,office:false,dining:false,utility:false};
  if(area < 150) return {bedrooms:3,bathrooms:2,puja_room:true,garage:false,office:true,dining:true,utility:true};
  if(area < 250) return {bedrooms:4,bathrooms:2,puja_room:true,garage:true,office:true,dining:true,utility:true};
  if(area < 400) return {bedrooms:5,bathrooms:3,puja_room:true,garage:true,office:2,dining:true,utility:true};
  return {bedrooms:6,bathrooms:4,puja_room:true,garage:true,office:2,dining:true,utility:true};
}

function recommendFloorAreaFromPlot(plotAreaSqm: number, floors: number) {
  const safePlot = Math.max(0, Number(plotAreaSqm) || 0);
  const floorCount = Math.max(1, Math.min(3, Number(floors) || 1));
  const far = floorCount === 1 ? 0.08 : floorCount === 2 ? 0.12 : 0.15;
  const suggested = Math.round(safePlot * far);
  return Math.max(120, Math.min(720, suggested));
}

function EcoScoreRing({ score }: { score: number }) {
  const r = 54; const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="relative flex items-center justify-center w-36 h-36">
      <svg width="144" height="144" className="rotate-[-90deg] absolute">
        <circle cx="72" cy="72" r={r} stroke="rgba(13,242,242,0.08)" strokeWidth="8" fill="none" />
        <circle cx="72" cy="72" r={r} stroke="#0df2f2" strokeWidth="8" fill="none"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1.8s cubic-bezier(0.4,0,0.2,1)", filter: "drop-shadow(0 0 8px #0df2f2)" }} />
      </svg>
      <div className="flex flex-col items-center z-10">
        <span className="text-3xl font-black text-white">{score}%</span>
        <span className="text-[9px] text-primary/60 uppercase tracking-[0.2em] font-bold mt-0.5">ECOSCORE</span>
      </div>
    </div>
  );
}

function EffBar({ label, value, status, color }: { label: string; value: number; status: string; color: string }) {
  return (
    <div className="mb-4">
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-[11px] text-slate-300 font-medium">{label}</span>
        <span className="text-[11px] font-bold" style={{ color }}>{status}</span>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color, boxShadow: `0 0 8px ${color}`, transition: "width 1.5s ease" }} />
      </div>
    </div>
  );
}

function scoreColor(value: number) {
  if (value >= 80) return "#22c55e";
  if (value >= 50) return "#f59e0b";
  return "#ef4444";
}

function AnimatedScoreBar({ label, value, active }: { label: string; value: number; active: boolean }) {
  const [display, setDisplay] = useState(active ? 0 : value);

  useEffect(() => {
    const target = Math.max(0, Math.min(100, value));
    let raf = 0;
    if (!active) {
      setDisplay(target);
      return;
    }

    setDisplay(0);
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / 600);
      setDisplay(target * p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, active]);

  const color = scoreColor(value);
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] uppercase tracking-[0.08em] text-slate-400">{label}</span>
        <span className="text-[9px] font-bold" style={{ color }}>{Math.round(value)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${display}%`, background: color, boxShadow: `0 0 10px ${color}66` }}
        />
      </div>
    </div>
  );
}

const CRITERION_LABELS: Record<number, string> = {
  1: "Passive Solar Orientation",
  2: "Natural Ventilation",
  3: "Compactness & Efficiency",
  4: "Thermal Zoning",
  5: "Flood Resilience",
  6: "Natural Daylighting",
  7: "Tree Preservation",
  8: "Soil & Foundation",
  9: "Renewable Readiness",
  10: "Indoor Air Quality",
};

function criterionBarClass(score: number): string {
  if (score >= 65) return "bg-green-500";
  if (score >= 40) return "bg-amber-500";
  return "bg-red-500";
}

function gradeBadgeClass(grade: string): string {
  if (grade === "A+" || grade === "A") return "bg-green-500/20 text-green-300 border-green-400/40";
  if (grade === "B+" || grade === "B") return "bg-teal-500/20 text-teal-300 border-teal-400/40";
  if (grade === "C+" || grade === "C") return "bg-amber-500/20 text-amber-300 border-amber-400/40";
  return "bg-red-500/20 text-red-300 border-red-400/40";
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function gradeFromScore(score: number): EcoAuditReportSchema["grade"] {
  if (score >= 85) return "A+";
  if (score >= 75) return "A";
  if (score >= 68) return "B+";
  if (score >= 60) return "B";
  if (score >= 52) return "C+";
  if (score >= 45) return "C";
  if (score >= 35) return "D";
  return "F";
}

function fallbackCriterion(
  criterionId: number,
  score: number,
  weight: number,
  recommendation: string,
): CriterionResultSchema {
  const safeScore = clampPct(score);
  return {
    criterion_id: criterionId,
    criterion_name: CRITERION_LABELS[criterionId] ?? `Criterion ${criterionId}`,
    score: safeScore,
    weight,
    weighted_score: Number((safeScore * weight).toFixed(3)),
    passed: safeScore >= 50,
    pass_threshold: 50,
    sub_scores: {},
    findings: ["Derived from available variant metrics because detailed eco audit payload is unavailable."],
    penalties_applied: [],
    bonuses_applied: [],
    recommendations: [recommendation],
    data_sources: ["variant scores"],
    standard_ref: "Fallback",
  };
}

function buildFallbackAuditFromVariant(variant: FloorPlanVariant | null | undefined): EcoAuditReportSchema | null {
  if (!variant) return null;
  if (variant.eco_audit) return variant.eco_audit;

  const solar = clampPct((variant.solar_score ?? 0) * 100);
  const vent = clampPct((variant.ventilation_score ?? 0) * 100);
  const structural = clampPct((variant.structural_score ?? 0) * 100);
  const flood = clampPct((variant.flood_score ?? 0) * 100);
  const tree = clampPct((variant.tree_score ?? 0) * 100);
  const composite = clampPct((variant.eco_score ?? variant.fitness_score ?? 0) * 100);

  const criteria: CriterionResultSchema[] = [
    fallbackCriterion(1, solar, 0.18, "Improve solar-facing orientation for living and bedroom spaces."),
    fallbackCriterion(2, vent, 0.16, "Add cross-vent openings on opposite or perpendicular faces."),
    fallbackCriterion(3, (structural * 0.7 + solar * 0.3), 0.12, "Reduce footprint articulation and improve compactness."),
    fallbackCriterion(4, (vent * 0.5 + structural * 0.5), 0.12, "Strengthen thermal zoning between service and habitable spaces."),
    fallbackCriterion(5, flood, 0.10, "Move key habitable zones away from flood-prone placement."),
    fallbackCriterion(6, solar, 0.10, "Increase balanced daylight openings in habitable rooms."),
    fallbackCriterion(7, tree, 0.08, "Shift footprint away from tree influence/protection zones."),
    fallbackCriterion(8, structural, 0.06, "Adjust foundation strategy for slope and soil resilience."),
    fallbackCriterion(9, solar, 0.05, "Reserve roof area and orientation for future PV and rainwater systems."),
    fallbackCriterion(10, vent, 0.03, "Ensure each room has operable openings for indoor air quality."),
  ];

  const sorted = [...criteria].sort((a, b) => b.score - a.score);
  const passed = criteria.filter((c) => c.passed).length;
  const fixes = [...criteria]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((c) => `[${c.criterion_name}] ${c.recommendations[0]}`);

  return {
    variant_id: variant.id,
    algorithm: variant.algorithm || "Unknown",
    timestamp: new Date().toISOString(),
    criteria,
    composite_eco_score: Number(composite.toFixed(2)),
    grade: gradeFromScore(composite),
    overall_passed: passed >= 7,
    n_criteria_passed: passed,
    n_criteria_failed: 10 - passed,
    critical_failures: criteria.filter((c) => c.score < 40).map((c) => c.criterion_name),
    top_strengths: sorted.slice(0, 3).map((c) => c.criterion_name),
    top_weaknesses: sorted.slice(-3).map((c) => c.criterion_name),
    priority_fixes: fixes,
    climate_context: "unknown",
    site_risk_level: flood > 60 ? "high" : flood >= 30 ? "moderate" : "low",
    compliance_citations: ["Fallback - detailed eco audit unavailable in response"],
    data_quality: {
      wind: false,
      soil: false,
      ndvi: false,
      flood: false,
      elevation: false,
      is_fully_live: false,
      live_field_count: 0,
      fallback_field_count: 5,
    },
  };
}

const EcoReportPanel = memo(function EcoReportPanel({
  className,
}: {
  className?: string
}): JSX.Element {
  const activeAudit = useEco3DStore((s) => s.activeAudit);
  const activeVariant = useEco3DStore((s) => s.floorPlanVariants[s.activeVariantIndex] ?? null);
  const activeIterationIndex = useEco3DStore((s) => s.activeIterationIndex);
  const totalIterations = useEco3DStore((s) => s.floorPlan?.iteration_history?.snapshots?.length ?? 1);
  const audit = useMemo(
    () => activeAudit ?? buildFallbackAuditFromVariant(activeVariant),
    [activeAudit, activeVariant],
  );
  const isViewingFinal = activeIterationIndex >= Math.max(0, totalIterations - 1);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [animatedScores, setAnimatedScores] = useState<Record<number, number>>({});
  const [animKey, setAnimKey] = useState(0);

  useEffect(() => {
    setAnimKey((k) => k + 1);
  }, [audit]);

  const criteria = useMemo(() => {
    if (!audit) return [] as CriterionResultSchema[];
    const byId = new Map<number, CriterionResultSchema>();
    for (const c of audit.criteria ?? []) byId.set(c.criterion_id, c);
    const filled: CriterionResultSchema[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const row = byId.get(i);
      if (row) {
        filled.push(row);
      } else {
        filled.push({
          criterion_id: i,
          criterion_name: CRITERION_LABELS[i] ?? `Criterion ${i}`,
          score: 0,
          weight: 0,
          weighted_score: 0,
          passed: false,
          pass_threshold: 50,
          sub_scores: {},
          findings: ["No criterion data returned for this variant."],
          penalties_applied: [],
          bonuses_applied: [],
          recommendations: ["Regenerate this variant to compute complete audit criteria."],
          data_sources: [],
          standard_ref: "N/A",
        });
      }
    }
    return filled.sort((a, b) => a.criterion_id - b.criterion_id);
  }, [audit]);

  useEffect(() => {
    setExpandedRows({});
    if (criteria.length === 0) {
      setAnimatedScores({});
      return;
    }
    const seed: Record<number, number> = {};
    for (const c of criteria) seed[c.criterion_id] = 0;
    setAnimatedScores(seed);

    let raf = 0;
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / 700);
      const next: Record<number, number> = {};
      for (const c of criteria) next[c.criterion_id] = c.score * p;
      setAnimatedScores(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [criteria]);

  if (!audit) {
    return (
      <div className={`h-full rounded-xl border border-cyan-400/10 bg-cyan-950/20 p-4 ${className ?? ""}`}>
        <div className="text-xs font-bold uppercase tracking-[0.14em] text-cyan-300/80">Eco Audit Report</div>
        <div className="mt-2 text-xs text-slate-400">Analysis pending - generate a floor plan first.</div>
        <div className="mt-4 space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-white/5" />
          ))}
        </div>
      </div>
    );
  }

  const liveCount = audit.data_quality?.live_field_count ?? 0;
  const fallbackCount = audit.data_quality?.fallback_field_count ?? Math.max(0, 5 - liveCount);
  const liveOk = liveCount >= 5;
  const criterionByName = new Map(criteria.map((c) => [c.criterion_name.toLowerCase(), c]));
  const numerals = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
  const topStrengths = Array.isArray(audit.top_strengths) ? audit.top_strengths : [];
  const priorityFixes = Array.isArray(audit.priority_fixes) ? audit.priority_fixes : [];
  const complianceCitations = Array.isArray(audit.compliance_citations) ? audit.compliance_citations : [];
  const auditAlgorithm = audit.algorithm || "Unknown";
  const climateContext = audit.climate_context || "unknown";
  const siteRisk = audit.site_risk_level || "unknown";
  const passedCount = Number.isFinite(audit.n_criteria_passed)
    ? audit.n_criteria_passed
    : criteria.filter((c) => c.passed).length;
  const ecoScore = Number.isFinite(audit.composite_eco_score)
    ? audit.composite_eco_score
    : 0;

  return (
    <div className={`h-full rounded-xl border border-cyan-400/10 bg-cyan-950/20 p-4 text-slate-100 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-cyan-300/80">Eco Audit Report</div>
          <div className="mt-1 text-xs text-slate-400">
            {auditAlgorithm} · Climate: {climateContext} · Risk: {siteRisk}
          </div>
          <div className="mt-1 text-xs text-slate-300">
            {passedCount} of 10 criteria passed
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-sm font-black text-cyan-200">{Math.round(ecoScore)}/100</div>
          <div className={`h-16 w-16 rounded-full border text-center text-2xl font-black leading-[3.8rem] ${gradeBadgeClass(audit.grade)}`}>
            {audit.grade}
          </div>
        </div>
      </div>

      {totalIterations > 1 && !isViewingFinal ? (
        <div className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/12 px-3 py-2 text-xs text-amber-300">
          ⚠ Viewing Iteration {activeIterationIndex} of {Math.max(0, totalIterations - 1)} - Click the final iteration to see the corrected plan
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-green-500/35 bg-green-500/12 px-3 py-2 text-xs text-green-300">
          ✓ Showing Final Corrected Plan ({passedCount}/10 criteria passing)
        </div>
      )}

      <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${liveOk ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
        {liveOk
          ? `📡 Live Data: ${liveCount}/5 fields confirmed`
          : `⚠️ Live Data: ${liveCount}/5 fields (${fallbackCount} using fallback values)`}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300/70">Criterion Scores</div>
        <div key={animKey} className="space-y-2">
          {criteria.map((c, index) => {
            const animated = Math.max(0, Math.min(100, animatedScores[c.criterion_id] ?? c.score));
            const expanded = !!expandedRows[c.criterion_id];
            return (
              <div key={c.criterion_id} className="rounded-md border border-white/10 bg-black/20">
                <button
                  onClick={() => setExpandedRows((prev) => ({ ...prev, [c.criterion_id]: !prev[c.criterion_id] }))}
                  className="w-full px-2 py-2 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-4 text-[12px] text-slate-400">{numerals[index] ?? `${c.criterion_id}.`}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200">{c.criterion_name || CRITERION_LABELS[c.criterion_id]}</span>
                    <div className="w-28 rounded-full bg-white/10">
                      <div className={`h-1.5 rounded-full ${criterionBarClass(c.score)}`} style={{ width: `${animated}%` }} />
                    </div>
                    <span className="w-8 text-right text-[11px] font-bold text-slate-100">{Math.round(c.score)}</span>
                    <span className={`w-10 text-right text-[10px] font-bold ${c.passed ? "text-green-400" : "text-red-400"}`}>
                      {c.passed ? "PASS" : "FAIL"}
                    </span>
                  </div>
                </button>
                {expanded && (
                  <div className="border-t border-white/10 px-2 pb-2 pt-1 text-[10px] text-slate-300">
                    {c.findings.length > 0 && (
                      <div className="mb-1">
                        <div className="text-cyan-300/80">Findings</div>
                        <div>{c.findings.join(" | ")}</div>
                      </div>
                    )}
                    {c.penalties_applied.length > 0 && (
                      <div className="mb-1">
                        <div className="text-red-300/80">Penalties</div>
                        <div>{c.penalties_applied.join(" | ")}</div>
                      </div>
                    )}
                    {c.recommendations.length > 0 && (
                      <div>
                        <div className="text-amber-300/80">Recommendations</div>
                        <div>{c.recommendations.join(" | ")}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-2 text-[11px]">
        <div className="mb-1 font-bold uppercase tracking-[0.12em] text-cyan-300/70">Top Strengths</div>
        <div className="text-slate-200">
          {topStrengths.length === 0 && "No ranked strengths returned for this variant."}
          {topStrengths.map((name) => {
            const score = criterionByName.get(name.toLowerCase())?.score;
            return `★ ${name}${typeof score === "number" ? ` (${Math.round(score)})` : ""}`;
          }).join("  ")}
        </div>
      </div>

      <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-2 text-[11px]">
        <div className="mb-1 font-bold uppercase tracking-[0.12em] text-cyan-300/70">Priority Fixes</div>
        <div className="space-y-1 text-slate-200">
          {priorityFixes.length === 0 && <div>No priority fixes were returned for this variant.</div>}
          {priorityFixes.slice(0, 5).map((fix, i) => {
            const nameMatch = fix.match(/^\[(.*?)\]/);
            const linked = nameMatch ? criterionByName.get((nameMatch[1] || "").toLowerCase()) : undefined;
            const dot = linked && linked.score < 40 ? "🔴" : "🟡";
            return <div key={`${fix}-${i}`}>{dot} {fix}</div>;
          })}
        </div>
      </div>

      <div className="mt-3 text-[10px] text-slate-400">
        COMPLIANCE: {complianceCitations.length ? complianceCitations.join(" · ") : "No compliance citations available"}
      </div>
    </div>
  );
});

EcoReportPanel.displayName = "EcoReportPanel";

const CRITERION_SHORT_LABELS: Record<number, string> = {
  1: "Solar",
  2: "Ventilation",
  3: "Compactness",
  4: "Thermal Zoning",
  5: "Flood",
  6: "Daylighting",
  7: "Trees",
  8: "Soil",
  9: "Renewables",
  10: "IAQ",
};

function criteriaSummary(ids: number[] | undefined): string {
  if (!ids || ids.length === 0) return "None";
  return ids.map((id) => CRITERION_SHORT_LABELS[id] ?? `C${id}`).join(", ");
}

function extractFailedRooms(findings: string[], rooms: Room[]): Room[] {
  const lines = (findings ?? []).map((item) => String(item).toLowerCase());
  const matched = rooms.filter((room) => {
    const roomId = String(room.id ?? "").toLowerCase();
    const roomType = String(room.type ?? "").toLowerCase();
    const roomTypeSpaced = roomType.replace(/_/g, " ");
    return lines.some((line) => {
      if (roomId && line.includes(roomId)) return true;
      return line.includes(roomType) || line.includes(roomTypeSpaced);
    });
  });

  if (matched.length > 0) return matched;
  return rooms;
}

function doesRoomPassAllApplicableCriteria(room: Room, audit: EcoAuditReportSchema | null): boolean {
  if (!audit) return true;
  const roomType = String(room.type ?? "").toLowerCase();
  const habitable = ["living", "dining", "bedroom", "office"].includes(roomType);
  const relevantIds = habitable ? [1, 2, 5, 6, 10] : [2, 4, 10];
  return relevantIds.every((criterionId) => {
    const criterion = (audit.criteria ?? []).find((item) => item.criterion_id === criterionId);
    return !criterion || criterion.passed;
  });
}

function getIterationDiff(
  prev: IterationSnapshotSchema | null,
  curr: IterationSnapshotSchema,
): { fixed: string[]; broken: string[] } {
  if (!prev) return { fixed: [], broken: [] };

  const fixed = (curr.audit?.criteria ?? [])
    .filter((c) => {
      const prevC = (prev.audit?.criteria ?? []).find((p) => p.criterion_id === c.criterion_id);
      return !!prevC && !prevC.passed && c.passed;
    })
    .map((c) => c.criterion_name);

  const broken = (curr.audit?.criteria ?? [])
    .filter((c) => {
      const prevC = (prev.audit?.criteria ?? []).find((p) => p.criterion_id === c.criterion_id);
      return !!prevC && prevC.passed && !c.passed;
    })
    .map((c) => c.criterion_name);

  return { fixed, broken };
}

const IterationTimeline = memo(function IterationTimeline({
  history,
  isLoading,
  onSelectIteration,
  activeIterationIndex,
}: {
  history: IterationHistorySchema | null | undefined;
  isLoading: boolean;
  onSelectIteration: (iterationIndex: number) => void;
  activeIterationIndex: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [expandedCorrections, setExpandedCorrections] = useState(false);
  const [expandedCorrectionIndex, setExpandedCorrectionIndex] = useState<number | null>(null);

  const scoreCurve = history?.eco_score_curve ?? [];
  const snapshots = history?.snapshots ?? [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = Math.max(320, canvas.clientWidth || 320);
    const height = 170;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const left = 34;
    const right = width - 14;
    const top = 14;
    const bottom = height - 28;

    const minScore = 40;
    const maxScore = 100;
    const points = scoreCurve.map((value, idx) => {
      const x = scoreCurve.length <= 1
        ? left
        : left + (idx / (scoreCurve.length - 1)) * (right - left);
      const y = bottom - ((Math.max(minScore, Math.min(maxScore, value)) - minScore) / (maxScore - minScore)) * (bottom - top);
      return { x, y, score: value };
    });

    let raf = 0;
    let start = 0;

    const drawBase = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#0b1416";
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(13,242,242,0.14)";
      ctx.lineWidth = 1;
      [40, 60, 80, 100].forEach((tick) => {
        const y = bottom - ((tick - minScore) / (maxScore - minScore)) * (bottom - top);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();

        ctx.fillStyle = "rgba(148,163,184,0.8)";
        ctx.font = "10px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(String(tick), left - 6, y);
      });

      ctx.fillStyle = "rgba(148,163,184,0.8)";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i < points.length; i += 1) {
        const x = points.length <= 1
          ? left
          : left + (i / Math.max(points.length - 1, 1)) * (right - left);
        ctx.fillText(String(i), x, bottom + 8);
      }
    };

    const draw = (progress: number) => {
      drawBase();
      if (points.length === 0) {
        ctx.fillStyle = "rgba(148,163,184,0.9)";
        ctx.font = "12px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No score curve yet", width * 0.5, height * 0.5);
        return;
      }

      const maxX = left + (right - left) * progress;

      ctx.strokeStyle = "#0df2f2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1];
        const point = points[i];
        if (point.x <= maxX) {
          ctx.lineTo(point.x, point.y);
        } else {
          const span = Math.max(1e-6, point.x - prev.x);
          const t = Math.max(0, Math.min(1, (maxX - prev.x) / span));
          const y = prev.y + (point.y - prev.y) * t;
          ctx.lineTo(maxX, y);
          break;
        }
      }
      ctx.stroke();

      for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        if (point.x > maxX + 0.5) break;
        const prevScore = i > 0 ? points[i - 1].score : point.score;
        const improved = i === 0 ? true : point.score > prevScore + 0.05;

        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = improved ? "#22c55e" : "#ef4444";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5.0, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    const step = (timestamp: number) => {
      if (!start) start = timestamp;
      const progress = Math.min(1, (timestamp - start) / 800);
      draw(progress);
      if (progress < 1) raf = requestAnimationFrame(step);
    };

    draw(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scoreCurve]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-cyan-400/10 bg-cyan-950/20 p-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300/80">Correction Loop History</div>
        <div className="mt-3 space-y-2">
          {Array.from({ length: 5 }).map((_, idx) => (
            <div key={idx} className="h-7 animate-pulse rounded bg-white/10" />
          ))}
        </div>
      </div>
    );
  }

  if (!history) {
    return (
      <div className="rounded-xl border border-cyan-400/10 bg-cyan-950/20 p-4 text-[11px] text-slate-300">
        <div className="font-bold uppercase tracking-[0.14em] text-cyan-300/80">Correction Loop History</div>
        <div className="mt-2 text-slate-400">No history yet.</div>
      </div>
    );
  }

  const totalImprovement = Number(history.total_improvement ?? 0);
  const improvementPillClass = totalImprovement > 20
    ? "border-green-500/40 bg-green-500/15 text-green-300"
    : totalImprovement >= 10
    ? "border-amber-500/40 bg-amber-500/15 text-amber-300"
    : "border-red-500/40 bg-red-500/15 text-red-300";

  const initialScore = Number(history.initial_eco_score ?? 0);
  const finalScore = Number(history.final_eco_score ?? 0);

  return (
    <div className="rounded-xl border border-cyan-400/10 bg-cyan-950/20 p-4 text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300/85">Correction Loop History</div>
          <div className="mt-1 text-[10px] text-slate-400">
            Initial: {initialScore.toFixed(1)} to Final: {finalScore.toFixed(1)}
          </div>
          <div className="text-[10px] text-slate-400">
            {history.converged
              ? `Converged in ${history.total_iterations} iteration(s)`
              : `Stopped after ${history.total_iterations} iteration(s) - ${history.convergence_reason}`}
          </div>
        </div>
        <div className={`rounded-full border px-2 py-1 text-[10px] font-bold ${improvementPillClass}`}>
          {totalImprovement >= 0 ? "+" : ""}{totalImprovement.toFixed(1)} pts
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-[#0b1416]">
        <canvas ref={canvasRef} className="block h-[170px] w-full" />
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300/75">Iteration Log</div>
        {snapshots.length === 0 ? (
          <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-slate-400">No iterations yet.</div>
        ) : (
          <div className="space-y-2">
            {snapshots.map((snap, idx) => {
              const prevScore = idx === 0 ? snap.eco_score : snapshots[idx - 1].eco_score;
              const delta = snap.eco_score - prevScore;
              const correction = snap.correction;
              const fixedSummary = criteriaSummary(correction?.criteria_targeted);
              const isConvergedRow = !!history.converged && idx === snapshots.length - 1;
              const isSelected = activeIterationIndex === snap.iteration;
              const diff = getIterationDiff(idx > 0 ? snapshots[idx - 1] : null, snap);

              return (
                <button
                  key={`iter-${snap.iteration}`}
                  className={`w-full rounded-md border px-2 py-2 text-left transition-colors ${
                    isConvergedRow
                      ? "border-amber-400/40 bg-amber-500/10"
                      : isSelected
                      ? "border-cyan-300/45 bg-cyan-400/10"
                      : "border-white/10 bg-black/20 hover:border-cyan-300/30"
                  }`}
                  onClick={() => onSelectIteration(snap.iteration)}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-bold text-slate-100">
                      {isConvergedRow ? "*" : delta > 0.05 ? "+" : "-"} Iter {snap.iteration}
                    </span>
                    <span className="font-mono text-cyan-200">{Number(snap.eco_score).toFixed(1)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[10px]">
                    <span className="text-slate-400">Fixed: {fixedSummary}</span>
                    <span className={delta > 0.05 ? "text-green-300" : "text-red-300"}>
                      {delta >= 0 ? "+" : ""}{delta.toFixed(1)}
                    </span>
                  </div>
                  {(diff.fixed.length > 0 || diff.broken.length > 0) && (
                    <div className="mt-1 flex flex-wrap gap-1 text-[9px]">
                      {diff.fixed.map((name) => (
                        <span key={`fixed-${snap.iteration}-${name}`} className="text-green-400">+{name}</span>
                      ))}
                      {diff.broken.map((name) => (
                        <span key={`broken-${snap.iteration}-${name}`} className="text-red-400">-{name}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 flex items-center">
                    {(snap.audit?.criteria ?? []).map((criterion) => (
                      <span
                        key={`dot-${snap.iteration}-${criterion.criterion_id}`}
                        title={criterion.criterion_name}
                        style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          margin: "0 1px",
                          backgroundColor: criterion.passed ? "#22c55e" : "#ef4444",
                          opacity: 0.85,
                        }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-md border border-white/10 bg-black/20">
        <button
          onClick={() => setExpandedCorrections((prev) => !prev)}
          className="flex w-full items-center justify-between px-3 py-2 text-left"
        >
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300/75">Corrections Applied</span>
          <span className="text-[11px] text-slate-400">{expandedCorrections ? "Hide" : "Show"}</span>
        </button>
        {expandedCorrections && (
          <div className="border-t border-white/10 px-2 pb-2 pt-1">
            {(history.corrections_applied ?? []).length === 0 ? (
              <div className="px-1 py-2 text-[10px] text-slate-400">No corrections recorded.</div>
            ) : (
              <div className="space-y-1">
                {(history.corrections_applied ?? []).map((item, idx) => {
                  const expanded = expandedCorrectionIndex === idx;
                  return (
                    <div key={`fix-${idx}`} className="rounded border border-white/10 bg-white/5">
                      <button
                        onClick={() => setExpandedCorrectionIndex((prev) => (prev === idx ? null : idx))}
                        className="w-full px-2 py-1.5 text-left text-[10px] text-slate-200"
                      >
                        {expanded ? "v" : ">"} {item}
                      </button>
                      {expanded && (
                        <div className="border-t border-white/10 px-2 py-1.5 text-[10px] text-slate-400">
                          {item}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

IterationTimeline.displayName = "IterationTimeline";

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="relative w-11 h-6 rounded-full transition-all duration-300" style={{ background: on ? "#0df2f2" : "rgba(255,255,255,0.1)" }}>
      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all duration-300" style={{ left: on ? "22px" : "2px" }} />
    </button>
  );
}

const WIND_VECTOR_MAP: Record<string, [number, number]> = {
  N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1],
  NNE: [0.5, -1], ENE: [1, -0.5], ESE: [1, 0.5], SSE: [0.5, 1],
  SSW: [-0.5, 1], WSW: [-1, 0.5], WNW: [-1, -0.5], NNW: [-0.5, -1],
};

const BLUEPRINT_ROOM_HATCH_MAP: Record<string, boolean> = {
  bathroom: true, utility: true, garage: true,
};

const BLUEPRINT_ROOM_LABEL_MAP: Record<string, string> = {
  living: "LIVING ROOM", bedroom: "BEDROOM", kitchen: "KITCHEN",
  bathroom: "BATHROOM", office: "STUDY/OFFICE", garage: "GARAGE",
  utility: "UTILITY", dining: "DINING ROOM", puja_room: "PUJA ROOM",
};

const BLUEPRINT_ROOM_STYLE_MAP: Record<string,{bg:string;border:string}> = {
  living:    {bg:"rgba(13,200,200,0.10)",  border:"#0bc8c8"},
  bedroom:   {bg:"rgba(74,157,232,0.11)",  border:"#4a9de8"},
  kitchen:   {bg:"rgba(44,180,110,0.10)",  border:"#2cb46e"},
  bathroom:  {bg:"rgba(155,114,212,0.11)", border:"#9b72d4"},
  office:    {bg:"rgba(232,195,58,0.11)",  border:"#e8c33a"},
  garage:    {bg:"rgba(143,160,160,0.10)", border:"#8fa0a0"},
  utility:   {bg:"rgba(224,128,80,0.10)",  border:"#e08050"},
  dining:    {bg:"rgba(232,122,58,0.10)",  border:"#e87a3a"},
  puja_room: {bg:"rgba(200,160,32,0.10)",  border:"#c8a020"},
};

function getWindProfile(direction: string, speed?: number, directionDegrees?: number) {
  const normalizedDirection = (direction || "SW").toUpperCase().replace(/[^A-Z]/g, "");
  const useDegrees = typeof directionDegrees === "number" && Number.isFinite(directionDegrees);
  const key = Object.keys(WIND_VECTOR_MAP)
    .sort((a, b) => b.length - a.length)
    .find(candidate => normalizedDirection.startsWith(candidate)) ?? "SW";
  const [fallbackX, fallbackY] = WIND_VECTOR_MAP[key];
  const radians = useDegrees ? (directionDegrees * Math.PI) / 180 : 0;
  const x = useDegrees ? Math.sin(radians) : fallbackX;
  const y = useDegrees ? -Math.cos(radians) : fallbackY;
  const length = Math.hypot(x, y) || 1;
  const windSpeed = typeof speed === "number" && Number.isFinite(speed) ? Math.max(0, speed) : 3.2;
  const intensity = Math.max(0.58, Math.min(1.55, 0.72 + windSpeed / 6));

  return {
    label: key,
    speed: windSpeed,
    x: x / length,
    y: y / length,
    intensity,
    particleCap: Math.round(26 + intensity * 24),
    spawnCount: Math.max(2, Math.min(6, Math.round(1 + intensity * 2.2))),
    burstMs: Math.round(1025 + windSpeed * 115),
    gapMs: Math.round(Math.max(6400, 7600 - windSpeed * 140)),
    trailMultiplier: 0.95 + intensity * 0.45,
    curveOffset: 18 + windSpeed * 2.8,
  };
}

// ── Blueprint Canvas ──────────────────────────────────────────────────────────
function LegacyBlueprintCanvas({ rooms, walls, doors, windows, trees, lat, lon, zoom, showSolarPath, showWindFlow, floorPlan, plotShape, plotArea, windDir }:
  { rooms: Room[]; walls: Wall[]; doors: Door[]; windows: WindowEl[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; floorPlan: any; plotShape: string; plotArea: number; windDir: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  // ── Wind arrow animation state ──────────────────────────────────────────
  const windParticles = useRef<Array<{x:number,y:number,life:number,speed:number,alpha:number}>>([]);

  const ROOM_CFG: Record<string, { bg: string; border: string; label: string }> = {
    living:    { bg: "rgba(13,200,200,0.07)",  border: "#0bc8c8", label: "LIVING ROOM" },
    bedroom:   { bg: "rgba(60,130,220,0.07)",   border: "#4a9de8", label: "BEDROOM" },
    kitchen:   { bg: "rgba(46,180,100,0.07)",   border: "#2cb46e", label: "KITCHEN" },
    bathroom:  { bg: "rgba(140,80,200,0.07)",   border: "#9b72d4", label: "BATHROOM" },
    office:    { bg: "rgba(220,180,20,0.07)",   border: "#e8c33a", label: "OFFICE" },
    garage:    { bg: "rgba(110,120,120,0.07)",  border: "#8fa0a0", label: "GARAGE" },
    utility:   { bg: "rgba(220,120,40,0.07)",   border: "#e08050", label: "UTILITY" },
    dining:    { bg: "rgba(220,80,80,0.07)",    border: "#d25050", label: "DINING" },
    puja_room: { bg: "rgba(255,215,0,0.07)",    border: "#ffd700", label: "PUJA ROOM" },
  };
  const getStyle = (t: string) => {
    const k = Object.keys(ROOM_CFG).find(k => t.toLowerCase().includes(k.replace("_","")));
    return k ? ROOM_CFG[k] : { bg: "rgba(13,242,242,0.05)", border: "#0df2f2", label: t.toUpperCase() };
  };

  // Wind direction vector
  const windVec = useMemo(() => {
    const M: Record<string,[number,number]> = {
      N:[0,-1],NE:[1,-1],E:[1,0],SE:[1,1],S:[0,1],SW:[-1,1],W:[-1,0],NW:[-1,-1],
      NNE:[0.5,-1],SSW:[-0.5,1],ENE:[1,-0.5],WSW:[-1,0.5],
      NNW:[-0.5,-1],SSE:[0.5,1],ESE:[1,0.5],WNW:[-1,-0.5],
    };
    const key = Object.keys(M).find(k => windDir.startsWith(k)) ?? "NW";
    const [x,z] = M[key]; const l = Math.sqrt(x*x+z*z)||1;
    return {x:x/l, y:z/l};
  }, [windDir]);

  const layoutRooms = useCallback((rawRooms: Room[]) => {
    const floor1 = rawRooms.filter(r => (r.floor ?? 1) === 1);
    if (floor1.length === 0) return [];
    const ORDER = ["living","kitchen","dining","bedroom","bedroom","bathroom","puja_room","office","utility","garage"];
    const sorted = [...floor1].sort((a,b) => {
      const ai = ORDER.findIndex(o => a.type.toLowerCase().includes(o.replace("_","")));
      const bi = ORDER.findIndex(o => b.type.toLowerCase().includes(o.replace("_","")));
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    const publicTypes = ["living","kitchen","dining"];
    const privateTypes = ["bedroom","bathroom","puja_room"];
    const serviceTypes = ["office","utility","garage","corridor"];
    const rows: Room[][] = [
      sorted.filter(r => publicTypes.some(t => r.type.toLowerCase().includes(t))),
      sorted.filter(r => privateTypes.some(t => r.type.toLowerCase().includes(t.replace("_","")))),
      sorted.filter(r => serviceTypes.some(t => r.type.toLowerCase().includes(t))),
    ].filter(row => row.length > 0);
    const normalizeSize = (r: Room) => {
      const t = r.type.toLowerCase();
      if(t.includes("living")) return {w:Math.max(4.5,Math.min(7,r.width)),h:Math.max(4,Math.min(6,r.height))};
      if(t.includes("kitchen")) return {w:Math.max(3.5,Math.min(5.5,r.width)),h:Math.max(3,Math.min(5,r.height))};
      if(t.includes("dining")) return {w:Math.max(3,Math.min(5,r.width)),h:Math.max(3,Math.min(4.5,r.height))};
      if(t.includes("bedroom")) return {w:Math.max(3.2,Math.min(5,r.width)),h:Math.max(3,Math.min(4.5,r.height))};
      if(t.includes("bathroom")) return {w:Math.max(2,Math.min(3.5,r.width)),h:Math.max(2,Math.min(3.2,r.height))};
      if(t.includes("puja")) return {w:Math.max(2,Math.min(3,r.width)),h:Math.max(2,Math.min(3,r.height))};
      if(t.includes("office")) return {w:Math.max(3,Math.min(4.5,r.width)),h:Math.max(3,Math.min(4,r.height))};
      if(t.includes("garage")) return {w:Math.max(4.5,Math.min(7,r.width)),h:Math.max(4,Math.min(6,r.height))};
      return {w:Math.max(2.5,Math.min(4,r.width)),h:Math.max(2,Math.min(3.5,r.height))};
    };
    const rowSizes = rows.map(row => ({
      totalW: row.reduce((s,r) => s + normalizeSize(r).w, 0),
      maxH: Math.max(...row.map(r => normalizeSize(r).h)),
    }));
    const globalMaxW = Math.max(...rowSizes.map(r => r.totalW));
    let curY = 0;
    const placed: Array<Room & {pw:number;ph:number;px:number;py:number}> = [];
    rows.forEach((row, ri) => {
      const { totalW, maxH } = rowSizes[ri];
      const scale = totalW < globalMaxW ? globalMaxW / totalW : 1;
      let curX = 0;
      row.forEach(r => {
        const sz = normalizeSize(r);
        placed.push({ ...r, pw: sz.w * scale, ph: sz.h, px: curX, py: curY });
        curX += sz.w * scale;
      });
      curY += maxH;
    });
    return placed;
  }, []);

  const draw = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.offsetWidth || 700;
    const H = canvas.offsetHeight || 600;
    canvas.width = W; canvas.height = H;
    timeRef.current = t / 1000;

    // ── Background + grid ──
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);
    const GRID = 22;
    ctx.strokeStyle = "rgba(13,242,242,0.06)"; ctx.lineWidth = 0.5;
    for(let gx=0;gx<W;gx+=GRID){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H);ctx.stroke();}
    for(let gy=0;gy<H;gy+=GRID){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke();}
    ctx.strokeStyle = "rgba(13,242,242,0.11)"; ctx.lineWidth = 0.8;
    for(let gx=0;gx<W;gx+=GRID*5){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H);ctx.stroke();}
    for(let gy=0;gy<H;gy+=GRID*5){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke();}

    if (rooms.length === 0) {
      ctx.fillStyle = "#0df2f2"; ctx.font = "bold 14px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("AWAITING FLOOR PLAN GENERATION", W/2, H/2-10);
      ctx.fillStyle = "rgba(13,242,242,0.4)"; ctx.font = "11px sans-serif";
      ctx.fillText("Select a plot and run analysis", W/2, H/2+14);
      return;
    }

    // ── USE BACKEND COORDINATES DIRECTLY ──────────────────────────────────────
    // r.x, r.y, r.width, r.height are the authoritative layout positions.
    // The canvas NEVER re-lays rooms — it only scales and offsets them.
    const floor1 = rooms.filter(r => (r.floor ?? 1) === 1);
    if (floor1.length === 0) return;

    // Bounding box from backend coordinates
    const allRX = floor1.flatMap(r => [r.x, r.x + r.width]);
    const allRY = floor1.flatMap(r => [r.y, r.y + r.height]);
    const minRX = Math.min(...allRX), maxRX = Math.max(...allRX);
    const minRY = Math.min(...allRY), maxRY = Math.max(...allRY);
    const totalW_m = maxRX - minRX;
    const totalH_m = maxRY - minRY;

    // Scale to fit canvas with margins
    const MARGIN = 80;
    const SCALE = Math.min((W - MARGIN*2) / Math.max(totalW_m, 0.1), (H - MARGIN*2) / Math.max(totalH_m, 0.1));
    const bw = totalW_m * SCALE;
    const bh = totalH_m * SCALE;
    const offX = (W - bw) / 2;
    const offY = (H - bh) / 2 + 10;
    const OWT = Math.max(6, SCALE * 0.4);
    const IWT = Math.max(3, SCALE * 0.15);

    // Helper: metres → canvas pixels
    const px = (x: number) => offX + (x - minRX) * SCALE;
    const py = (y: number) => offY + (y - minRY) * SCALE;
    const ps = (v: number) => v * SCALE;

    const ROOM_COLORS: Record<string,{bg:string;border:string;label:string}> = {
      living:    {bg:"rgba(11,200,200,0.13)",  border:"#0bc8c8", label:"LIVING ROOM"},
      bedroom:   {bg:"rgba(74,157,232,0.13)",  border:"#4a9de8", label:"BEDROOM"},
      kitchen:   {bg:"rgba(44,180,110,0.13)",  border:"#2cb46e", label:"KITCHEN"},
      bathroom:  {bg:"rgba(155,114,212,0.13)", border:"#9b72d4", label:"BATHROOM"},
      office:    {bg:"rgba(232,195,58,0.13)",  border:"#e8c33a", label:"STUDY"},
      garage:    {bg:"rgba(143,160,160,0.13)", border:"#8fa0a0", label:"GARAGE"},
      utility:   {bg:"rgba(224,128,80,0.13)",  border:"#e08050", label:"UTILITY"},
      dining:    {bg:"rgba(232,122,58,0.13)",  border:"#e87a3a", label:"DINING"},
      puja_room: {bg:"rgba(200,160,32,0.13)",  border:"#c8a020", label:"PUJA ROOM"},
    };
    const getRoomStyle = (type: string) => {
      const k = Object.keys(ROOM_COLORS).find(k => type.toLowerCase().replace("_","").includes(k.replace("_","")));
      return k ? ROOM_COLORS[k] : {bg:"rgba(13,242,242,0.06)", border:"#0df2f2", label:type.toUpperCase()};
    };

    const windVecLocal = (() => {
      const M: Record<string,[number,number]> = {N:[0,-1],NE:[1,-1],E:[1,0],SE:[1,1],S:[0,1],SW:[-1,1],W:[-1,0],NW:[-1,-1],
        NNE:[0.5,-1],SSW:[-0.5,1],ENE:[1,-0.5],WSW:[-1,0.5],NNW:[-0.5,-1],SSE:[0.5,1]};
      const key = Object.keys(M).find(k => windDir.toUpperCase().startsWith(k)) ?? "SW";
      const [x,z] = M[key]; const l = Math.sqrt(x*x+z*z)||1;
      return {x:x/l, y:z/l};
    })();

    // ── Solar arc ──
    if (showSolarPath) {
      const now2 = new Date(); const h2 = now2.getHours() + now2.getMinutes()/60;
      ctx.save();
      ctx.strokeStyle="rgba(250,160,20,0.55)"; ctx.lineWidth=1.5; ctx.setLineDash([5,4]);
      ctx.beginPath();
      for(let i2=0;i2<=30;i2++){
        const sx2=offX-40+(bw+80)*(i2/30);
        const sy2=offY-55-Math.sin((Math.PI*i2)/30)*42;
        i2===0?ctx.moveTo(sx2,sy2):ctx.lineTo(sx2,sy2);
      }
      ctx.stroke(); ctx.setLineDash([]);
      const sunX2=offX+bw*Math.max(0,Math.min(1,(h2-6)/12));
      const sy2_pos=offY-55-Math.max(0,Math.sin(Math.max(0,(h2-6)*Math.PI/12)))*42;
      ctx.fillStyle="#f59e0b"; ctx.beginPath(); ctx.arc(sunX2,sy2_pos,6,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="rgba(245,158,11,0.5)"; ctx.lineWidth=1.5;
      for(let ri=0;ri<8;ri++){const a3=(ri/8)*Math.PI*2;ctx.beginPath();ctx.moveTo(sunX2+Math.cos(a3)*8,sy2_pos+Math.sin(a3)*8);ctx.lineTo(sunX2+Math.cos(a3)*12,sy2_pos+Math.sin(a3)*12);ctx.stroke();}
      ctx.fillStyle="rgba(255,185,30,0.95)"; ctx.font="8px monospace"; ctx.textAlign="center";
      ctx.fillText(`${now2.getHours().toString().padStart(2,"0")}:${now2.getMinutes().toString().padStart(2,"0")}`,sunX2,sy2_pos-15);
      ctx.restore();
    }

    // ── Plot boundary label ──
    ctx.fillStyle="rgba(13,242,242,0.6)"; ctx.font="8px monospace"; ctx.textAlign="left"; ctx.textBaseline="alphabetic";
    ctx.fillText(`PLOT: ${plotShape.toUpperCase()} — ${plotArea}m²`, offX+2, offY-OWT-12);
    ctx.fillText(`WIND: ${windDir}`, offX+2, offY-OWT-2);

    // ── Outer wall fill (dark building interior) ──
    ctx.fillStyle="#111820";
    ctx.fillRect(offX, offY, bw, bh);

    // ── Room fills ──
    floor1.forEach(room => {
      const rx=px(room.x), ry=py(room.y), rw=ps(room.width), rh=ps(room.height);
      const s=getRoomStyle(room.type);
      ctx.fillStyle=s.bg;
      ctx.fillRect(rx, ry, rw, rh);
    });

    // ── Interior walls (from room edges) ──
    const EPS = 0.08;
    const drawnWalls = new Set<string>();
    floor1.forEach(a => {
      floor1.forEach(b => {
        if (a === b) return;
        // Vertical shared wall: a's right edge == b's left edge
        if (Math.abs((a.x + a.width) - b.x) < EPS) {
          const ov = Math.min(a.y+a.height, b.y+b.height) - Math.max(a.y, b.y);
          if (ov > 0.2) {
            const key = `v:${(a.x+a.width).toFixed(2)}:${Math.min(a.y,b.y).toFixed(2)}`;
            if (!drawnWalls.has(key)) {
              drawnWalls.add(key);
              const wy0 = Math.max(a.y,b.y), wy1 = wy0 + ov;
              ctx.strokeStyle="rgba(13,242,242,0.55)"; ctx.lineWidth=IWT;
              ctx.beginPath(); ctx.moveTo(px(a.x+a.width), py(wy0)); ctx.lineTo(px(a.x+a.width), py(wy1)); ctx.stroke();
            }
          }
        }
        // Horizontal shared wall: a's bottom == b's top
        if (Math.abs((a.y + a.height) - b.y) < EPS) {
          const ov = Math.min(a.x+a.width, b.x+b.width) - Math.max(a.x, b.x);
          if (ov > 0.2) {
            const key = `h:${Math.min(a.x,b.x).toFixed(2)}:${(a.y+a.height).toFixed(2)}`;
            if (!drawnWalls.has(key)) {
              drawnWalls.add(key);
              const wx0 = Math.max(a.x,b.x), wx1 = wx0 + ov;
              ctx.strokeStyle="rgba(13,242,242,0.55)"; ctx.lineWidth=IWT;
              ctx.beginPath(); ctx.moveTo(px(wx0), py(a.y+a.height)); ctx.lineTo(px(wx1), py(a.y+a.height)); ctx.stroke();
            }
          }
        }
      });
    });

    // ── Outer wall border ──
    ctx.strokeStyle="#1a3040"; ctx.lineWidth=OWT*1.1;
    ctx.strokeRect(offX, offY, bw, bh);
    ctx.strokeStyle="rgba(13,242,242,0.9)"; ctx.lineWidth=2.2;
    ctx.strokeRect(offX, offY, bw, bh);

    // ── Doors (swing arcs at room boundaries) ──
    const DOOR_M = 0.8;
    floor1.forEach((room, idx) => {
      const rx=px(room.x), ry=py(room.y), rw=ps(room.width), rh=ps(room.height);
      const dw=Math.min(ps(DOOR_M), rw*0.42, rh*0.42);
      ctx.setLineDash([2,2]); ctx.strokeStyle="rgba(13,242,242,0.5)"; ctx.lineWidth=1.2;
      // Bottom door (interior)
      if (room.y + room.height < maxRY - EPS) {
        const dx=rx+(rw-dw)/2; const dy=ry+rh;
        ctx.fillStyle="#0d1117"; ctx.fillRect(dx, dy-1, dw, 3);
        ctx.beginPath(); ctx.arc(dx, dy, dw, 0, Math.PI/2); ctx.stroke();
      }
      // Right door (alternate rooms)
      if (room.x + room.width < maxRX - EPS && idx%2===1) {
        const dh=Math.min(ps(DOOR_M), rh*0.42);
        const dy2=ry+(rh-dh)/2; const dx2=rx+rw;
        ctx.fillStyle="#0d1117"; ctx.fillRect(dx2-1, dy2, 3, dh);
        ctx.beginPath(); ctx.arc(dx2, dy2, dh, Math.PI/2, Math.PI); ctx.stroke();
      }
      ctx.setLineDash([]);
    });

    // ── Windows (on perimeter rooms only) ──
    floor1.forEach(room => {
      const rx=px(room.x), ry=py(room.y), rw=ps(room.width), rh=ps(room.height);
      const t2=room.type.toLowerCase();
      if (t2.includes("bathroom")||t2.includes("utility")||t2.includes("garage")) return;
      const ww=Math.min(rw*0.5, ps(1.0));
      const wh=Math.min(rh*0.5, ps(0.8));
      const drawWin=(wx:number,wy:number,wWidth:number,wHeight:number) => {
        ctx.fillStyle="rgba(64,180,248,0.5)"; ctx.fillRect(wx,wy,wWidth,wHeight);
        ctx.strokeStyle="#40b8f8"; ctx.lineWidth=1.8; ctx.strokeRect(wx,wy,wWidth,wHeight);
        ctx.beginPath(); ctx.moveTo(wx+wWidth/2,wy); ctx.lineTo(wx+wWidth/2,wy+wHeight); ctx.stroke();
      };
      // Perimeter windows only
      if (room.y - minRY < EPS)   drawWin(rx+(rw-ww)/2, ry-OWT*0.5, ww, OWT*0.7);
      if (maxRY-(room.y+room.height) < EPS) drawWin(rx+(rw-ww)/2, ry+rh-OWT*0.2, ww, OWT*0.7);
      if (room.x - minRX < EPS)   drawWin(rx-OWT*0.5, ry+(rh-wh)/2, OWT*0.7, wh);
      if (maxRX-(room.x+room.width) < EPS) drawWin(rx+rw-OWT*0.2, ry+(rh-wh)/2, OWT*0.7, wh);
    });

    // ── Entrance (bottom centre) ──
    const entrW=ps(0.9);
    const entrX=offX+bw/2-entrW/2;
    ctx.fillStyle="#0d1117"; ctx.fillRect(entrX, offY+bh-1, entrW, OWT+3);
    ctx.strokeStyle="#0df2f2"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(entrX,offY+bh); ctx.lineTo(entrX,offY+bh+OWT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(entrX+entrW,offY+bh); ctx.lineTo(entrX+entrW,offY+bh+OWT); ctx.stroke();
    ctx.strokeStyle="rgba(13,242,242,0.6)"; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.arc(entrX+entrW,offY+bh,entrW,Math.PI,Math.PI*1.5); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle="#0df2f2"; ctx.font=`bold ${Math.max(7,SCALE*0.48)}px 'Space Grotesk',monospace`;
    ctx.textAlign="center"; ctx.textBaseline="alphabetic";
    ctx.fillText("ENTRANCE", offX+bw/2, offY+bh+OWT+18);

    // ── Room labels + dimensions ──
    floor1.forEach(room => {
      const rx=px(room.x), ry=py(room.y), rw=ps(room.width), rh=ps(room.height);
      const s=getRoomStyle(room.type);
      const cx2=rx+rw/2; const cy2=ry+rh/2;
      const fz=Math.max(7,Math.min(12,rw/8));
      ctx.fillStyle=s.border; ctx.font=`bold ${fz}px 'Space Grotesk',sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(s.label, cx2, cy2-fz*0.7);
      ctx.fillStyle="rgba(180,200,220,0.8)"; ctx.font=`${Math.max(6,fz-2)}px monospace`;
      ctx.fillText(`${room.width.toFixed(2)} x ${room.height.toFixed(2)}`, cx2, cy2+fz*0.4);
      if (room.orientation) {
        ctx.fillStyle="rgba(13,242,242,0.5)"; ctx.font=`${Math.max(5,fz-3)}px monospace`;
        ctx.fillText(room.orientation, cx2, cy2+fz*1.4);
      }
    });

    // ── Wind particles — flow OVER the building from outside ──
    if (showWindFlow) {
      // Spawn particles OUTSIDE the building, flowing across it
      if (windParticles.current.length < 35) {
        for (let i=0; i<2; i++) {
          let spawnX: number, spawnY: number;
          // Spawn on the windward face OUTSIDE the building
          if (Math.abs(windVecLocal.x) >= Math.abs(windVecLocal.y)) {
            // Wind blowing left/right — spawn on left or right face, well outside
            spawnX = windVecLocal.x > 0 ? offX - ps(1.5) - Math.random()*ps(1) : offX + bw + ps(0.5) + Math.random()*ps(1);
            spawnY = offY - ps(0.5) + Math.random() * (bh + ps(1));
          } else {
            // Wind blowing up/down — spawn on top or bottom face, well outside
            spawnX = offX - ps(0.5) + Math.random() * (bw + ps(1));
            spawnY = windVecLocal.y > 0 ? offY - ps(1.5) - Math.random()*ps(1) : offY + bh + ps(0.5) + Math.random()*ps(1);
          }
          windParticles.current.push({x:spawnX, y:spawnY, life:0, speed:1.8+Math.random()*1.2, alpha:0});
        }
      }
      // Kill old particles and those that have crossed the full building
      windParticles.current = windParticles.current.filter(p => {
        if (p.life >= 100) return false;
        // Kill when 2 building-widths past the leeward edge
        const pastLeeward =
          (windVecLocal.x > 0.1 && p.x > offX + bw + ps(2)) ||
          (windVecLocal.x < -0.1 && p.x < offX - ps(2)) ||
          (windVecLocal.y > 0.1 && p.y > offY + bh + ps(2)) ||
          (windVecLocal.y < -0.1 && p.y < offY - ps(2));
        return !pastLeeward;
      });

      windParticles.current.forEach(p => {
        p.life++;
        p.x += windVecLocal.x * p.speed * 1.6;
        p.y += windVecLocal.y * p.speed * 1.6;
        const fade = Math.sin(p.life/100*Math.PI); p.alpha = fade * 0.85;
        const len = p.speed * 9;
        const ex = p.x - windVecLocal.x*len; const ey = p.y - windVecLocal.y*len;
        ctx.strokeStyle=`rgba(60,160,240,${p.alpha})`; ctx.lineWidth=1.5; ctx.lineCap="round";
        ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(p.x,p.y); ctx.stroke();
        const angle=Math.atan2(windVecLocal.y,windVecLocal.x);
        ctx.fillStyle=`rgba(80,180,255,${p.alpha})`;
        ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(angle);
        ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-5,-2.5); ctx.lineTo(-5,2.5); ctx.closePath(); ctx.fill();
        ctx.restore();
      });
    }

    // ── North arrow ──
    const narX=W-38; const narY=H-58;
    ctx.fillStyle="#0df2f2"; ctx.font="bold 10px monospace"; ctx.textAlign="center"; ctx.textBaseline="alphabetic";
    ctx.fillText("N", narX, narY-22);
    ctx.beginPath(); ctx.moveTo(narX,narY-18); ctx.lineTo(narX-6,narY+4); ctx.lineTo(narX,narY+2); ctx.lineTo(narX+6,narY+4); ctx.closePath();
    ctx.fillStyle="#0df2f2"; ctx.fill(); ctx.strokeStyle="#0df2f2"; ctx.lineWidth=1; ctx.stroke();

    // ── Scale bar ──
    const sbPx=SCALE*5;
    ctx.fillStyle="rgba(13,242,242,0.7)"; ctx.fillRect(20,H-18,sbPx,2);
    ctx.fillRect(20,H-22,2,6); ctx.fillRect(20+sbPx-2,H-22,2,6);
    ctx.font="7px monospace"; ctx.textAlign="left"; ctx.fillStyle="rgba(13,242,242,0.5)";
    ctx.textBaseline="alphabetic";
    ctx.fillText("0",20,H-5); ctx.fillText("5m",20+sbPx+2,H-5);
    ctx.textAlign="right"; ctx.fillText(`${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E`,W-20,H-18);

    // ── Trees ──
    trees.slice(0,3).forEach((_,i) => {
      const ttx=offX-35-i*20; const tty=offY+bh*0.25+i*24;
      ctx.beginPath(); ctx.arc(ttx,tty,11,0,Math.PI*2);
      ctx.fillStyle="rgba(40,200,80,0.15)"; ctx.fill();
      ctx.strokeStyle="#30d060"; ctx.lineWidth=1.5; ctx.stroke();
      ctx.fillStyle="#30d060"; ctx.font="7px monospace"; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(`T${i+1}`,ttx,tty);
    });

  }, [rooms, trees, lat, lon, showSolarPath, showWindFlow, plotShape, plotArea, windDir, windParticles]);

  useEffect(() => {
    let running = true;
    const loop = (t: number) => {
      if(!running) return;
      draw(t);
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw]);

  return <canvas ref={canvasRef} className="w-full h-full" style={{ display: "block" }} />;
}

// ── Main Page ─────────────────────────────────────────────────────────────────
function BlueprintCanvas({ rooms, walls, doors, windows, trees, lat, lon, zoom, showSolarPath, showWindFlow, showEcoOverlay, ecoAudit, floodProbability, floorPlan, plotShape, plotArea, windDir, windSpeed, windDirectionDeg, sunAzimuthDeg, sunElevationDeg, variantKey, algorithmName, convergenceCurve }:
  { rooms: Room[]; walls: Wall[]; doors: Door[]; windows: WindowEl[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; showEcoOverlay: boolean; ecoAudit: EcoAuditReportSchema | null; floodProbability: number; floorPlan: any; plotShape: string; plotArea: number; windDir: string; windSpeed: number; windDirectionDeg?: number; sunAzimuthDeg?: number; sunElevationDeg?: number; variantKey: number; algorithmName?: string; convergenceCurve?: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const windParticles = useRef<Array<{x:number;y:number;life:number;speed:number;alpha:number}>>([]);
  const windPulseRef = useRef({ burstUntil: 0, nextBurstAt: 0 });
  const transitionStartRef = useRef<number>(performance.now());
  const activeAudit = useEco3DStore((s) => s.activeAudit) ?? ecoAudit;
  const activeRooms = useEco3DStore((s) => s.activeRooms) as unknown as Room[];
  const activeWalls = useEco3DStore((s) => s.activeWalls) as unknown as Wall[];
  const activeWindows = useEco3DStore((s) => s.activeWindows) as unknown as WindowEl[];

  const getRoomStyle = useCallback((type: string) => {
    const k = Object.keys(BLUEPRINT_ROOM_STYLE_MAP).find(k =>
      type.toLowerCase().replace("_","").includes(k.replace("_",""))
    );
    return k ? BLUEPRINT_ROOM_STYLE_MAP[k] : {bg:"rgba(13,242,242,0.06)", border:"#0df2f2"};
  }, []);
  const getRoomFill = useCallback((type: string) => getRoomStyle(type).bg, [getRoomStyle]);
  const getRoomHatch = useCallback((type: string) => {
    const k = Object.keys(BLUEPRINT_ROOM_HATCH_MAP).find(k => type.toLowerCase().replace("_","").includes(k.replace("_","")));
    return k ? BLUEPRINT_ROOM_HATCH_MAP[k] : false;
  }, []);
  const getRoomLabel = useCallback((type: string) => {
    const k = Object.keys(BLUEPRINT_ROOM_LABEL_MAP).find(k => type.toLowerCase().replace("_","").includes(k.replace("_","")));
    return k ? BLUEPRINT_ROOM_LABEL_MAP[k] : type.replace(/_/g," ").toUpperCase();
  }, []);
  const getDisplayLabel = useCallback((room: Room) => {
    const match = room.id?.match(/_(\d+)$/);
    const base = getRoomLabel(room.type);
    if (match && (room.type.includes("bedroom") || room.type.includes("bathroom"))) {
      return `${base} ${match[1]}`;
    }
    return base;
  }, [getRoomLabel]);
  const getShortLabel = useCallback((room: Room) => {
    const label = getDisplayLabel(room);
    if (label.includes("LIVING")) return "LIVING";
    if (label.includes("DINING")) return "DINING";
    if (label.includes("KITCHEN")) return "KITCHEN";
    if (label.includes("BEDROOM")) return room.id?.match(/_(\d+)$/) ? `BED ${room.id.match(/_(\d+)$/)?.[1]}` : "BED";
    if (label.includes("BATHROOM")) return room.id?.match(/_(\d+)$/) ? `BATH ${room.id.match(/_(\d+)$/)?.[1]}` : "BATH";
    if (label.includes("STUDY")) return "STUDY";
    if (label.includes("UTILITY")) return "UTILITY";
    if (label.includes("GARAGE")) return "GARAGE";
    if (label.includes("PUJA")) return "PUJA";
    return label;
  }, [getDisplayLabel]);
  const parseWindowWall = useCallback((wallId: string) => {
    const parts = wallId.split("_");
    if (parts[parts.length - 1] === "vent") {
      return { roomId: parts.slice(0, -2).join("_"), edge: parts[parts.length - 2], isVent: true };
    }
    return { roomId: parts.slice(0, -1).join("_"), edge: parts[parts.length - 1], isVent: false };
  }, []);
  const drawFurniture = useCallback((ctx: CanvasRenderingContext2D, room: Room, rx: number, ry: number, rw: number, rh: number, color: string) => {
    if (rw < 34 || rh < 24) return;
    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = `${color}22`;
    ctx.lineWidth = 1;
    if (room.type.includes("living")) {
      const sw = Math.min(rw * 0.5, 54);
      const sh = Math.min(rh * 0.26, 18);
      ctx.strokeRect(cx - sw / 2, cy - sh / 2, sw, sh);
      ctx.strokeRect(cx - sw / 2 - 8, cy - sh / 2 + 2, 8, sh - 4);
      ctx.strokeRect(cx + sw / 2, cy - sh / 2 + 2, 8, sh - 4);
      ctx.beginPath(); ctx.arc(cx, cy + sh * 0.95, 5, 0, Math.PI * 2); ctx.stroke();
    } else if (room.type.includes("dining")) {
      const tw = Math.min(rw * 0.42, 42);
      const th = Math.min(rh * 0.28, 24);
      ctx.strokeRect(cx - tw / 2, cy - th / 2, tw, th);
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([mx,my]) => {
        ctx.beginPath(); ctx.arc(cx + mx * (tw / 2 + 5), cy + my * (th / 2 + 4), 3.5, 0, Math.PI * 2); ctx.stroke();
      });
    } else if (room.type.includes("bedroom")) {
      const bw = Math.min(rw * 0.5, 42);
      const bh = Math.min(rh * 0.38, 28);
      ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, bh);
      ctx.strokeRect(cx - bw / 2, cy - bh / 2, bw, 7);
      ctx.strokeRect(cx - bw / 2 + 4, cy - bh / 2 + 1, bw / 2 - 6, 5);
      ctx.strokeRect(cx + 2, cy - bh / 2 + 1, bw / 2 - 6, 5);
    } else if (room.type.includes("kitchen")) {
      const counterH = Math.min(rh * 0.18, 12);
      ctx.strokeRect(rx + 6, ry + 6, rw - 12, counterH);
      ctx.strokeRect(rx + 6, ry + rh - counterH - 6, rw - 12, counterH);
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeRect(cx - 10, cy - 8, 20, 16);
    } else if (room.type.includes("bathroom")) {
      ctx.beginPath(); ctx.arc(cx - 8, cy - 2, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeRect(cx + 3, cy - 7, 14, 14);
      ctx.strokeRect(cx - 16, cy + 8, 32, 6);
    } else if (room.type.includes("office")) {
      ctx.strokeRect(cx - 18, cy - 8, 36, 16);
      ctx.strokeRect(cx - 12, cy + 10, 24, 5);
      ctx.beginPath(); ctx.arc(cx + 16, cy + 8, 4, 0, Math.PI * 2); ctx.stroke();
    } else if (room.type.includes("garage")) {
      ctx.strokeRect(cx - 24, cy - 10, 48, 20);
      ctx.beginPath(); ctx.arc(cx - 14, cy + 12, 4, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + 14, cy + 12, 4, 0, Math.PI * 2); ctx.stroke();
    } else if (room.type.includes("utility")) {
      ctx.beginPath(); ctx.arc(cx - 8, cy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx - 8, cy, 2, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeRect(cx + 4, cy - 9, 14, 18);
    } else if (room.type.includes("puja")) {
      ctx.strokeRect(cx - 12, cy - 10, 24, 20);
      ctx.beginPath(); ctx.moveTo(cx - 15, cy - 10); ctx.lineTo(cx, cy - 18); ctx.lineTo(cx + 15, cy - 10); ctx.stroke();
    }
    ctx.restore();
  }, []);

  const windVec = useMemo(() => getWindProfile(windDir, windSpeed, windDirectionDeg), [windDir, windSpeed, windDirectionDeg]);

  useEffect(() => {
    transitionStartRef.current = performance.now();
  }, [variantKey]);

  useEffect(() => {
    windParticles.current = [];
    windPulseRef.current = { burstUntil: 0, nextBurstAt: 0 };
  }, [windVec.label, windVec.speed]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.offsetWidth || 900;
    const H = canvas.offsetHeight || 700;
    canvas.width = W; canvas.height = H;

    // ── White paper background (professional CAD look) ──
    ctx.fillStyle = "#0b1416";
    ctx.fillRect(0, 0, W, H);

    // ── Light grey grid (like CAD grid paper) ──
    const GRID = 20;
    ctx.strokeStyle = "rgba(13,242,242,0.055)"; ctx.lineWidth = 0.4;
    for (let gx=0; gx<W; gx+=GRID) { ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
    for (let gy=0; gy<H; gy+=GRID) { ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }
    ctx.strokeStyle = "rgba(13,242,242,0.10)"; ctx.lineWidth = 0.6;
    for (let gx=0; gx<W; gx+=GRID*5) { ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
    for (let gy=0; gy<H; gy+=GRID*5) { ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }

    const renderedRooms = activeRooms.length > 0 ? activeRooms : rooms;
    const renderedWalls = activeWalls.length > 0 ? activeWalls : walls;
    const renderedWindows = activeWindows.length > 0 ? activeWindows : windows;

    const floor1 = renderedRooms.filter(r => (r.floor??1)===1);
    const floorWalls = renderedWalls.filter(w => (w.floor??1)===1);
    const floorDoors = doors.filter(d => (d.floor??1)===1);
    const floorWindows = renderedWindows.filter(w => (w.floor??1)===1);

    if (floor1.length === 0) {
      ctx.fillStyle = "#0df2f2"; ctx.font = "bold 15px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("AWAITING FLOOR PLAN GENERATION", W/2, H/2-10);
      ctx.fillStyle = "rgba(13,242,242,0.5)"; ctx.font = "12px sans-serif";
      ctx.fillText("Configure settings and generate", W/2, H/2+14);
      return;
    }

    const minX = Math.min(...floor1.map(r=>r.x));
    const minY = Math.min(...floor1.map(r=>r.y));
    const maxX = Math.max(...floor1.map(r=>r.x+r.width));
    const maxY = Math.max(...floor1.map(r=>r.y+r.height));
    const MARGIN_L=90, MARGIN_R=60, MARGIN_T=showSolarPath?120:80, MARGIN_B=70;
    const baseScale = Math.min(
      (W-MARGIN_L-MARGIN_R) / Math.max(maxX-minX, 0.1),
      (H-MARGIN_T-MARGIN_B) / Math.max(maxY-minY, 0.1)
    );
    const zoomFactor = Math.min(2.6, Math.max(0.55, Math.pow(1.08, zoom - 14)));
    const scale = baseScale * zoomFactor;
    const bw = (maxX-minX)*scale;
    const bh = (maxY-minY)*scale;
    const offX = MARGIN_L + (W-MARGIN_L-MARGIN_R-bw)/2;
    const offY = MARGIN_T + (H-MARGIN_T-MARGIN_B-bh)/2;

    const px = (x:number) => offX + (x-minX)*scale;
    const py = (y:number) => offY + (y-minY)*scale;
    const ps = (v:number) => v*scale;

    // ── Solar arc (live sun position) ──
    if (showSolarPath) {
      const now = new Date();
      const arcY = offY - 36; const arcAmp = 28;
      ctx.save();
      ctx.strokeStyle = "rgba(220,140,20,0.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]);
      ctx.beginPath();
      for (let i=0; i<=30; i++) {
        const sx = offX + bw*(i/30);
        const sy = arcY - Math.sin((Math.PI*i)/30)*arcAmp;
        i===0 ? ctx.moveTo(sx,sy) : ctx.lineTo(sx,sy);
      }
      ctx.stroke(); ctx.setLineDash([]);
      // E/W labels
      ctx.fillStyle = "rgba(160,120,40,0.7)"; ctx.font = "bold 9px monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("EAST", offX, arcY); ctx.fillText("WEST", offX+bw, arcY);
      const safeAzimuth = typeof sunAzimuthDeg === "number" && Number.isFinite(sunAzimuthDeg) ? sunAzimuthDeg : 180;
      const safeElevation = typeof sunElevationDeg === "number" && Number.isFinite(sunElevationDeg) ? sunElevationDeg : 0;
      const prog = Math.max(0, Math.min(1, (safeAzimuth - 90) / 180));
      const elevRatio = Math.max(0, Math.min(1, safeElevation / 90));
      const sunX = offX + bw*prog;
      const sunY = arcY - elevRatio * arcAmp;
      // Sun glow
      const grad = ctx.createRadialGradient(sunX,sunY,2,sunX,sunY,14);
      grad.addColorStop(0,"rgba(255,230,0,0.6)"); grad.addColorStop(1,"rgba(255,180,0,0)");
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(sunX,sunY,14,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = "#f59e0b"; ctx.beginPath(); ctx.arc(sunX,sunY,5,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="rgba(245,158,11,0.6)"; ctx.lineWidth=1.2;
      for (let i=0;i<8;i++){const a=(i/8)*Math.PI*2;ctx.beginPath();ctx.moveTo(sunX+Math.cos(a)*7,sunY+Math.sin(a)*7);ctx.lineTo(sunX+Math.cos(a)*11,sunY+Math.sin(a)*11);ctx.stroke();}
      ctx.fillStyle="rgba(200,120,0,0.9)"; ctx.font="bold 8px monospace"; ctx.textAlign="center";
      ctx.fillText(`${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")} · ${safeAzimuth.toFixed(0)}°`,sunX,sunY-17);
      ctx.restore();
    }

    const fadeAlpha = Math.max(0, Math.min(1, (performance.now() - transitionStartRef.current) / 400));

    if (algorithmName) {
      ctx.save();
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.font = "bold 12px monospace";
      ctx.fillStyle = "rgba(0,220,255,0.4)";
      ctx.fillText(algorithmName.toUpperCase(), W - 14, 12);
      ctx.restore();
    }

    // ── PASS 1: Room fills ──
    ctx.save();
    ctx.globalAlpha = fadeAlpha;
    floor1.forEach(room => {
      const rx=px(room.x), ry=py(room.y), rw=ps(room.width), rh=ps(room.height);
      ctx.fillStyle = getRoomFill(room.type);
      ctx.fillRect(rx, ry, rw, rh);

      // Diagonal hatch for wet/service rooms (architectural convention)
      if (getRoomHatch(room.type) && rw>14 && rh>14) {
        ctx.save();
        ctx.beginPath(); ctx.rect(rx,ry,rw,rh); ctx.clip();
        ctx.strokeStyle = "rgba(120,100,160,0.12)"; ctx.lineWidth = 0.6;
        for (let d=-(rw+rh); d<rw+rh; d+=8) {
          ctx.beginPath(); ctx.moveTo(rx+d,ry); ctx.lineTo(rx+d+rh,ry+rh); ctx.stroke();
        }
        ctx.restore();
      }
    });
    ctx.restore();

    // ── PASS 2: Walls (thick architectural style) ──
    const EXT_WALL = Math.max(8, ps(0.23));
    const INT_WALL = Math.max(3.5, ps(0.12));

    if (floorWalls.length > 0) {
      floorWalls.forEach(wall => {
        const horiz = wall.orientation === "horizontal";
        const wLen = ps(wall.length);
        const wThk = horiz ? Math.max(4, ps(wall.thickness)) : wLen;
        const wHgt = horiz ? wLen : Math.max(4, ps(wall.thickness));
        // x,y is the midpoint of the wall
        const wx = px(wall.x) - (horiz ? wLen/2 : Math.max(4,ps(wall.thickness))/2);
        const wy = py(wall.y) - (horiz ? Math.max(4,ps(wall.thickness))/2 : wLen/2);
        const ww = horiz ? wLen : Math.max(4, ps(wall.thickness));
        const wh = horiz ? Math.max(4, ps(wall.thickness)) : wLen;
        const ext = wall.type === "exterior";
        // Solid dark grey fill (standard CAD wall style)
        ctx.fillStyle = ext ? "#2a3a3a" : "#3d4d4d";
        ctx.fillRect(wx, wy, ww, wh);
        // Hatch exterior walls (concrete indication)
        if (ext && ww>4 && wh>4) {
          ctx.save();
          ctx.beginPath(); ctx.rect(wx,wy,ww,wh); ctx.clip();
          ctx.strokeStyle="rgba(255,255,255,0.15)"; ctx.lineWidth=0.5;
          for (let d=-(ww+wh); d<ww+wh; d+=4) {
            ctx.beginPath(); ctx.moveTo(wx+d,wy); ctx.lineTo(wx+d+wh,wy+wh); ctx.stroke();
          }
          ctx.restore();
        }
        ctx.strokeStyle = ext ? "#1a2828" : "#2a3838";
        ctx.lineWidth = ext ? 0.8 : 0.5;
        ctx.strokeRect(wx,wy,ww,wh);
        if (ext) {
          ctx.strokeStyle = "rgba(13,242,242,0.7)";
          ctx.lineWidth = 1;
          ctx.strokeRect(wx, wy, ww, wh);
        }
      });
    } else {
      // Fallback: derive actual wall runs from room geometry instead of boxing everything.
      const EPS = 0.09;
      const drawn = new Set<string>();
      floor1.forEach(room => {
        [
          { edge: "top", x1: room.x, y1: room.y, x2: room.x + room.width, y2: room.y },
          { edge: "bottom", x1: room.x, y1: room.y + room.height, x2: room.x + room.width, y2: room.y + room.height },
          { edge: "left", x1: room.x, y1: room.y, x2: room.x, y2: room.y + room.height },
          { edge: "right", x1: room.x + room.width, y1: room.y, x2: room.x + room.width, y2: room.y + room.height },
        ].forEach(({ edge, x1, y1, x2, y2 }) => {
          const key = `${x1.toFixed(2)}:${y1.toFixed(2)}:${x2.toFixed(2)}:${y2.toFixed(2)}`;
          const rev = `${x2.toFixed(2)}:${y2.toFixed(2)}:${x1.toFixed(2)}:${y1.toFixed(2)}`;
          if (drawn.has(key) || drawn.has(rev)) return;
          drawn.add(key);
          const shared = floor1.some(other => other.id !== room.id && (
            ((edge === "top" || edge === "bottom") &&
              (Math.abs(y1 - other.y) < EPS || Math.abs(y1 - (other.y + other.height)) < EPS) &&
              Math.min(x2, other.x + other.width) - Math.max(x1, other.x) > 0.25) ||
            ((edge === "left" || edge === "right") &&
              (Math.abs(x1 - other.x) < EPS || Math.abs(x1 - (other.x + other.width)) < EPS) &&
              Math.min(y2, other.y + other.height) - Math.max(y1, other.y) > 0.25)
          ));
          const horizontal = edge === "top" || edge === "bottom";
          const ww = horizontal ? ps(Math.abs(x2 - x1)) : (shared ? INT_WALL : EXT_WALL);
          const wh = horizontal ? (shared ? INT_WALL : EXT_WALL) : ps(Math.abs(y2 - y1));
          const wx = horizontal ? px(Math.min(x1, x2)) : px(x1) - ww / 2;
          const wy = horizontal ? py(y1) - wh / 2 : py(Math.min(y1, y2));
          ctx.fillStyle = shared ? "#3d4d4d" : "#243838";
          ctx.fillRect(wx, wy, ww, wh);
          ctx.strokeStyle = shared ? "#2a3838" : "rgba(13,242,242,0.7)";
          ctx.lineWidth = shared ? 0.6 : 1;
          ctx.strokeRect(wx, wy, ww, wh);
        });
      });
    }

    // ── PASS 3: Doors (proper architectural swing arcs) ──
    floorDoors.forEach(door => {
      const span = ps(door.width);
      const wallT = Math.max(4, ps(0.15));
      ctx.strokeStyle = "rgba(13,242,242,0.8)"; ctx.lineWidth = 1.2;
      if (door.orientation === "horizontal") {
        const dx = px(door.x) - span/2;
        const dy = py(door.y) - wallT/2;
        // Clear the door opening in the wall
        ctx.fillStyle="#0e1c1c"; ctx.fillRect(dx, dy-2, span, wallT+4);
        // Door leaf (solid line)
        ctx.strokeStyle="#1a3030"; ctx.lineWidth=1.4;
        ctx.beginPath(); ctx.moveTo(dx,dy+wallT/2); ctx.lineTo(dx+span,dy+wallT/2); ctx.stroke();
        // Swing arc (dashed quarter circle)
        ctx.strokeStyle="rgba(30,80,80,0.55)"; ctx.lineWidth=0.9; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.arc(dx, dy+wallT/2, span, 0, Math.PI/2); ctx.stroke();
        ctx.setLineDash([]);
        // Door type indicator
        if (door.symbol === "double_door") {
          ctx.strokeStyle="rgba(30,80,80,0.55)"; ctx.lineWidth=0.9; ctx.setLineDash([3,3]);
          ctx.beginPath(); ctx.arc(dx+span, dy+wallT/2, span, Math.PI/2, Math.PI); ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        const dy = py(door.y) - span/2;
        const dx = px(door.x) - wallT/2;
        ctx.fillStyle="#0e1c1c"; ctx.fillRect(dx-2, dy, wallT+4, span);
        ctx.strokeStyle="rgba(13,242,242,0.85)"; ctx.lineWidth=1.3;
        ctx.beginPath(); ctx.moveTo(dx+wallT/2,dy); ctx.lineTo(dx+wallT/2,dy+span); ctx.stroke();
        ctx.strokeStyle="rgba(13,242,242,0.4)"; ctx.lineWidth=0.9; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.arc(dx+wallT/2, dy, span, Math.PI/2, Math.PI); ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // ── PASS 4: Windows (professional architectural style) ──
    const drawCADWindow = (wx:number, wy:number, ww:number, wh:number, horiz:boolean) => {
      // Clear opening in wall
      ctx.fillStyle="#0e1c1c"; ctx.fillRect(wx-1,wy-1,ww+2,wh+2);
      // Glass pane — bright translucent blue on dark bg
      ctx.fillStyle="rgba(100,200,255,0.22)"; ctx.fillRect(wx,wy,ww,wh);
      // Frame lines (double line = architectural window symbol)
      ctx.strokeStyle="rgba(130,210,255,0.85)"; ctx.lineWidth=1.0;
      ctx.strokeRect(wx,wy,ww,wh);
      // Centre line
      ctx.strokeStyle="#1a4060"; ctx.lineWidth=0.6;
      if(horiz) {
        ctx.beginPath(); ctx.moveTo(wx,wy+wh/2); ctx.lineTo(wx+ww,wy+wh/2); ctx.stroke();
        // Frame subdivisions (2-pane window)
        ctx.beginPath(); ctx.moveTo(wx+ww/2,wy); ctx.lineTo(wx+ww/2,wy+wh); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(wx+ww/2,wy); ctx.lineTo(wx+ww/2,wy+wh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(wx,wy+wh/2); ctx.lineTo(wx+ww,wy+wh/2); ctx.stroke();
      }
      // Sill lines (short ticks at window ends)
      ctx.strokeStyle="rgba(130,210,255,0.75)"; ctx.lineWidth=1.2;
      if(horiz){
        ctx.beginPath(); ctx.moveTo(wx,wy-2); ctx.lineTo(wx,wy+wh+2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(wx+ww,wy-2); ctx.lineTo(wx+ww,wy+wh+2); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(wx-2,wy); ctx.lineTo(wx+ww+2,wy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(wx-2,wy+wh); ctx.lineTo(wx+ww+2,wy+wh); ctx.stroke();
      }
    };

    const wallT = Math.max(4, ps(0.23));
    floorWindows.forEach(win => {
      const { roomId, edge, isVent } = parseWindowWall(win.wall);
      const room = floor1.find(r => r.id===roomId);
      if (!room) return;
      const span = ps(win.width) * (isVent ? 0.92 : 1);
      if (span < 6) return;
      if (edge==="top")    drawCADWindow(px(room.x+room.width/2)-span/2, py(room.y)-wallT/2,    span, wallT, true);
      if (edge==="bottom") drawCADWindow(px(room.x+room.width/2)-span/2, py(room.y+room.height)-wallT/2, span, wallT, true);
      if (edge==="left")   drawCADWindow(px(room.x)-wallT/2, py(room.y+room.height/2)-span/2, wallT, span, false);
      if (edge==="right")  drawCADWindow(px(room.x+room.width)-wallT/2, py(room.y+room.height/2)-span/2, wallT, span, false);
    });

    // Minimal glass room tags
    floor1.forEach(room => {
      const rx=px(room.x), ry=py(room.y), rw=ps(room.width), rh=ps(room.height);
      const cx=rx+rw/2, cy=ry+rh/2;
      drawFurniture(ctx, room, rx, ry, rw, rh, `${getRoomStyle(room.type).border}aa`);
      if (rw < 18 || rh < 12) return;

      const style = getRoomStyle(room.type);
      const isCompact = rw < 120 || rh < 82;
      const lbl = isCompact ? getShortLabel(room) : getDisplayLabel(room);
      const fs = isCompact ? Math.max(6.6, Math.min(8.4, rw/13.5)) : Math.max(7.4, Math.min(9.4, rw/11.2));
      const subFs = Math.max(5.7, fs - 1.1);
      const dimFs = Math.max(5.2, fs - 1.9);
      ctx.font = `bold ${fs}px 'Space Grotesk', sans-serif`;
      const blockW = Math.min(rw - 12, Math.max(ctx.measureText(lbl).width + 12, isCompact ? 44 : 70));
      const blockH = isCompact ? 18 : 26;
      const blockX = rx + 6;
      const blockY = ry + 6;
      if (blockW > 28 && rh > 22) {
        ctx.fillStyle = "rgba(18, 29, 34, 0.42)";
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.roundRect(blockX, blockY, blockW, blockH, 6);
        ctx.fill();
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = "rgba(241,245,249,0.94)";
        ctx.fillText(lbl, blockX + 5, blockY + 3.5);

        const areaLabel = `${(room.width*room.height).toFixed(1)} sqm`;
        ctx.font = `bold ${subFs}px monospace`;
        ctx.fillStyle = "rgba(103,232,249,0.88)";
        ctx.fillText(areaLabel, blockX + 5, blockY + fs + 3.5);

        if (!isCompact && rh > 58) {
          const dimLabel = `${room.width.toFixed(1)} x ${room.height.toFixed(1)} m`;
          ctx.font = `${dimFs}px monospace`;
          ctx.fillStyle = "rgba(203,213,225,0.72)";
          ctx.fillText(dimLabel, blockX + 5, blockY + fs + subFs + 4.5);
        }
      }

      if (room.orientation && rw>38) {
        const tagW = Math.min(rw*0.36, 34); const tagH = 9;
        const tagX = cx-tagW/2; const tagY = cy+fs*1.2;
        const orientColors: Record<string,string> = {
          S:'#e8a020',N:'#2080d0',E:'#20a060',W:'#a04020',SE:'#c08030',SW:'#8060a0',NE:'#30c080',NW:'#4060c0'
        };
        const tc = orientColors[room.orientation] ?? '#607080';
        ctx.fillStyle='rgba(18, 29, 34, 0.34)'; ctx.beginPath();
        ctx.roundRect(tagX,tagY,tagW,tagH,5); ctx.fill();
        ctx.strokeStyle=tc+'44'; ctx.lineWidth=0.45;
        ctx.beginPath(); ctx.roundRect(tagX,tagY,tagW,tagH,5); ctx.stroke();
        ctx.fillStyle=tc; ctx.font=`bold ${Math.max(4.8,fs-2.4)}px monospace`;
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(room.orientation, cx, tagY+4.5);
      }
    });

    // ── PASS 6: Dimension lines (CAD style) ──
    const DL_OFF = 18; // dimension line offset from wall in px
    const DL_EXT = 6;  // extension line length
    const drawDimLine = (x1:number,y1:number,x2:number,y2:number,label:string,offset:number,horizontal:boolean) => {
      ctx.strokeStyle="rgba(13,242,242,0.6)"; ctx.lineWidth=0.7;
      // Extension lines
      if(horizontal){
        ctx.beginPath();ctx.moveTo(x1,y1-DL_EXT);ctx.lineTo(x1,y1+offset+DL_EXT);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x2,y1-DL_EXT);ctx.lineTo(x2,y1+offset+DL_EXT);ctx.stroke();
        // Dimension line with arrows
        ctx.beginPath();ctx.moveTo(x1,y1+offset);ctx.lineTo(x2,y1+offset);ctx.stroke();
        // Arrowheads
        ctx.fillStyle="rgba(13,242,242,0.7)";
        ctx.beginPath();ctx.moveTo(x1,y1+offset);ctx.lineTo(x1+5,y1+offset-3);ctx.lineTo(x1+5,y1+offset+3);ctx.closePath();ctx.fill();
        ctx.beginPath();ctx.moveTo(x2,y1+offset);ctx.lineTo(x2-5,y1+offset-3);ctx.lineTo(x2-5,y1+offset+3);ctx.closePath();ctx.fill();
        ctx.fillStyle="rgba(13,242,242,0.7)"; ctx.font="bold 8px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
        ctx.fillText(label,(x1+x2)/2,y1+offset-1);
      } else {
        ctx.beginPath();ctx.moveTo(x1-DL_EXT,y1);ctx.lineTo(x1+offset+DL_EXT,y1);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x1-DL_EXT,y2);ctx.lineTo(x1+offset+DL_EXT,y2);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x1+offset,y1);ctx.lineTo(x1+offset,y2);ctx.stroke();
        ctx.fillStyle="rgba(13,242,242,0.7)";
        ctx.beginPath();ctx.moveTo(x1+offset,y1);ctx.lineTo(x1+offset-3,y1+5);ctx.lineTo(x1+offset+3,y1+5);ctx.closePath();ctx.fill();
        ctx.beginPath();ctx.moveTo(x1+offset,y2);ctx.lineTo(x1+offset-3,y2-5);ctx.lineTo(x1+offset+3,y2-5);ctx.closePath();ctx.fill();
        ctx.save(); ctx.translate(x1+offset+10, (y1+y2)/2); ctx.rotate(-Math.PI/2);
        ctx.fillStyle="rgba(13,242,242,0.7)"; ctx.font="bold 8px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
        ctx.fillText(label,0,0); ctx.restore();
      }
    };
    // Overall building dimensions
    const totalW_m = (maxX-minX).toFixed(2);
    const totalH_m = (maxY-minY).toFixed(2);
    drawDimLine(offX, offY, offX+bw, offY, `${totalW_m} m`, -DL_OFF, true);
    drawDimLine(offX, offY, offX, offY+bh, `${totalH_m} m`, -DL_OFF, false);

    // ── PASS 7: Wind flow visualisation (OUTSIDE building, flowing OVER) ──
    if (showWindFlow) {
      const nowMs = performance.now();
      if (nowMs >= windPulseRef.current.nextBurstAt && nowMs >= windPulseRef.current.burstUntil) {
        windPulseRef.current.burstUntil = nowMs + windVec.burstMs;
        windPulseRef.current.nextBurstAt = nowMs + windVec.gapMs;
      }
      const burstActive = nowMs < windPulseRef.current.burstUntil;
      if (burstActive && windParticles.current.length < windVec.particleCap) {
        for (let i=0; i<windVec.spawnCount; i++) {
          let spX:number, spY:number;
          if (Math.abs(windVec.x)>=Math.abs(windVec.y)) {
            spX = windVec.x>0 ? offX-ps(2.5)-Math.random()*ps(1.5) : offX+bw+ps(0.5)+Math.random()*ps(1.5);
            spY = offY-ps(0.8)+Math.random()*(bh+ps(1.5));
          } else {
            spX = offX-ps(0.8)+Math.random()*(bw+ps(1.5));
            spY = windVec.y>0 ? offY-ps(2.5)-Math.random()*ps(1.5) : offY+bh+ps(0.5)+Math.random()*ps(1.5);
          }
          windParticles.current.push({
            x: spX,
            y: spY,
            life: 0,
            speed: 1.1 + windVec.intensity * 0.72 + Math.random() * (0.5 + windVec.speed * 0.08),
            alpha: 0,
          });
        }
      }
      const corridors = [0.28, 0.5, 0.72];
      ctx.save();
      ctx.strokeStyle = burstActive ? `rgba(90,245,255,${Math.min(0.32, 0.14 + windVec.intensity * 0.08)})` : "rgba(90,245,255,0.05)";
      ctx.lineWidth = burstActive ? 1.05 + windVec.intensity * 0.45 : 0.75;
      ctx.setLineDash([12,8]);
      corridors.forEach(offset => {
        const sx = offX + bw * (windVec.x >= 0 ? 0.06 : 0.94);
        const sy = offY + bh * offset;
        const ex = offX + bw * (windVec.x >= 0 ? 0.94 : 0.06);
        const ey = sy + windVec.y * windVec.curveOffset * 0.7;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo((sx + ex) / 2, sy + windVec.y * windVec.curveOffset, ex, ey);
        ctx.stroke();
      });
      ctx.restore();
      windParticles.current = windParticles.current.filter(p => {
        if (p.life>=115) return false;
        return !(
          (windVec.x>0.1 && p.x>offX+bw+ps(3)) ||
          (windVec.x<-0.1 && p.x<offX-ps(3)) ||
          (windVec.y>0.1 && p.y>offY+bh+ps(3)) ||
          (windVec.y<-0.1 && p.y<offY-ps(3))
        );
      });
      windParticles.current.forEach(p => {
        p.life++; p.x+=windVec.x*p.speed*windVec.trailMultiplier; p.y+=windVec.y*p.speed*windVec.trailMultiplier;
        p.alpha = Math.sin(p.life/115*Math.PI) * (burstActive ? Math.min(0.82, 0.45 + windVec.intensity * 0.16) : 0.2);
        const len=p.speed*(6.8 + windVec.intensity * 2.6); const ex=p.x-windVec.x*len; const ey=p.y-windVec.y*len;
        ctx.strokeStyle=`rgba(90,245,255,${p.alpha})`; ctx.lineWidth=1.2 + windVec.intensity * 0.45; ctx.lineCap="round";
        ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(p.x,p.y); ctx.stroke();
        const angle=Math.atan2(windVec.y,windVec.x);
        ctx.fillStyle=`rgba(170,250,255,${p.alpha})`; ctx.save();
        ctx.translate(p.x,p.y); ctx.rotate(angle);
        ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(-5,-2.5); ctx.lineTo(-5,2.5); ctx.closePath(); ctx.fill();
        ctx.restore();
      });
      // Wind direction label
      ctx.fillStyle = burstActive ? "rgba(170,250,255,0.86)" : "rgba(170,250,255,0.42)";
      ctx.font="bold 9px monospace"; ctx.textAlign="left"; ctx.textBaseline="alphabetic";
      ctx.fillText(`WIND ${windVec.label} · ${windVec.speed.toFixed(1)} M/S`, offX+4, offY-8);
    }

    // ── ECO Overlay (additive layer) ──
    if (showEcoOverlay) {
      const audit = activeAudit;
      if (audit) {
        const criterion = (id: number) => (audit.criteria ?? []).find((item) => item.criterion_id === id);
        const HABITABLE = ["living", "dining", "bedroom", "office"];

        const drawVentilationPaths = () => {
          floor1
            .filter((room) => HABITABLE.includes(room.type))
            .forEach((room) => {
              const cx = px(room.x + room.width / 2);
              const cy = py(room.y + room.height / 2);
              const len = Math.min(room.width, room.height) * 0.8;
              ctx.save();
              ctx.strokeStyle = "rgba(0,200,255,0.55)";
              ctx.lineWidth = 1.5;
              ctx.setLineDash([8, 4]);
              ctx.beginPath();
              ctx.moveTo((cx - windVec.x * len * 0.5), (cy - windVec.y * len * 0.5));
              ctx.lineTo((cx + windVec.x * len * 0.5), (cy + windVec.y * len * 0.5));
              ctx.stroke();
              ctx.restore();
            });
        };

        const solar = criterion(1);
        if (solar) {
          const solarPassed = !!solar.passed;
          const bearing = lat >= 0 ? 180 : 0;
          const rad = (bearing - 90) * Math.PI / 180;
          floor1
            .filter((room) => HABITABLE.includes(room.type))
            .forEach((room) => {
              const cx = px(room.x + room.width / 2);
              const cy = py(room.y + room.height / 2);
              const scaleArrow = Math.min(ps(room.width), ps(room.height)) * 0.3;
              if (solarPassed) {
                const tx = cx + Math.cos(rad) * scaleArrow;
                const ty = cy + Math.sin(rad) * scaleArrow;
                ctx.strokeStyle = "rgba(255,200,0,0.80)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(tx, ty);
                ctx.stroke();
                const ah = 6;
                ctx.fillStyle = "rgba(255,200,0,0.80)";
                ctx.beginPath();
                ctx.moveTo(tx, ty);
                ctx.lineTo(tx - ah * Math.cos(rad - 0.4), ty - ah * Math.sin(rad - 0.4));
                ctx.lineTo(tx - ah * Math.cos(rad + 0.4), ty - ah * Math.sin(rad + 0.4));
                ctx.closePath();
                ctx.fill();
              } else {
                const s = scaleArrow * 0.5;
                ctx.strokeStyle = "rgba(255,60,60,0.80)";
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(cx - s, cy - s);
                ctx.lineTo(cx + s, cy + s);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(cx + s, cy - s);
                ctx.lineTo(cx - s, cy + s);
                ctx.stroke();
              }
            });
        }

        const vent = criterion(2);
        if (vent && vent.passed) {
          drawVentilationPaths();
        } else if (vent && !vent.passed) {
          const failRooms = extractFailedRooms(vent.findings ?? [], floor1.filter((room) => HABITABLE.includes(room.type)));
          failRooms.forEach((room) => {
            const cx = px(room.x + room.width / 2);
            const cy = py(room.y + room.height / 2);
            ctx.strokeStyle = "rgba(255,165,0,0.75)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, 10, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = "rgba(255,165,0,0.90)";
            ctx.font = "bold 12px monospace";
            ctx.textAlign = "center";
            ctx.fillText("!", cx, cy + 4);
          });
        }

        const flood = criterion(5);
        if (flood && !flood.passed) {
          floor1
            .filter((room) => room.floor === 1 && HABITABLE.includes(room.type))
            .forEach((room) => {
              const rx = px(room.x);
              const ry = py(room.y);
              const rw = ps(room.width);
              const rh = ps(room.height);
              ctx.save();
              ctx.beginPath();
              ctx.rect(rx, ry, rw, rh);
              ctx.clip();
              ctx.strokeStyle = "rgba(255,100,0,0.10)";
              ctx.lineWidth = 1;
              const spacing = Math.max(4, ps(1.5));
              for (let d = -rh; d < rw + rh; d += spacing) {
                ctx.beginPath();
                ctx.moveTo(rx + d, ry + rh);
                ctx.lineTo(rx + d + rh, ry);
                ctx.stroke();
              }
              ctx.restore();
              ctx.fillStyle = "rgba(255,100,0,0.65)";
              ctx.font = `bold ${Math.max(8, ps(0.25))}px monospace`;
              ctx.textAlign = "center";
              ctx.fillText("FLOOD RISK", rx + rw / 2, ry + rh / 2);
            });
        }

        const treesCriterion = criterion(7);
        if (treesCriterion && trees.length > 0) {
          const lats = trees.map((t) => t.lat);
          const lons = trees.map((t) => t.lon);
          const latMin = Math.min(...lats);
          const latMax = Math.max(...lats);
          const lonMin = Math.min(...lons);
          const lonMax = Math.max(...lons);
          const latSpan = Math.max(1e-6, latMax - latMin);
          const lonSpan = Math.max(1e-6, lonMax - lonMin);

          trees.forEach((tree) => {
            const nx = (tree.lon - lonMin) / lonSpan;
            const ny = (tree.lat - latMin) / latSpan;
            const tx = offX + nx * bw;
            const ty = offY + (1 - ny) * bh;
            const lx = minX + nx * (maxX - minX);
            const ly = minY + (1 - ny) * (maxY - minY);
            const radiusPx = Math.max(6, ps((tree as any).radius_m ?? 1.8));

            const conflict = floor1.some((room) => {
              const rx0 = room.x;
              const rx1 = room.x + room.width;
              const ry0 = room.y;
              const ry1 = room.y + room.height;
              const cx = Math.max(rx0, Math.min(lx, rx1));
              const cy = Math.max(ry0, Math.min(ly, ry1));
              return ((lx - cx) ** 2 + (ly - cy) ** 2) <= (((tree as any).radius_m ?? 1.8) ** 2);
            });

            if (conflict) {
              ctx.strokeStyle = "rgba(255,60,60,0.85)";
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(tx, ty, radiusPx, 0, Math.PI * 2);
              ctx.stroke();
              ctx.fillStyle = "rgba(255,60,60,0.2)";
              ctx.fill();
            } else {
              ctx.strokeStyle = "rgba(40,220,100,0.55)";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(tx, ty, radiusPx, 0, Math.PI * 2);
              ctx.stroke();
            }
          });
        }

        floor1.forEach((room) => {
          const bx = px(room.x + room.width - 0.3);
          const by = py(room.y + 0.1);
          const roomPasses = doesRoomPassAllApplicableCriteria(room, audit);
          ctx.fillStyle = roomPasses ? "rgba(34,197,94,0.9)" : "rgba(239,68,68,0.9)";
          ctx.font = "bold 10px monospace";
          ctx.textAlign = "right";
          ctx.fillText(roomPasses ? "✓" : "✗", bx, by + 10);
        });
      }
    }

    // ── Convergence sparkline (active algorithm) ──
    const curve = (convergenceCurve ?? []).slice();
    const sparkX = 14;
    const sparkY = H - 72;
    const sparkW = 60;
    const sparkH = 20;
    ctx.fillStyle = "rgba(10,24,28,0.85)";
    ctx.strokeStyle = "rgba(0,220,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(sparkX - 4, sparkY - 12, sparkW + 8, sparkH + 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(0,220,255,0.7)";
    ctx.font = "bold 7px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("CONV", sparkX - 2, sparkY - 4);

    if (curve.length > 1) {
      const minV = Math.min(...curve);
      const maxV = Math.max(...curve);
      const span = Math.max(1e-6, maxV - minV);
      ctx.strokeStyle = "rgba(0,220,255,0.95)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      curve.forEach((value, idx) => {
        const x = sparkX + (idx / (curve.length - 1)) * sparkW;
        const y = sparkY + sparkH - ((value - minV) / span) * sparkH;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(0,220,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sparkX, sparkY + sparkH * 0.6);
      ctx.lineTo(sparkX + sparkW, sparkY + sparkH * 0.6);
      ctx.stroke();
    }

    // ── PASS 8: Professional title block ──
    const TB_H = 38; const TB_Y = H-TB_H;
    ctx.fillStyle="rgba(8,14,14,0.96)"; ctx.fillRect(0,TB_Y,W,TB_H);
    ctx.strokeStyle="rgba(13,242,242,0.25)"; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.moveTo(0,TB_Y); ctx.lineTo(W,TB_Y); ctx.stroke();
    const cols=[W*0.2,W*0.4,W*0.6,W*0.8];
    cols.forEach(cx2=>{ctx.strokeStyle="rgba(13,242,242,0.12)";ctx.beginPath();ctx.moveTo(cx2,TB_Y);ctx.lineTo(cx2,H);ctx.stroke();});
    const today=new Date();
    const dateStr=`${today.getDate().toString().padStart(2,"0")}/${(today.getMonth()+1).toString().padStart(2,"0")}/${today.getFullYear()}`;
    const items=[
      {label:"PROJECT",value:"ECO-3D STUDIO"},
      {label:"PLOT",value:plotShape.toUpperCase()+" · "+plotArea+"m²"},
      {label:"COORDS",value:`${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E`},
      {label:"SCALE",value:`1:${Math.round(1000/Math.max(scale,0.1))} (approx)`},
      {label:"DATE",value:dateStr},
    ];
    items.forEach((item,i)=>{
      const tx = i===0 ? 10 : cols[i-1]+8;
      ctx.fillStyle="rgba(13,242,242,0.4)"; ctx.font="bold 7px monospace"; ctx.textAlign="left"; ctx.textBaseline="top";
      ctx.fillText(item.label, tx, TB_Y+5);
      ctx.fillStyle="rgba(255,255,255,0.85)"; ctx.font="bold 9.5px 'Space Grotesk',monospace";
      ctx.fillText(item.value, tx, TB_Y+16);
    });

    // ── PASS 9: North arrow + compass rose ──
    const narX=W-52, narY=offY-10;
    // Circle background
    ctx.fillStyle="rgba(8,20,22,0.92)"; ctx.strokeStyle="rgba(13,242,242,0.6)"; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.arc(narX,narY,18,0,Math.PI*2); ctx.fill(); ctx.stroke();
    // N arrow (filled)
    ctx.fillStyle="rgba(13,242,242,0.9)";
    ctx.beginPath(); ctx.moveTo(narX,narY-14); ctx.lineTo(narX-5,narY+2); ctx.lineTo(narX,narY+5); ctx.lineTo(narX+5,narY+2); ctx.closePath(); ctx.fill();
    ctx.fillStyle="rgba(13,242,242,0.2)";
    ctx.beginPath(); ctx.moveTo(narX,narY+5); ctx.lineTo(narX-5,narY+2); ctx.lineTo(narX,narY-14); ctx.closePath(); ctx.fill();
    ctx.fillStyle="#0df2f2"; ctx.font="bold 9px monospace"; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("N",narX,narY-6);

    // ── PASS 10: Scale bar ──
    const scaleBarM = 5;
    const sbPx = scale*scaleBarM;
    const sbX=offX, sbY=H-TB_H-14;
    ctx.fillStyle="rgba(13,242,242,0.7)"; ctx.fillRect(sbX,sbY,sbPx,3);
    ctx.fillRect(sbX,sbY-3,2,9); ctx.fillRect(sbX+sbPx-2,sbY-3,2,9);
    ctx.font="7.5px monospace"; ctx.textAlign="left"; ctx.fillStyle="#1a3040";
    ctx.fillText(`0`,sbX,sbY-4); ctx.fillText(`${scaleBarM}m`,sbX+sbPx+3,sbY-4);
    // Scale bar tick at midpoint
    ctx.fillRect(sbX+sbPx/2-1,sbY-2,2,7);
    ctx.fillText(`${scaleBarM/2}m`,sbX+sbPx/2-6,sbY-4);

  }, [rooms, walls, doors, windows, trees, lat, lon, zoom, showSolarPath, showWindFlow, showEcoOverlay, ecoAudit, activeAudit, activeRooms, activeWalls, activeWindows, floodProbability, plotShape, plotArea, windVec, windDir, windDirectionDeg, getRoomStyle, getRoomFill, getRoomHatch, getDisplayLabel, getShortLabel, parseWindowWall, drawFurniture, sunAzimuthDeg, sunElevationDeg, algorithmName, convergenceCurve]);

  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      draw();
      const inFade = performance.now() - transitionStartRef.current < 420;
      if (showWindFlow || showSolarPath || inFade) {
        animRef.current = requestAnimationFrame(loop);
      }
    };
    animRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw, showWindFlow, showSolarPath, variantKey, activeAudit, activeRooms, activeWalls, activeWindows]);

  return <canvas ref={canvasRef} className="w-full h-full" style={{ display: "block" }} />;
}

export default function AnalysisPage() {
  const params = useParams(); const router = useRouter();
  const plotId = params.id as string;
  const floorPlanRequestRef = useRef(0);
  const areaEditedRef = useRef(false);

  const [houseType, setHouseType] = useState("Eco-Villa (Single Story)");
  const [generationMethod, setGenerationMethod] = useState<"deterministic" | "ga">("deterministic");
  const [layoutMode, setLayoutMode] = useState<"default" | "fit_boundary">("fit_boundary");
  const [plotShape, setPlotShape] = useState("rectangle");
  const [targetArea, setTargetArea] = useState("240");
  const [numFloors, setNumFloors] = useState(1);
  const [treePres, setTreePres] = useState(true);
  const [maxSun, setMaxSun] = useState(true);
  const [natVent, setNatVent] = useState(true);
  const [sustPrio, setSustPrio] = useState(true);
  const [showSolar, setShowSolar] = useState(true);
  const [showWind, setShowWind] = useState(true);
  const [showEcoOverlay, setShowEcoOverlay] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<"eco" | "insights">("eco");
  const [zoom, setZoom] = useState(14);
  const [generating, setGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedVariantIndex, setExpandedVariantIndex] = useState<number | null>(null);

  // Room preference state
  const [numBedrooms, setNumBedrooms] = useState(2);
  const [numBathrooms, setNumBathrooms] = useState(1);
  const [hasPuja, setHasPuja] = useState(false);
  const [hasGarage, setHasGarage] = useState(false);
  const [hasOffice, setHasOffice] = useState(false);
  const [hasDining, setHasDining] = useState(false);
  const [hasUtility, setHasUtility] = useState(false);

  const [logs, setLogs] = useState([
    { time: "12:04:12", msg: "Footprint shifted 2.4m North to avoid T01 root system." },
    { time: "12:04:11", msg: "Living area windows rotated 15° for max solar gain." },
    { time: "12:04:09", msg: "Cross-ventilation path established via West-East axis." },
  ]);

  const {
    analysis, floorPlan, selectedLat, selectedLon,
    setFloorPlan, setFloorPlanVariants, setActiveVariantIndex, setActiveIterationIndex,
    floorPlanVariants, activeVariantIndex, selectedAlgorithm,
    activeIterationIndex, activeAudit, activeRooms, activeWalls, activeWindows,
    setGeneratingFloorPlan, selectedPlotArea,
  } = useEco3DStore();
  const lat = selectedLat ?? 34.0522;
  const lon = selectedLon ?? -118.2437;
  const [liveEnv, setLiveEnv] = useState<Awaited<ReturnType<typeof fetchLiveEnvironment>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;

    const refreshLiveEnv = async () => {
      try {
        const snapshot = await fetchLiveEnvironment(lat, lon);
        if (!cancelled) {
          setLiveEnv(snapshot);
        }
      } catch {
        if (!cancelled) {
          setLiveEnv(null);
        }
      }
    };

    void refreshLiveEnv();
    intervalId = window.setInterval(() => {
      void refreshLiveEnv();
    }, 45000);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [lat, lon]);

  // Active variant rooms (carousel drives what's displayed)
  const activeVariant = floorPlanVariants[activeVariantIndex] ?? null;
  const iterationHistory = floorPlan?.iteration_history ?? null;
  const rooms = (activeRooms as unknown as Room[]).length > 0
    ? (activeRooms as unknown as Room[])
    : (activeVariant?.layout ?? floorPlan?.layout ?? []);
  const walls = (activeWalls as unknown as Wall[]).length > 0
    ? (activeWalls as unknown as Wall[])
    : (activeVariant?.walls ?? floorPlan?.walls ?? []);
  const doors = activeVariant?.doors ?? floorPlan?.doors ?? [];
  const windows = (activeWindows as unknown as WindowEl[]).length > 0
    ? (activeWindows as unknown as WindowEl[])
    : (activeVariant?.windows ?? floorPlan?.windows ?? []);
  const trees = analysis?.tree_coordinates?.slice(0,4) ?? [];
  const ecoScore = activeAudit
    ? Math.round(activeAudit.composite_eco_score)
    : activeVariant
    ? Math.round((activeVariant.eco_score ?? activeVariant.fitness_score) * 100)
    : floorPlan ? Math.round(floorPlan.fitness_score * 100)
    : (analysis ? Math.round(analysis.buildability_score) : 71);
  const solarPct = activeVariant
    ? Math.round(activeVariant.solar_score * 100)
    : floorPlan ? Math.round(floorPlan.sunlight_score * 100) : 88;
  const ventPct = activeVariant
    ? Math.round(activeVariant.ventilation_score * 100)
    : floorPlan ? Math.round(floorPlan.ventilation_score * 100) : 95;
  const structPct = activeVariant
    ? Math.round((activeVariant.structural_score ?? 0) * 100)
    : floorPlan ? Math.round((floorPlan.structural_score ?? 0) * 100) : 80;
  const floodPct = activeVariant
    ? Math.round((activeVariant.flood_score ?? 0) * 100)
    : floorPlan ? Math.round((floorPlan.flood_score ?? 0) * 100) : 78;
  const treePct = activeVariant
    ? Math.round((activeVariant.tree_score ?? 0) * 100)
    : floorPlan ? Math.round((floorPlan.tree_score ?? 0) * 100) : 74;
  const treeDist = floorPlan?.tree_preserved_count ?? 0;
  const activeAlgorithm = activeVariant?.algorithm ?? selectedAlgorithm ?? "Deterministic";
  const activeConvergence = activeVariant?.convergence_curve ?? [];
  const expandedVariant = expandedVariantIndex !== null ? floorPlanVariants[expandedVariantIndex] ?? null : null;
  const floodProbability = analysis?.flood_probability ?? 0;
  const isLiveEnvReady = liveEnv !== null;
  const windDir = liveEnv?.windDirectionCardinal ?? "—";
  const windSpeed = liveEnv?.windSpeedMs ?? 0;
  const windDirectionDeg = liveEnv?.windDirectionDeg;
  const sunAzimuthDeg = liveEnv?.sunAzimuthDeg;
  const sunElevationDeg = liveEnv?.sunElevationDeg;
  const sunPositionLabel = typeof sunAzimuthDeg === "number" && typeof sunElevationDeg === "number"
    ? `AZ ${Math.round(sunAzimuthDeg)}° · EL ${Math.max(0, sunElevationDeg).toFixed(0)}°`
    : "LIVE DATA REQUIRED";

  // Area input: user can type sqft or m²
  const [areaUnit, setAreaUnit] = useState<"sqft"|"sqm">("sqm");
  const areaInSqm = useMemo(() => {
    const parsed = parseFloat(targetArea);
    const fallback = selectedPlotArea && selectedPlotArea > 0 ? selectedPlotArea : 240;
    const v = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    return areaUnit === "sqft" ? Math.round(v * 0.0929) : v;
  }, [targetArea, areaUnit, selectedPlotArea]);
  const area = areaInSqm;

  useEffect(() => {
    areaEditedRef.current = false;
  }, [plotId]);

  useEffect(() => {
    if (!selectedPlotArea || selectedPlotArea <= 0 || areaEditedRef.current) return;
    const suggested = recommendFloorAreaFromPlot(selectedPlotArea, numFloors);
    setAreaUnit("sqm");
    setTargetArea(String(suggested));
  }, [selectedPlotArea, plotId, numFloors]);

  useEffect(() => {
    if (expandedVariantIndex === null) return;
    if (expandedVariantIndex >= floorPlanVariants.length) {
      setExpandedVariantIndex(null);
    }
  }, [expandedVariantIndex, floorPlanVariants.length]);

  const limits = useMemo(() => computeRoomLimits(area), [area]);

  const addLog = (msg: string) => {
    const n = new Date();
    const t = `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}:${String(n.getSeconds()).padStart(2,"0")}`;
    setLogs(prev => [{ time: t, msg }, ...prev].slice(0, 8));
  };

  const selectIterationSnapshot = useCallback((iterationIndex: number) => {
    setActiveIterationIndex(iterationIndex);
  }, [setActiveIterationIndex]);

  const handleRegenerate = async (shapeOverride?: string) => {
    const requestedShape = shapeOverride ?? plotShape;
    const requestedArea = Math.max(45, Math.round(area));
    const requestId = ++floorPlanRequestRef.current;
    setGenerating(true);
    addLog(`Generating 5 variants for ${requestedShape} · ${requestedArea} m² · ${generationMethod.toUpperCase()} · ${layoutMode === "fit_boundary" ? "BOUNDARY-FIT" : "DEFAULT"}...`);
    try {
      const fp = await generateFloorPlan({
        plot_id: plotId,
        plot_area_sqm: requestedArea,
        num_floors: numFloors,
        preserve_trees: treePres,
        plot_shape: requestedShape,
        layout_mode: layoutMode,
        house_type: houseType,
        room_preferences: {
          bedrooms: numBedrooms, bathrooms: numBathrooms,
          puja_room: hasPuja, garage: hasGarage,
          office: hasOffice, dining: hasDining, utility: hasUtility,
        },
        maximize_sunlight: maxSun,
        natural_ventilation: natVent,
        sustainability_priority: sustPrio,
        generation_method: generationMethod,
      });
      if (requestId !== floorPlanRequestRef.current) return;
      setFloorPlan(fp);
      // Extract variants from properly typed response
      const variants = fp.variants ?? [];
      const bestIdx  = fp.best_variant_index ?? 0;
      if (variants.length > 0) {
        setFloorPlanVariants(variants, bestIdx);
        setExpandedVariantIndex(null);
        addLog(`✓ ${variants.length} variants generated — best: "${variants[bestIdx]?.style}"`);
        addLog(`Solar: ${Math.round((variants[bestIdx]?.solar_score??0)*100)}% · Vent: ${Math.round((variants[bestIdx]?.ventilation_score??0)*100)}% · Area: ${variants[bestIdx]?.total_area?.toFixed(0)} m²`);
      } else {
        setFloorPlanVariants([], 0);
        addLog(`✓ ${fp.layout.length} rooms — fitness ${(fp.fitness_score*100).toFixed(0)}%`);
      }
      setGeneratingFloorPlan(false);
    } catch (err: any) {
      if (requestId !== floorPlanRequestRef.current) return;
      addLog(`Generation error: ${err?.message ?? "check backend"}`);
    } finally {
      if (requestId === floorPlanRequestRef.current) setGenerating(false);
    }
  };

  useEffect(() => {
    if (!plotId || !analysis) return;
    setActiveVariantIndex(0);
    setExpandedVariantIndex(null);
    handleRegenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotId, analysis, plotShape, houseType, generationMethod, layoutMode]);

  // Clamp room counts when area changes
  useEffect(() => {
    setNumBedrooms(v => Math.min(v, limits.bedrooms));
    setNumBathrooms(v => Math.min(v, limits.bathrooms));
    if(!limits.puja_room) setHasPuja(false);
    if(!limits.garage) setHasGarage(false);
    if(!limits.office) setHasOffice(false);
    if(!limits.dining) setHasDining(false);
    if(!limits.utility) setHasUtility(false);
  }, [limits]);

  const HOUSE_TYPES = [
    "Eco-Villa (Single Story)",
    "Modern Apartment",
    "Sustainable Townhouse",
    "Green Duplex",
    "Solar Passive House",
    "Compact Urban Home",
    "Traditional with Puja",
  ];

  const PLOT_SHAPES = [
    { value: "rectangle", label: "Rectangle" },
    { value: "square", label: "Square" },
    { value: "l-shape", label: "L-Shape" },
    { value: "t-shape", label: "T-Shape" },
    { value: "irregular", label: "Irregular" },
  ];
  const activePlotShapeLabel = PLOT_SHAPES.find(ps => ps.value === plotShape)?.label ?? plotShape;
  const houseTypeBadge = houseType
    .split(/[\s(/-]+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>{`.gl{background:rgba(10,26,26,0.7);backdrop-filter:blur(10px);border:1px solid rgba(13,242,242,0.08)} .glm{background:rgba(13,242,242,0.04);border:1px solid rgba(13,242,242,0.1)} @keyframes aip{0%,100%{opacity:1}50%{opacity:0.5}} .aip{animation:aip 2s ease-in-out infinite} @keyframes spin{to{transform:rotate(360deg)}} .spin{animation:spin 1s linear infinite}`}</style>
      <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: "#080e0e", fontFamily: "'Space Grotesk',sans-serif" }}>
        <header className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/5" style={{ background: "rgba(8,14,14,0.98)" }}>
          <Link href="/" className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-2xl">deployed_code</span>
            <div>
              <div className="text-white font-bold text-base tracking-tight">ECO-3D <span className="text-primary/60 font-light">Studio</span></div>
              <div className="text-[9px] text-slate-500 uppercase tracking-[0.15em]">AI GENERATIVE ARCHITECTURE</div>
            </div>
          </Link>
          <nav className="flex items-center gap-1">
            {[{l:"Project Alpha",h:`/map`},{l:"Blueprint Generator",h:`/analysis/${plotId}`,a:true},{l:"Environmental Data",h:`/environment/${plotId}`},{l:"Export",h:`/report/${plotId}`}].map(item => (
              <Link key={item.l} href={item.h} className={`px-4 py-2 text-[12px] font-medium transition-all ${(item as any).a ? "text-primary border-b-2 border-primary" : "text-slate-400 hover:text-white"}`}>{item.l}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <button className="w-8 h-8 gl rounded-lg flex items-center justify-center"><span className="material-symbols-outlined text-slate-400 text-lg">notifications</span></button>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[#080e0e] font-bold text-sm" style={{ background: "linear-gradient(135deg,#0df2f2,#0a9a9a)" }}>A</div>
          </div>
        </header>

        <div className="flex-1 flex overflow-hidden">
          {/* ── LEFT SIDEBAR ── */}
          <aside
            className="flex-shrink-0 flex flex-col border-r border-white/5 overflow-hidden transition-all duration-300"
            style={{ width: sidebarOpen ? 320 : 88, background: "rgba(6,12,12,0.98)" }}
          >
            <div className="p-3 flex flex-col gap-4 h-full min-h-0">
              <div className={`flex items-center ${sidebarOpen ? "justify-between" : "flex-col gap-3"}`}>
                <div className={sidebarOpen ? "" : "text-center"}>
                  <div className="text-[9px] font-bold uppercase tracking-[0.22em] text-primary/80">Controls</div>
                  <div className={`mt-1 ${sidebarOpen ? "text-[11px] text-slate-500" : "text-[9px] text-slate-600"}`}>
                    {sidebarOpen ? "Blueprint configuration" : "Plan"}
                  </div>
                </div>
                <button
                  onClick={() => setSidebarOpen(v => !v)}
                  className="w-10 h-10 rounded-2xl flex items-center justify-center border border-white/10 text-slate-300 hover:text-primary transition-colors"
                  style={{ background: "rgba(13,242,242,0.05)" }}
                  title={sidebarOpen ? "Collapse controls" : "Expand controls"}
                >
                  <span className="material-symbols-outlined text-[20px]">{sidebarOpen ? "left_panel_close" : "left_panel_open"}</span>
                </button>
              </div>

              {sidebarOpen ? (
                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                  <div className="flex flex-col gap-4 min-h-full">

              {/* House Type */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">Configuration</div>
                <label className="text-[11px] text-slate-400 mb-1.5 block">House Type</label>
                <select value={houseType} onChange={e => {
                  setActiveVariantIndex(0);
                  setHouseType(e.target.value);
                }} className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white appearance-none cursor-pointer focus:outline-none mb-3" style={{ background: "rgba(13,242,242,0.04)" }}>
                  {HOUSE_TYPES.map(t => <option key={t} value={t} style={{ background: "#0a1a1a" }}>{t}</option>)}
                </select>

                <label className="text-[11px] text-slate-400 mb-1.5 block">Generation Method</label>
                <select
                  value={generationMethod}
                  onChange={e => {
                    setActiveVariantIndex(0);
                    setGenerationMethod(e.target.value as "deterministic" | "ga");
                  }}
                  className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white appearance-none cursor-pointer focus:outline-none mb-3"
                  style={{ background: "rgba(13,242,242,0.04)" }}
                >
                  <option value="deterministic" style={{ background: "#0a1a1a" }}>Deterministic (Default)</option>
                  <option value="ga" style={{ background: "#0a1a1a" }}>GA Optimizer (Premium)</option>
                </select>

                <label className="text-[11px] text-slate-400 mb-1.5 block">Floor Plan Layout</label>
                <select
                  value={layoutMode}
                  onChange={e => {
                    setActiveVariantIndex(0);
                    setLayoutMode(e.target.value as "default" | "fit_boundary");
                  }}
                  className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white appearance-none cursor-pointer focus:outline-none mb-3"
                  style={{ background: "rgba(13,242,242,0.04)" }}
                >
                  <option value="fit_boundary" style={{ background: "#0a1a1a" }}>Fit inside bounded plot (near plot shape)</option>
                  <option value="default" style={{ background: "#0a1a1a" }}>Default layout styles</option>
                </select>

                {/* Plot Shape */}
                <label className="text-[11px] text-slate-400 mb-1.5 block">Plot Shape</label>
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {PLOT_SHAPES.map(ps => (
                    <button key={ps.value} onClick={() => {
                      setActiveVariantIndex(0);
                      setPlotShape(ps.value);
                    }}
                      className="py-2 px-1 rounded text-[10px] font-bold uppercase tracking-wide transition-all"
                      style={{
                        background: plotShape === ps.value ? "rgba(13,242,242,0.15)" : "rgba(13,242,242,0.03)",
                        border: `1px solid ${plotShape === ps.value ? "rgba(13,242,242,0.5)" : "rgba(13,242,242,0.08)"}`,
                        color: plotShape === ps.value ? "#0df2f2" : "#64748b",
                      }}>
                      {ps.label}
                    </button>
                  ))}
                </div>

                {/* Area & Floors */}
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] text-slate-400">Floor Area</label>
                      <div className="flex rounded overflow-hidden border border-white/10" style={{fontSize:9}}>
                        {(["sqm","sqft"] as const).map(u => (
                          <button key={u} onClick={() => setAreaUnit(u)}
                            style={{padding:"2px 7px",background:areaUnit===u?"#0df2f2":"transparent",color:areaUnit===u?"#080e0e":"#64748b",fontWeight:700,cursor:"pointer",border:"none",textTransform:"uppercase"}}>
                            {u==="sqm"?"m²":"ft²"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input type="number" value={targetArea} onChange={e => { areaEditedRef.current = true; setTargetArea(e.target.value); }}
                      className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white focus:outline-none"
                      style={{ background: "rgba(13,242,242,0.04)" }} />
                    <div className="text-[9px] text-slate-500 mt-1">
                      {areaUnit==="sqft" ? `≈ ${area} m²` : `≈ ${Math.round(area/0.0929)} ft²`}
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] text-slate-400 mb-1.5 block">Floors</label>
                    <select value={numFloors} onChange={e => setNumFloors(parseInt(e.target.value))} className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white appearance-none cursor-pointer focus:outline-none" style={{ background: "rgba(13,242,242,0.04)" }}>
                      {[1,2,3].map(f => <option key={f} value={f} style={{ background: "#0a1a1a" }}>{f} Floor{f>1?"s":""}</option>)}
                    </select>
                  </div>
                </div>

                {/* Area hint */}
                <div className="text-[9px] text-primary/50 mb-3">
                  Area: {area}m² → max: {limits.bedrooms} beds, {limits.bathrooms} baths
                </div>
                {layoutMode === "fit_boundary" && (
                  <div className="text-[9px] text-sky-300/70 mb-3">
                    Boundary-fit mode uses detected plot boundary and inferred shape (rectangle/square/circle/irregular).
                  </div>
                )}
              </div>

              <div className="h-px bg-white/5" />

              {/* Room Preferences */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">Room Preferences</div>
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-300">Bedrooms</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setNumBedrooms(v => Math.max(1, v-1))} className="w-6 h-6 glm rounded text-primary text-sm flex items-center justify-center">−</button>
                      <span className="text-[12px] text-white font-bold w-6 text-center">{numBedrooms}</span>
                      <button onClick={() => setNumBedrooms(v => Math.min(limits.bedrooms, v+1))} className="w-6 h-6 glm rounded text-primary text-sm flex items-center justify-center">+</button>
                      <span className="text-[9px] text-slate-600 ml-1">max {limits.bedrooms}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-300">Bathrooms</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setNumBathrooms(v => Math.max(1, v-1))} className="w-6 h-6 glm rounded text-primary text-sm flex items-center justify-center">−</button>
                      <span className="text-[12px] text-white font-bold w-6 text-center">{numBathrooms}</span>
                      <button onClick={() => setNumBathrooms(v => Math.min(limits.bathrooms, v+1))} className="w-6 h-6 glm rounded text-primary text-sm flex items-center justify-center">+</button>
                      <span className="text-[9px] text-slate-600 ml-1">max {limits.bathrooms}</span>
                    </div>
                  </div>

                  {/* Optional rooms */}
                  {[
                    { label: "Puja Room", val: hasPuja, set: setHasPuja, enabled: limits.puja_room },
                    { label: "Garage", val: hasGarage, set: setHasGarage, enabled: limits.garage },
                    { label: "Office / Study", val: hasOffice, set: setHasOffice, enabled: !!limits.office },
                    { label: "Dining Room", val: hasDining, set: setHasDining, enabled: limits.dining },
                    { label: "Utility Room", val: hasUtility, set: setHasUtility, enabled: limits.utility },
                  ].map(({ label, val, set, enabled }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className={`text-[11px] ${enabled ? "text-slate-300" : "text-slate-600"}`}>{label}</span>
                      <div className="flex items-center gap-2">
                        {!enabled && <span className="text-[9px] text-slate-600">needs larger plot</span>}
                        <Toggle on={val && !!enabled} onChange={() => enabled && set(!val)} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-px bg-white/5" />

              {/* AI Constraints */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">AI Eco-Constraints</div>
                <div className="flex flex-col gap-3">
                  {[
                    { l: "Tree Preservation", v: treePres, s: setTreePres, desc: "Avoids detected tree root zones" },
                    { l: "Maximize Sunlight", v: maxSun, s: setMaxSun, desc: "Orients living rooms toward sun" },
                    { l: "Natural Ventilation", v: natVent, s: setNatVent, desc: "Cross-ventilation window placement" },
                    { l: "Sustainability Priority", v: sustPrio, s: setSustPrio, desc: "Eco-material & passive design" },
                  ].map(({ l, v, s, desc }) => (
                    <div key={l}>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[12px] text-slate-300">{l}</span>
                        <Toggle on={v} onChange={() => s(!v)} />
                      </div>
                      <p className="text-[9px] text-slate-600">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Generate Button */}
              <div className="mt-auto flex flex-col gap-3">
                <button onClick={() => handleRegenerate()} disabled={generating}
                  className="w-full py-3.5 rounded-xl font-bold text-[13px] tracking-wide flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: generating ? "rgba(13,242,242,0.3)" : "#0df2f2", color: "#080e0e", boxShadow: generating ? "none" : "0 0 20px rgba(13,242,242,0.3)" }}>
                  <span className={`material-symbols-outlined text-lg ${generating ? "spin" : ""}`}>{generating ? "sync" : "auto_fix_high"}</span>
                  {generating ? "Optimizing..." : "Regenerate Layout"}
                </button>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400">Eco-Score: <span className="text-primary font-bold">{ecoScore}%</span></div>
                </div>
              </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center gap-3">
                  {[
                    { icon: "home_work", label: houseTypeBadge, sub: "Type" },
                    { icon: "architecture", label: activePlotShapeLabel.replace("-", " ").slice(0, 6).toUpperCase(), sub: "Shape" },
                    { icon: "square_foot", label: `${area}`, sub: "sqm" },
                    { icon: "grid_view", label: layoutMode === "fit_boundary" ? "BOUND" : "DFLT", sub: "Layout" },
                    { icon: "eco", label: `${ecoScore}%`, sub: "Eco" },
                  ].map(({ icon, label, sub }) => (
                    <div
                      key={`${icon}-${sub}`}
                      className="w-full rounded-2xl px-2 py-3 border border-white/10 text-center"
                      style={{ background: "rgba(13,242,242,0.05)" }}
                    >
                      <span className="material-symbols-outlined text-[18px] text-primary/80">{icon}</span>
                      <div className="mt-1 text-[11px] font-bold text-white tracking-wide">{label}</div>
                      <div className="text-[9px] uppercase tracking-[0.16em] text-slate-500">{sub}</div>
                    </div>
                  ))}
                  <button
                    onClick={() => handleRegenerate()}
                    disabled={generating}
                    className="w-full rounded-2xl px-2 py-3 border border-primary/30 text-primary disabled:opacity-60"
                    style={{ background: "rgba(13,242,242,0.08)" }}
                    title="Regenerate layout"
                  >
                    <span className={`material-symbols-outlined text-[20px] ${generating ? "spin" : ""}`}>{generating ? "sync" : "auto_fix_high"}</span>
                  </button>
                </div>
              )}
            </div>
          </aside>

          {/* ── CENTER CANVAS ── */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-white/5">

            {/* ── Variant carousel ── */}
            {floorPlanVariants.length > 0 && (
              <div style={{ flexShrink:0, background:"rgba(8,14,14,0.98)", borderBottom:"1px solid rgba(255,255,255,0.05)", padding:"8px 14px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <button
                    onClick={() => {
                      const nextIdx = Math.max(0, activeVariantIndex - 1);
                      setActiveVariantIndex(nextIdx);
                      if (expandedVariantIndex !== null) setExpandedVariantIndex(nextIdx);
                    }}
                    disabled={activeVariantIndex === 0}
                    style={{ width:28, height:28, borderRadius:8, border:"1px solid rgba(13,242,242,0.2)", background:"transparent", color: activeVariantIndex===0?"#334155":"#0df2f2", cursor: activeVariantIndex===0?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
                  >
                    <span className="material-symbols-outlined" style={{fontSize:18}}>chevron_left</span>
                  </button>

                  <div style={{ flex:1, display:"flex", gap:8, overflowX:"auto", paddingBottom:1 }}>
                    {floorPlanVariants.map((v, i) => {
                      const eco = Math.round((v.eco_score ?? v.fitness_score) * 100);
                      const isExpanded = expandedVariantIndex === i;
                      return (
                        <button
                          key={v.id}
                          onClick={() => {
                            setActiveVariantIndex(i);
                            setExpandedVariantIndex(prev => prev === i ? null : i);
                          }}
                          style={{
                            flexShrink:0,
                            padding:"7px 10px",
                            borderRadius:8,
                            fontSize:10,
                            cursor:"pointer",
                            border:`1px solid ${i===activeVariantIndex ? "#0df2f2" : "rgba(255,255,255,0.08)"}`,
                            background: i===activeVariantIndex ? "rgba(13,242,242,0.10)" : "rgba(255,255,255,0.02)",
                            color: i===activeVariantIndex ? "#d8feff" : "#64748b",
                            textAlign:"left",
                            minWidth:140,
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase tracking-[0.08em] text-cyan-300">{v.algorithm}</span>
                            {v.is_best && <span className="text-[9px] text-amber-300">★</span>}
                          </div>
                          <div className="mt-1 text-[11px] font-bold text-white">ECO {eco}%</div>
                          <div className="mt-0.5 text-[9px] text-slate-400">
                            {v.total_area.toFixed(0)} m² · S {Math.round((v.solar_score ?? 0) * 100)}% · V {Math.round((v.ventilation_score ?? 0) * 100)}%
                          </div>
                          <div className="mt-1 text-[8px] uppercase tracking-[0.14em]" style={{ color: isExpanded ? "#22c55e" : "#64748b" }}>
                            {isExpanded ? "Collapse" : "Expand"}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => {
                      const nextIdx = Math.min(floorPlanVariants.length-1, activeVariantIndex+1);
                      setActiveVariantIndex(nextIdx);
                      if (expandedVariantIndex !== null) setExpandedVariantIndex(nextIdx);
                    }}
                    disabled={activeVariantIndex === floorPlanVariants.length-1}
                    style={{ width:28, height:28, borderRadius:8, border:"1px solid rgba(13,242,242,0.2)", background:"transparent", color: activeVariantIndex===floorPlanVariants.length-1?"#334155":"#0df2f2", cursor: activeVariantIndex===floorPlanVariants.length-1?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
                  >
                    <span className="material-symbols-outlined" style={{fontSize:18}}>chevron_right</span>
                  </button>

                  <div style={{flexShrink:0, borderLeft:"1px solid rgba(255,255,255,0.06)", paddingLeft:10, fontSize:10, color:"#475569", fontFamily:"monospace"}}>
                    {activeVariantIndex+1} / {floorPlanVariants.length}
                  </div>
                </div>

                {expandedVariant && (
                  <div className="mt-2 gl rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-cyan-300">
                        [{expandedVariant.algorithm}] {expandedVariant.style}
                      </span>
                      <span className="text-[10px] text-slate-400">{expandedVariant.total_area.toFixed(0)} m²</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <AnimatedScoreBar label="Solar" value={Math.round((expandedVariant.solar_score ?? 0) * 100)} active />
                      <AnimatedScoreBar label="Vent" value={Math.round((expandedVariant.ventilation_score ?? 0) * 100)} active />
                      <AnimatedScoreBar label="Struct" value={Math.round((expandedVariant.structural_score ?? 0) * 100)} active />
                      <AnimatedScoreBar label="Flood" value={Math.round((expandedVariant.flood_score ?? 0) * 100)} active />
                      <AnimatedScoreBar label="Tree" value={Math.round((expandedVariant.tree_score ?? 0) * 100)} active />
                      <AnimatedScoreBar label="Eco" value={Math.round((expandedVariant.eco_score ?? expandedVariant.fitness_score ?? 0) * 100)} active />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-white/5" style={{ background: "rgba(8,14,14,0.98)" }}>
              <div className="flex items-center gap-2 glm px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 rounded-full bg-primary aip" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary">ARCHITECTURAL FLOOR PLAN — {plotShape.toUpperCase()} PLOT</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="glm px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-slate-300">X: {lat.toFixed(4)}°N</div>
                <div className="glm px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-slate-300">Y: {lon.toFixed(4)}°E</div>
                <div className="px-2.5 py-1.5 rounded-lg text-[10px] font-mono"
                  style={{
                    color: liveEnv ? "#8ef0ff" : "#64748b",
                    background: liveEnv ? "rgba(56,189,248,0.12)" : "rgba(100,116,139,0.14)",
                    border: `1px solid ${liveEnv ? "rgba(56,189,248,0.35)" : "rgba(100,116,139,0.25)"}`,
                  }}
                >
                  {liveEnv ? "LIVE FROM OPEN-METEO" : "LIVE MODE: WAITING FOR OPEN-METEO"}
                </div>
              </div>
              <div className="gl px-3 py-2 rounded-lg">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-1">Legend</div>
                {[{c:"#ffc832",l:"Plot Boundary"},{c:"#b0d8e8",l:"Windows"},{c:"rgba(100,180,255,0.8)",l:"Wind Flow"},{c:"rgba(255,200,30,0.9)",l:"Live Sun"}].map(({c,l}) => (
                  <div key={l} className="flex items-center gap-2 mb-1">
                    <span style={{width:10,height:10,background:c,display:"inline-block",borderRadius:2}} />
                    <span className="text-[10px] text-slate-400">{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 relative overflow-hidden">
              <BlueprintCanvas rooms={rooms} walls={walls} doors={doors} windows={windows} trees={trees} lat={lat} lon={lon} zoom={zoom}
                showSolarPath={showSolar && isLiveEnvReady}
                showWindFlow={showWind && isLiveEnvReady}
                showEcoOverlay={showEcoOverlay && rightPanelTab === "eco"}
                ecoAudit={activeAudit}
                floodProbability={floodProbability}
                floorPlan={floorPlan}
                plotShape={plotShape} plotArea={area} windDir={windDir} windSpeed={windSpeed} windDirectionDeg={windDirectionDeg}
                sunAzimuthDeg={sunAzimuthDeg} sunElevationDeg={sunElevationDeg}
                variantKey={activeVariantIndex}
                algorithmName={activeAlgorithm}
                convergenceCurve={activeConvergence}
              />
              <div className="absolute top-3 right-3 flex flex-col gap-1">
                {[{i:"add",a:()=>setZoom(z=>Math.min(z+2,32))},{i:"remove",a:()=>setZoom(z=>Math.max(z-2,6))},{i:"center_focus_strong",a:()=>setZoom(14)}].map(({i,a}) => (
                  <button key={i} onClick={a} className="w-9 h-9 rounded-lg flex items-center justify-center hover:text-primary transition-all text-slate-600 border border-slate-300/20 bg-white/5">
                    <span className="material-symbols-outlined text-lg">{i}</span>
                  </button>
                ))}
              </div>
              <div className="absolute top-3 left-3 flex flex-col gap-1" style={{zIndex:10}}>
                <div
                  className="px-2.5 py-1 rounded text-[9px] font-bold uppercase tracking-wide"
                  style={{
                    background: liveEnv ? "rgba(56,189,248,0.18)" : "rgba(71,85,105,0.22)",
                    border: `1px solid ${liveEnv ? "rgba(56,189,248,0.45)" : "rgba(71,85,105,0.35)"}`,
                    color: liveEnv ? "#7dd3fc" : "#94a3b8",
                  }}
                >
                  {liveEnv ? "LIVE FROM OPEN-METEO" : "LIVE DATA UNAVAILABLE"}
                </div>
                <div
                  className="px-2.5 py-1 rounded text-[9px] font-bold uppercase tracking-wide"
                  style={{ background: "rgba(245,158,11,0.18)", border: "1px solid rgba(245,158,11,0.42)", color: "#fbbf24" }}
                >
                  SUN POSITION: {sunPositionLabel}
                </div>
                {[
                  {l:"Solar",on:showSolar,s:setShowSolar,c:"#e88c00"},
                  {l:"Wind",on:showWind,s:setShowWind,c:"#3b82f6"},
                  {l:"ECO OVERLAY",on:showEcoOverlay,s:setShowEcoOverlay,c:"#22c55e"},
                ].map(({l,on,s,c}) => (
                  <button key={l} onClick={() => s(!on)} className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide transition-all"
                    style={{background:on?`${c}22`:"rgba(8,14,14,0.85)",border:`1px solid ${on?c:"rgba(13,242,242,0.15)"}`,color:on?c:"rgba(13,242,242,0.5)",fontSize:9,padding:"3px 8px"}}>{ l}</button>
                ))}
              </div>
{/* View 3D button moved to footer */}
            </div>
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-t border-white/5 text-[10px] font-mono text-slate-500" style={{ background: "rgba(8,14,14,0.98)" }}>
              <span>⬡ PROFESSIONAL BLUEPRINT 3.0</span>
              <span>⊙ SITE: {plotId || "—"} · {plotShape.toUpperCase()}</span>
              <div className="flex items-center gap-3">
                <button onClick={() => router.push(`/model3d/${plotId}`)} className="flex items-center gap-1 px-3 py-1.5 rounded font-bold text-[10px] uppercase" style={{background:"#0df2f2",color:"#080e0e",gap:4}}>
                  <span className="material-symbols-outlined" style={{fontSize:13}}>view_in_ar</span>3D Model
                </button>
                <button onClick={() => {
                  // Generate a simple DXF-format export
                  let dxf = "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n";
                  rooms.forEach(r => {
                    dxf += `0\nLINE\n8\n${r.type.toUpperCase()}\n10\n${r.x}\n20\n${r.y}\n30\n0\n11\n${r.x+r.width}\n21\n${r.y}\n31\n0\n`;
                    dxf += `0\nLINE\n8\n${r.type.toUpperCase()}\n10\n${r.x+r.width}\n20\n${r.y}\n30\n0\n11\n${r.x+r.width}\n21\n${r.y+r.height}\n31\n0\n`;
                    dxf += `0\nLINE\n8\n${r.type.toUpperCase()}\n10\n${r.x+r.width}\n20\n${r.y+r.height}\n30\n0\n11\n${r.x}\n21\n${r.y+r.height}\n31\n0\n`;
                    dxf += `0\nLINE\n8\n${r.type.toUpperCase()}\n10\n${r.x}\n20\n${r.y+r.height}\n30\n0\n11\n${r.x}\n21\n${r.y}\n31\n0\n`;
                  });
                  dxf += "0\nENDSEC\n0\nEOF";
                  const blob = new Blob([dxf], { type: "application/dxf" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url; a.download = `ECO3D_${plotId}_floorplan.dxf`; a.click(); URL.revokeObjectURL(url);
                }} className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"><span className="material-symbols-outlined text-sm">download</span>Export DXF</button>
                <button onClick={() => handleRegenerate()} className="flex items-center gap-1 px-3 py-1 rounded font-bold text-[10px]" style={{background:"#0df2f2",color:"#080e0e"}}>Save Design</button>
              </div>
            </div>
          </div>

          {/* ── RIGHT PANEL ── */}
          <aside className="w-80 flex-shrink-0 flex flex-col overflow-y-auto" style={{ background: "rgba(6,12,12,0.98)" }}>
            <div className="p-4 flex h-full flex-col gap-4">
              <div className="rounded-lg border border-white/10 bg-black/20 p-1">
                <div className="grid grid-cols-2 gap-1">
                  {[
                    { key: "eco", label: "Eco Audit" },
                    { key: "insights", label: "Insights" },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setRightPanelTab(tab.key as "eco" | "insights")}
                      className={`rounded-md px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-all ${
                        rightPanelTab === tab.key
                          ? "bg-cyan-400/20 text-cyan-200 border border-cyan-300/40"
                          : "text-slate-400"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              {rightPanelTab === "eco" ? (
                <>
                  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                    <EcoReportPanel />
                    <IterationTimeline
                      history={iterationHistory}
                      isLoading={generating}
                      onSelectIteration={selectIterationSnapshot}
                      activeIterationIndex={activeIterationIndex}
                    />
                  </div>
                  <button onClick={() => router.push(`/report/${plotId}`)} className="w-full py-2.5 rounded-lg text-[11px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-primary/10 transition-all" style={{border:"1px solid #0df2f2",color:"#0df2f2"}}>
                    <span className="material-symbols-outlined text-sm">assessment</span>View Detailed Report
                  </button>
                </>
              ) : (
                <div className="flex flex-1 flex-col gap-5 overflow-y-auto pr-1">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-4">Efficiency HUD</div>
                    <div className="flex justify-center mb-4"><EcoScoreRing score={ecoScore} /></div>
                    <EffBar label="Solar Gain" value={solarPct} status={solarPct > 80 ? "High" : "Medium"} color="#f59e0b" />
                    <EffBar label="Wind Ventilation" value={ventPct} status={ventPct > 80 ? "Optimized" : "Moderate"} color="#0df2f2" />
                    <EffBar label="Structural Integrity" value={structPct} status={structPct > 80 ? "Stable" : "Check"} color="#22c55e" />
                    <EffBar label="Flood Safety" value={floodPct} status={floodPct > 80 ? "Low Risk" : "Elevate"} color="#38bdf8" />
                    <EffBar label="Tree Preservation" value={treePct} status={treeDist === 0 ? "Full" : `${treeDist} trees`} color="#2ecc71" />
                  </div>
                  <div className="h-px bg-white/5" />
                  <div className="flex-1">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">Technical Logs</div>
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-3 py-2 border-b border-white/5">
                        <span className="text-[10px] font-mono text-primary/50 flex-shrink-0">{log.time}</span>
                        <span className="text-[11px] text-slate-300 leading-relaxed">{log.msg}</span>
                      </div>
                    ))}
                  </div>
                  {analysis && (
                    <div className="glm p-3 rounded-lg space-y-3">
                      <div>
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">Plot Scores</div>
                        {[
                          { k: "Buildability",  v: `${analysis.buildability_score.toFixed(0)} / 100` },
                          { k: "Flood Risk",    v: `${(analysis.flood_probability * 100).toFixed(0)}%` },
                        ].map(({ k, v }) => (
                          <div key={k} className="flex justify-between py-1 border-b border-white/5">
                            <span className="text-[10px] text-slate-500">{k}</span>
                            <span className="text-[10px] font-mono text-slate-200">{v}</span>
                          </div>
                        ))}
                      </div>

                      <div>
                        <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">Topography</div>
                        {[
                          { k: "Elevation",    v: `${analysis.environmental.elevation.toFixed(0)} m` },
                          { k: "Slope",        v: `${analysis.environmental.slope?.toFixed(1) ?? "—"}°` },
                          { k: "Dist. Water",  v: analysis.environmental.distance_to_water_m ? `${(analysis.environmental.distance_to_water_m as number).toFixed(0)} m` : "—" },
                        ].map(({ k, v }) => (
                          <div key={k} className="flex justify-between py-1 border-b border-white/5">
                            <span className="text-[10px] text-slate-500">{k}</span>
                            <span className="text-[10px] font-mono text-slate-200">{v}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <button onClick={() => router.push(`/report/${plotId}`)} className="w-full py-2.5 rounded-lg text-[11px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-primary/10 transition-all" style={{border:"1px solid #0df2f2",color:"#0df2f2"}}>
                    <span className="material-symbols-outlined text-sm">assessment</span>View Detailed Report
                  </button>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
