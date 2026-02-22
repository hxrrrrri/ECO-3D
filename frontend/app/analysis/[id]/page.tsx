"use client";

import { useCallback, useRef, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { generateFloorPlan } from "@/lib/api";

interface Room { type: string; width: number; height: number; x: number; y: number; floor: number; }
interface Tree { lat: number; lon: number; confidence: number; }

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

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} className="relative w-11 h-6 rounded-full transition-all duration-300" style={{ background: on ? "#0df2f2" : "rgba(255,255,255,0.1)" }}>
      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all duration-300" style={{ left: on ? "22px" : "2px" }} />
    </button>
  );
}

function BlueprintCanvas({ rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow }:
  { rooms: Room[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const draw = useCallback((t: number) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.offsetWidth || 620; const H = canvas.offsetHeight || 580;
    canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a1a1a"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(13,242,242,0.04)"; ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (rooms.length === 0) {
      ctx.fillStyle = "rgba(13,242,242,0.2)"; ctx.font = "12px monospace";
      ctx.textAlign = "center"; ctx.fillText("SELECT A PLOT TO GENERATE BLUEPRINT", W / 2, H / 2); return;
    }
    const SCALE = zoom;
    const maxX = Math.max(...rooms.map(r => r.x + r.width));
    const maxY = Math.max(...rooms.map(r => r.y + r.height));
    const offX = (W - maxX * SCALE) / 2;
    const offY = (H - maxY * SCALE) / 2;
    const PAD = 50;
    const bx = offX - PAD; const by = offY - PAD;
    const bw = maxX * SCALE + PAD * 2; const bh = maxY * SCALE + PAD * 2;
    ctx.setLineDash([6, 4]); ctx.strokeStyle = "rgba(13,242,242,0.25)"; ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh); ctx.setLineDash([]);
    ctx.font = "10px monospace"; ctx.fillStyle = "rgba(13,242,242,0.45)";
    [["left", "top", `P1 [${lat.toFixed(2)}, ${lon.toFixed(2)}]`, bx + 4, by - 8],
    ["right", "top", `P2 [${(lat + 0.001).toFixed(3)}, ${lon.toFixed(2)}]`, bx + bw - 4, by - 8],
    ["right", "bot", `P3 [${(lat + 0.001).toFixed(3)}, ${(lon + 0.001).toFixed(3)}]`, bx + bw - 4, by + bh + 14],
    ["left", "bot", `P4 [${lat.toFixed(2)}, ${(lon + 0.001).toFixed(3)}]`, bx + 4, by + bh + 14]
    ].forEach(([ha, , text, x, y]) => { ctx.textAlign = ha === "left" ? "left" : "right"; ctx.fillText(text as string, x as number, y as number); });
    if (showSolarPath) {
      const pulse = 0.6 + 0.4 * Math.sin(t * 0.002);
      ctx.save(); ctx.strokeStyle = `rgba(245,158,11,${pulse})`; ctx.lineWidth = 2; ctx.fillStyle = `rgba(245,158,11,${pulse})`;
      [[bx + bw * 0.25, by + 40, bx + bw * 0.55, by + bh * 0.3], [bx + bw * 0.45, by + 20, bx + bw * 0.75, by + bh * 0.25]].forEach(([x1, y1, x2, y2]) => {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        const a = Math.atan2(y2 - y1, x2 - x1);
        ctx.lineTo(x2 - 10 * Math.cos(a - 0.4), y2 - 10 * Math.sin(a - 0.4)); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - 10 * Math.cos(a + 0.4), y2 - 10 * Math.sin(a + 0.4)); ctx.stroke();
      }); ctx.restore();
    }
    if (showWindFlow) {
      const wt = (t * 0.001) % 1; ctx.save(); ctx.strokeStyle = "rgba(59,130,246,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([4, 8]);
      for (let i = 0; i < 4; i++) { const wy = offY + (i + 0.5) * (maxY * SCALE / 4); ctx.beginPath(); ctx.moveTo(bx - 20 + (wt * 40) % 40, wy); ctx.lineTo(bx + bw + 20, wy); ctx.stroke(); }
      ctx.setLineDash([]); ctx.restore();
    }
    const COLS: Record<string, [string, string]> = { living: ["rgba(13,242,242,0.12)", "#0df2f2"], kitchen: ["rgba(46,204,113,0.12)", "#2ecc71"], bedroom: ["rgba(52,152,219,0.12)", "#3498db"], bathroom: ["rgba(155,89,182,0.12)", "#9b59b6"], office: ["rgba(241,196,15,0.12)", "#f1c40f"], garage: ["rgba(127,140,141,0.12)", "#7f8c8d"] };
    rooms.forEach(room => {
      const rx = offX + room.x * SCALE; const ry = offY + room.y * SCALE; const rw = room.width * SCALE; const rh = room.height * SCALE;
      const k = Object.keys(COLS).find(k => room.type.toLowerCase().includes(k)) || "living";
      const [fill, stroke] = COLS[k];
      ctx.fillStyle = fill; ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = stroke; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(room.type.toUpperCase().replace(/_/g, " "), rx + rw / 2, ry + rh / 2 - 4);
      ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.font = "9px monospace";
      ctx.fillText(`A: ${(room.width * room.height).toFixed(0)}m\u00b2  P: ${(2 * (room.width + room.height)).toFixed(0)}m`, rx + rw / 2, ry + rh / 2 + 10);
    });
    trees.forEach((tree, i) => {
      const tx = offX + ((i % 3) * 2 + 1) * SCALE; const ty = offY + (Math.floor(i / 3) * 2 + 1) * SCALE;
      const pulse = 0.7 + 0.3 * Math.sin(t * 0.003 + i);
      ctx.beginPath(); ctx.arc(tx, ty, 18 * pulse, 0, Math.PI * 2); ctx.fillStyle = `rgba(46,204,113,${0.15 * pulse})`; ctx.fill();
      ctx.strokeStyle = `rgba(46,204,113,${0.6 * pulse})`; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(tx, ty, 6, 0, Math.PI * 2); ctx.fillStyle = "#2ecc71"; ctx.fill();
      ctx.fillStyle = "rgba(46,204,113,0.8)"; ctx.font = "9px monospace"; ctx.textAlign = "center";
      ctx.fillText(`ID-T0${i + 1}`, tx, ty + 28); if (tree.confidence < 0.9) ctx.fillText("(Legacy)", tx, ty + 39);
    });
    ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, H - 30, W, 30);
    ctx.fillStyle = "rgba(13,242,242,0.5)"; ctx.font = "10px monospace"; ctx.textAlign = "left";
    ctx.fillText("\u25cf Sun Exp: 8.2h/day   \u25cf Airflow: 1.4 m/s", 16, H - 10);
    rafRef.current = requestAnimationFrame(draw);
  }, [rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow]);

  useEffect(() => { rafRef.current = requestAnimationFrame(draw); return () => cancelAnimationFrame(rafRef.current); }, [draw]);
  return <canvas ref={canvasRef} className="w-full h-full" style={{ display: "block" }} />;
}

export default function AnalysisPage() {
  const params = useParams(); const router = useRouter();
  const plotId = params.id as string;

  const [houseType, setHouseType] = useState("Eco-Villa (Single Story)");
  const [targetArea, setTargetArea] = useState("240");
  const [treePres, setTreePres] = useState(true);
  const [maxSun, setMaxSun] = useState(true);
  const [natVent, setNatVent] = useState(false);
  const [sustPrio, setSustPrio] = useState(true);
  const [showSolar, setShowSolar] = useState(true);
  const [showWind, setShowWind] = useState(true);
  const [zoom, setZoom] = useState(14);
  const [generating, setGenerating] = useState(false);
  const [logs, setLogs] = useState([
    { time: "12:04:12", msg: "Footprint shifted 2.4m North to avoid T01 root system." },
    { time: "12:04:11", msg: "Living area windows rotated 15° for max solar gain." },
    { time: "12:04:09", msg: "Cross-ventilation path established via West-East axis." },
  ]);
  const { analysis, floorPlan, selectedLat, selectedLon, setFloorPlan, setGeneratingFloorPlan } = useEco3DStore();
  const lat = selectedLat ?? 34.0522;
  const lon = selectedLon ?? -118.2437;
  const rooms: Room[] = floorPlan?.layout ?? [];
  const trees: Tree[] = analysis?.tree_coordinates?.slice(0, 4) ?? [
    { lat: 34.053, lon: -118.244, confidence: 0.97 }, { lat: 34.052, lon: -118.243, confidence: 0.82 },
  ];
  const ecoScore = floorPlan ? Math.round(floorPlan.fitness_score * 100) : (analysis ? Math.round(analysis.buildability_score) : 94);
  const solarPct = floorPlan ? Math.round(floorPlan.sunlight_score * 100) : 88;
  const ventPct = floorPlan ? Math.round(floorPlan.ventilation_score * 100) : 95;
  const treeDist = floorPlan?.tree_preserved_count ?? 0;

  // Auto-generate floor plan if we have analysis data but no floor plan yet
  useEffect(() => {
    if (!floorPlan && plotId && analysis) {
      handleRegenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotId]);

  const addLog = (msg: string) => {
    const n = new Date();
    const t = `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}:${String(n.getSeconds()).padStart(2, "0")}`;
    setLogs(prev => [{ time: t, msg }, ...prev].slice(0, 8));
  };

  const handleRegenerate = async () => {
    setGenerating(true); addLog("AI optimizer re-initializing genetic algorithm...");
    try {
      const fp = await generateFloorPlan({ plot_id: plotId, plot_area_sqm: parseFloat(targetArea) || 240, preserve_trees: treePres });
      setFloorPlan(fp); setGeneratingFloorPlan(false);
      addLog(`Layout optimized — ${fp.layout.length} rooms, fitness ${(fp.fitness_score * 100).toFixed(0)}%`);
      if (treePres) addLog(`Tree preservation: ${fp.tree_preserved_count} protected.`);
    } catch { addLog("Generation failed — check backend."); } finally { setGenerating(false); }
  };

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>{`body{background:#080e0e} .gl{background:rgba(10,26,26,0.7);backdrop-filter:blur(10px);border:1px solid rgba(13,242,242,0.08)} .glm{background:rgba(13,242,242,0.04);border:1px solid rgba(13,242,242,0.1)} @keyframes aip{0%,100%{opacity:1}50%{opacity:0.5}} .aip{animation:aip 2s ease-in-out infinite}`}</style>
      <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: "#080e0e", fontFamily: "'Space Grotesk',sans-serif" }}>
        {/* Nav */}
        <header className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/5" style={{ background: "rgba(8,14,14,0.98)" }}>
          <Link href="/" className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-2xl">deployed_code</span>
            <div><div className="text-white font-bold text-base tracking-tight">ECO-3D <span className="text-primary/60 font-light">Studio</span></div>
              <div className="text-[9px] text-slate-500 uppercase tracking-[0.15em]">AI GENERATIVE ARCHITECTURE</div></div>
          </Link>
          <nav className="flex items-center gap-1">
            {[{ l: "Project Alpha", h: `/map` }, { l: "Blueprint Generator", h: `/analysis/${plotId}`, a: true }, { l: "Environmental Data", h: `/environment/${plotId}` }, { l: "Export", h: `/report/${plotId}` }].map(item => (
              <Link key={item.l} href={item.h} className={`px-4 py-2 text-[12px] font-medium transition-all ${item.a ? "text-primary border-b-2 border-primary" : "text-slate-400 hover:text-white"}`}>{item.l}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <button className="w-8 h-8 gl rounded-lg flex items-center justify-center"><span className="material-symbols-outlined text-slate-400 text-lg">notifications</span></button>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-[#080e0e] font-bold text-sm" style={{ background: "linear-gradient(135deg,#0df2f2,#0a9a9a)" }}>A</div>
          </div>
        </header>

        <div className="flex-1 flex overflow-hidden">
          {/* LEFT */}
          <aside className="w-72 flex-shrink-0 flex flex-col border-r border-white/5 overflow-y-auto" style={{ background: "rgba(6,12,12,0.98)" }}>
            <div className="p-5 flex flex-col gap-5 flex-1">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">Configuration</div>
                <div className="mb-4">
                  <label className="text-[11px] text-slate-400 mb-1.5 block">House Type</label>
                  <select value={houseType} onChange={e => setHouseType(e.target.value)} className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white appearance-none cursor-pointer focus:outline-none" style={{ background: "rgba(13,242,242,0.04)" }}>
                    {["Eco-Villa (Single Story)", "Modern Apartment", "Sustainable Townhouse", "Green Duplex", "Solar Passive House"].map(t => <option key={t} value={t} style={{ background: "#0a1a1a" }}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-slate-400 mb-1.5 block">Target Area</label>
                  <div className="flex items-center gap-2">
                    <input type="number" value={targetArea} onChange={e => setTargetArea(e.target.value)} className="flex-1 glm rounded-lg px-3 py-2.5 text-[12px] text-white focus:outline-none" style={{ background: "rgba(13,242,242,0.04)" }} />
                    <span className="text-[11px] text-slate-400">m²</span>
                  </div>
                </div>
              </div>
              <div className="h-px bg-white/5" />
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">AI Constraints</div>
                <div className="flex flex-col gap-3.5">
                  {[{ l: "Tree Preservation", v: treePres, s: setTreePres }, { l: "Maximize Sunlight", v: maxSun, s: setMaxSun }, { l: "Natural Ventilation", v: natVent, s: setNatVent }, { l: "Sustainability Priority", v: sustPrio, s: setSustPrio }].map(({ l, v, s }) => (
                    <div key={l} className="flex items-center justify-between"><span className="text-[12px] text-slate-300">{l}</span><Toggle on={v} onChange={() => s(!v)} /></div>
                  ))}
                </div>
              </div>
              <div className="mt-auto flex flex-col gap-3">
                <button onClick={handleRegenerate} disabled={generating} className="w-full py-3.5 rounded-xl font-bold text-[13px] tracking-wide flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: generating ? "rgba(13,242,242,0.3)" : "#0df2f2", color: "#080e0e", boxShadow: generating ? "none" : "0 0 20px rgba(13,242,242,0.3)" }}>
                  <span className="material-symbols-outlined text-lg">{generating ? "sync" : "auto_fix_high"}</span>
                  {generating ? "Optimizing..." : "Regenerate Layout"}
                </button>
                <div className="text-center">
                  <div className="text-[10px] text-slate-500">Last AI calculation: 12s ago</div>
                  <div className="text-[10px] text-slate-400">Optimization score: <span className="text-primary font-bold">{ecoScore}%</span></div>
                </div>
              </div>
            </div>
          </aside>

          {/* CENTER */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-white/5">
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-white/5" style={{ background: "rgba(8,14,14,0.98)" }}>
              <div className="flex items-center gap-2 glm px-3 py-1.5 rounded-full">
                <span className="w-2 h-2 rounded-full bg-primary aip" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary">AI LIVE: OPTIMIZING BOUNDARIES</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="glm px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-slate-300">X: {lat.toFixed(4)}° N</div>
                <div className="glm px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-slate-300">Y: {lon.toFixed(4)}° W</div>
              </div>
              <div className="gl px-3 py-2 rounded-lg">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Map Legend</div>
                {[{ c: "#2ecc71", l: "Protected Trees", sq: false }, { c: "#0df2f2", l: "House Footprint", sq: true }, { c: "#f59e0b", l: "Solar Path", sq: false }, { c: "#3b82f6", l: "Wind Flow", sq: false }].map(({ c, l, sq }) => (
                  <div key={l} className="flex items-center gap-2 mb-1">
                    <span className="flex-shrink-0" style={{ width: sq ? 12 : 12, height: sq ? 12 : 4, background: sq ? "transparent" : c, border: sq ? `1px solid ${c}` : "none", display: "inline-block" }} />
                    <span className="text-[10px] text-slate-400">{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 relative overflow-hidden" style={{ background: "#0a1a1a" }}>
              <BlueprintCanvas rooms={rooms} trees={trees} lat={lat} lon={lon} zoom={zoom} showSolarPath={showSolar} showWindFlow={showWind} />
              <div className="absolute bottom-4 right-4 flex flex-col gap-1">
                {[{ i: "add", a: () => setZoom(z => Math.min(z + 2, 28)) }, { i: "remove", a: () => setZoom(z => Math.max(z - 2, 6)) }, { i: "center_focus_strong", a: () => setZoom(14) }].map(({ i, a }) => (
                  <button key={i} onClick={a} className="w-9 h-9 gl rounded-lg flex items-center justify-center hover:text-primary transition-all text-slate-400">
                    <span className="material-symbols-outlined text-lg">{i}</span>
                  </button>
                ))}
              </div>
              <div className="absolute top-3 left-3 flex flex-col gap-1.5">
                {[{ l: "Solar", on: showSolar, s: setShowSolar, c: "#f59e0b" }, { l: "Wind", on: showWind, s: setShowWind, c: "#3b82f6" }].map(({ l, on, s, c }) => (
                  <button key={l} onClick={() => s(!on)} className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide transition-all"
                    style={{ background: on ? `${c}22` : "rgba(0,0,0,0.5)", border: `1px solid ${on ? c : "rgba(255,255,255,0.05)"}`, color: on ? c : "#475569" }}>{l}</button>
                ))}
              </div>
              <button onClick={() => router.push(`/model3d/${plotId}`)} className="absolute bottom-4 left-4 flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest"
                style={{ background: "#0df2f2", color: "#080e0e", boxShadow: "0 0 16px rgba(13,242,242,0.25)" }}>
                <span className="material-symbols-outlined text-sm">view_in_ar</span>View 3D Model
              </button>
            </div>
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-t border-white/5 text-[10px] font-mono text-slate-500" style={{ background: "rgba(8,14,14,0.98)" }}>
              <span>⬡ LAYER: TECHNICAL BLUEPRINT 2.0</span>
              <span>⊙ SITE: {plotId || "LA-P92"}</span>
              <div className="flex items-center gap-3">
                <button className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"><span className="material-symbols-outlined text-sm">download</span>Export CAD</button>
                <button className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"><span className="material-symbols-outlined text-sm">share</span>Share Link</button>
                <button onClick={handleRegenerate} className="flex items-center gap-1 px-3 py-1 rounded font-bold text-[10px]" style={{ background: "#0df2f2", color: "#080e0e" }}>Save Design</button>
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <aside className="w-60 flex-shrink-0 flex flex-col overflow-y-auto" style={{ background: "rgba(6,12,12,0.98)" }}>
            <div className="p-4 flex flex-col gap-5 flex-1">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-4">Efficiency HUD</div>
                <div className="flex justify-center mb-4"><EcoScoreRing score={ecoScore} /></div>
                <EffBar label="Solar Gain" value={solarPct} status={solarPct > 80 ? "High" : "Medium"} color="#f59e0b" />
                <EffBar label="Wind Ventilation" value={ventPct} status={ventPct > 80 ? "Optimized" : "Moderate"} color="#0df2f2" />
                <EffBar label="Tree Disturbance" value={treeDist === 0 ? 0 : 100 - treeDist * 10} status={treeDist === 0 ? "Zero" : `${treeDist} trees`} color="#2ecc71" />
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
                <div className="glm p-3 rounded-lg">
                  <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-2">Plot Analysis</div>
                  {[{ k: "Buildability", v: `${analysis.buildability_score.toFixed(0)}%` }, { k: "Flood Risk", v: `${(analysis.flood_probability * 100).toFixed(0)}%` }, { k: "NDVI", v: analysis.environmental.ndvi.toFixed(3) }, { k: "Elevation", v: `${analysis.environmental.elevation.toFixed(0)}m` }].map(({ k, v }) => (
                    <div key={k} className="flex justify-between py-1 border-b border-white/5">
                      <span className="text-[10px] text-slate-500">{k}</span><span className="text-[10px] font-mono text-slate-200">{v}</span>
                    </div>
                  ))}
                  {analysis.score_references && (
                    <div className="mt-3 pt-3 border-t border-white/10">
                      <div className="text-[9px] uppercase tracking-widest text-primary/60 mb-1.5">Methodology Citations</div>
                      <div className="flex flex-col gap-1.5">
                        {analysis.score_references.map((ref, idx) => (
                          <div key={idx} className="text-[9px] text-slate-400 border-l border-primary/30 pl-1.5">{ref}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button onClick={() => router.push(`/report/${plotId}`)} className="w-full py-2.5 rounded-lg text-[11px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-primary/10 transition-all" style={{ border: "1px solid #0df2f2", color: "#0df2f2" }}>
                <span className="material-symbols-outlined text-sm">assessment</span>View Detailed Report
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
