"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n: number, dec = 1) { return n.toFixed(dec); }

const GRADE = (v: number) =>
    v >= 90 ? ["S", "#0df2f2"] : v >= 75 ? ["A", "#2ecc71"] : v >= 60 ? ["B", "#f1c40f"] : ["C", "#e67e22"];

// ─── Section wrapper ──────────────────────────────────────────────────────────
function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
    return (
        <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid rgba(13,242,242,0.08)", background: "rgba(10,26,26,0.55)" }}>
            <div className="flex items-center gap-3 px-6 py-4 border-b border-white/5">
                <span className="material-symbols-outlined text-primary text-lg">{icon}</span>
                <h2 className="text-[11px] font-bold uppercase tracking-widest text-primary">{title}</h2>
            </div>
            <div className="p-6">{children}</div>
        </div>
    );
}

// ─── Metric row ───────────────────────────────────────────────────────────────
function MetricRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="flex items-center justify-between py-3 border-b border-white/5">
            <span className="text-sm text-slate-400">{label}</span>
            <div className="text-right">
                <div className="text-sm font-mono font-bold text-white">{value}</div>
                {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
            </div>
        </div>
    );
}

// ─── Score pill ───────────────────────────────────────────────────────────────
function ScorePill({ score, label }: { score: number; label: string }) {
    const [grade, color] = GRADE(score);
    return (
        <div className="flex flex-col items-center gap-2 p-5 rounded-xl" style={{ border: `1px solid ${color}22`, background: `${color}08` }}>
            <div className="text-4xl font-black" style={{ color }}>{score}<span className="text-xl text-slate-500 font-bold">%</span></div>
            <div className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest" style={{ background: `${color}22`, color }}>{grade}</div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 text-center font-bold">{label}</div>
        </div>
    );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function Bar({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="mb-4">
            <div className="flex justify-between text-[11px] mb-1.5">
                <span className="text-slate-400">{label}</span>
                <span className="font-mono text-white">{value}%</span>
            </div>
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${value}%`, background: color, boxShadow: `0 0 8px ${color}55` }} />
            </div>
        </div>
    );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function Badge({ label, ok }: { label: string; ok: boolean }) {
    return (
        <div className="flex items-center gap-2 py-2">
            <span className="material-symbols-outlined text-sm" style={{ color: ok ? "#2ecc71" : "#e67e22" }}>
                {ok ? "check_circle" : "warning"}
            </span>
            <span className="text-sm text-slate-300">{label}</span>
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function ReportPage() {
    const params = useParams();
    const plotId = params.id as string;
    const { floorPlan, analysis, selectedLat, selectedLon } = useEco3DStore();

    const ecoScore = floorPlan ? Math.round(floorPlan.fitness_score * 100) : null;
    const solarScore = floorPlan ? Math.round(floorPlan.sunlight_score * 100) : null;
    const ventScore = floorPlan ? Math.round(floorPlan.ventilation_score * 100) : null;

    const totalArea = floorPlan?.total_area ?? 0;
    const rooms = floorPlan?.layout ?? [];
    const treeCount = floorPlan?.tree_preserved_count ?? 0;

    const buildability = analysis ? Math.round(analysis.buildability_score) : null;
    const floodRisk = analysis ? Math.round(analysis.flood_probability * 100) : null;
    const ndvi = analysis?.environmental?.ndvi ?? null;
    const elevation = analysis?.environmental?.elevation ?? null;
    const lat = selectedLat;
    const lon = selectedLon;

    const roomTypes = useMemo(() =>
        rooms.reduce<Record<string, number>>((acc, r) => {
            const k = r.type.replace(/_/g, " ");
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
        }, {}),
        [rooms]
    );

    const hasData = !!floorPlan;
    const reportDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

    return (
        <>
            <div className="min-h-screen w-full" style={{ background: "#080e0e", fontFamily: "'Space Grotesk', sans-serif" }}>

                {/* ── Header ── */}
                <header className="flex items-center justify-between px-6 py-3 border-b border-white/5 sticky top-0 z-50"
                    style={{ background: "rgba(8,14,14,0.98)", backdropFilter: "blur(12px)" }}>
                    <Link href="/" className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary text-xl">deployed_code</span>
                        <span className="font-bold text-white text-sm">ECO-3D</span>
                    </Link>
                    <div className="flex items-center gap-4">
                        <Link href={`/analysis/${plotId}`}
                            className="text-[11px] text-slate-400 hover:text-white transition-colors flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">arrow_back</span> Analysis
                        </Link>
                        <Link href={`/floorplan/${plotId}`}
                            className="text-[11px] text-slate-400 hover:text-white transition-colors flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">architecture</span> Floor Plan
                        </Link>
                        <Link href={`/model3d/${plotId}`}
                            className="text-[11px] text-primary hover:brightness-110 flex items-center gap-1">
                            <span className="material-symbols-outlined text-sm">view_in_ar</span> 3D Model
                        </Link>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">{plotId}</span>
                </header>

                <div className="max-w-6xl mx-auto px-6 py-10">

                    {/* ── Title ── */}
                    <div className="mb-10 flex items-end justify-between">
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.25em] text-primary font-bold mb-2">ECO-3D PROJECT REPORT</div>
                            <h1 className="text-5xl font-black text-white uppercase tracking-tight mb-2">Site Report</h1>
                            <p className="text-slate-500 text-sm font-mono">{plotId} · Generated {reportDate}</p>
                        </div>
                        {/* Print / Export hint */}
                        <button
                            onClick={() => window.print()}
                            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-[12px] font-bold uppercase tracking-widest transition-all hover:brightness-110"
                            style={{ background: "#0df2f2", color: "#080e0e", boxShadow: "0 0 20px rgba(13,242,242,0.25)" }}>
                            <span className="material-symbols-outlined text-sm">download</span>
                            Export PDF
                        </button>
                    </div>

                    {!hasData && (
                        <div className="rounded-2xl p-16 flex flex-col items-center gap-4 text-center mb-10"
                            style={{ border: "1px solid rgba(13,242,242,0.08)", background: "rgba(10,26,26,0.55)" }}>
                            <span className="material-symbols-outlined text-primary/30 text-6xl">description</span>
                            <p className="text-slate-400 text-sm">No report data available for this plot.<br />Please generate a floor plan first.</p>
                            <Link href={`/analysis/${plotId}`}
                                className="mt-2 px-6 py-2.5 rounded-xl text-[12px] font-bold uppercase tracking-widest"
                                style={{ background: "#0df2f2", color: "#080e0e" }}>
                                Go to Analysis →
                            </Link>
                        </div>
                    )}

                    {/* ── Scores row ── */}
                    {hasData && (
                        <div className="grid grid-cols-3 gap-5 mb-8">
                            <ScorePill score={ecoScore!} label="Eco Fitness Score" />
                            <ScorePill score={solarScore!} label="Sunlight Score" />
                            <ScorePill score={ventScore!} label="Ventilation Score" />
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-6">

                        {/* ── Plot Info ── */}
                        <Section title="Plot Information" icon="location_on">
                            <MetricRow label="Plot ID" value={plotId} />
                            <MetricRow label="Latitude" value={lat != null ? `${fmt(lat, 6)}°` : "—"} />
                            <MetricRow label="Longitude" value={lon != null ? `${fmt(lon, 6)}°` : "—"} />
                            <MetricRow label="Total Built Area" value={totalArea > 0 ? `${fmt(totalArea, 1)} m²` : "—"} />
                            <MetricRow label="Total Rooms" value={rooms.length > 0 ? String(rooms.length) : "—"} />
                            <MetricRow label="Floors" value={rooms.length > 0 ? String(Math.max(...rooms.map(r => r.floor))) : "—"} />
                            <MetricRow label="Trees Preserved" value={treeCount > 0 ? `${treeCount} trees` : "0"} />
                        </Section>

                        {/* ── Environmental ── */}
                        <Section title="Environmental Analysis" icon="eco">
                            <MetricRow label="Buildability Score" value={buildability != null ? `${buildability}%` : "—"} />
                            <MetricRow label="Flood Risk" value={floodRisk != null ? `${floodRisk}%` : "—"}
                                sub={floodRisk != null ? (floodRisk < 20 ? "Low risk" : floodRisk < 50 ? "Moderate" : "High risk") : undefined} />
                            <MetricRow label="NDVI (Greenery)" value={ndvi != null ? fmt(ndvi, 3) : "—"}
                                sub={ndvi != null ? (ndvi > 0.5 ? "Dense vegetation" : ndvi > 0.2 ? "Moderate green" : "Sparse") : undefined} />
                            <MetricRow label="Elevation" value={elevation != null ? `${fmt(elevation, 0)} m` : "—"} />
                            <div className="mt-4 pt-4 border-t border-white/5">
                                <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-3">Compliance Checklist</div>
                                <Badge label="Tree disturbance within limits" ok={treeCount <= 5} />
                                <Badge label="Flood risk acceptable" ok={floodRisk != null && floodRisk < 30} />
                                <Badge label="Buildability threshold met" ok={buildability != null && buildability >= 60} />
                                <Badge label="NDVI sustainability check" ok={ndvi != null && ndvi > 0.15} />
                            </div>
                        </Section>

                        {/* ── Performance ── */}
                        <Section title="Building Performance" icon="speed">
                            <Bar label="Eco Fitness" value={ecoScore ?? 0} color="#0df2f2" />
                            <Bar label="Solar Gain" value={solarScore ?? 0} color="#f59e0b" />
                            <Bar label="Ventilation" value={ventScore ?? 0} color="#3b82f6" />
                            {buildability != null && <Bar label="Buildability" value={buildability} color="#2ecc71" />}
                        </Section>

                        {/* ── Room Schedule ── */}
                        <Section title="Room Breakdown" icon="meeting_room">
                            {rooms.length === 0 ? (
                                <p className="text-slate-500 text-sm">No rooms available.</p>
                            ) : (
                                <>
                                    <div className="grid grid-cols-2 gap-3 mb-4">
                                        {Object.entries(roomTypes).map(([type, count]) => (
                                            <div key={type} className="flex items-center justify-between px-3 py-2 rounded-lg"
                                                style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)" }}>
                                                <span className="text-sm capitalize text-slate-300">{type}</span>
                                                <span className="text-sm font-bold text-primary">{count}×</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="border-t border-white/5 pt-4">
                                        <MetricRow label="Avg Room Area"
                                            value={`${fmt(rooms.reduce((s, r) => s + r.width * r.height, 0) / rooms.length, 1)} m²`} />
                                        <MetricRow label="Largest Room"
                                            value={`${fmt(Math.max(...rooms.map(r => r.width * r.height)), 1)} m²`} />
                                        <MetricRow label="Smallest Room"
                                            value={`${fmt(Math.min(...rooms.map(r => r.width * r.height)), 1)} m²`} />
                                    </div>
                                </>
                            )}
                        </Section>

                    </div>

                    {/* ── Navigation footer ── */}
                    <div className="mt-10 flex items-center justify-between pt-8 border-t border-white/5">
                        <div className="flex gap-3">
                            <Link href={`/floorplan/${plotId}`}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12px] font-bold uppercase tracking-widest transition-all hover:bg-white/5"
                                style={{ border: "1px solid rgba(13,242,242,0.2)", color: "#0df2f2" }}>
                                <span className="material-symbols-outlined text-sm">architecture</span>Floor Plan
                            </Link>
                            <Link href={`/model3d/${plotId}`}
                                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-[12px] font-bold uppercase tracking-widest transition-all hover:bg-white/5"
                                style={{ border: "1px solid rgba(13,242,242,0.2)", color: "#0df2f2" }}>
                                <span className="material-symbols-outlined text-sm">view_in_ar</span>3D Model
                            </Link>
                        </div>
                        <p className="text-[10px] font-mono text-slate-600">ECO-3D Platform · AI-Powered Architecture · {reportDate}</p>
                    </div>

                </div>
            </div>
        </>
    );
}
