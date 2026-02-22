"use client";

import { useCallback, useRef, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { generateFloorPlan } from "@/lib/api";

interface Room { type: string; width: number; height: number; x: number; y: number; floor: number; orientation: string; }
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

// Professional Architectural Floor Plan Canvas
function BlueprintCanvas({ rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow, floorPlan }:
  { rooms: Room[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; floorPlan: any; }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const ROOM_STYLE: Record<string, { fill: string; stroke: string; label: string }> = {
    living:   { fill: "rgba(13,200,200,0.1)",  stroke: "#0bc8c8", label: "LIVING ROOM" },
    bedroom:  { fill: "rgba(52,130,210,0.1)",   stroke: "#3482d2", label: "BEDROOM" },
    kitchen:  { fill: "rgba(46,180,100,0.1)",   stroke: "#2eb464", label: "KITCHEN" },
    bathroom: { fill: "rgba(140,80,170,0.1)",   stroke: "#8c50aa", label: "BATHROOM" },
    office:   { fill: "rgba(220,170,10,0.1)",   stroke: "#dcaa0a", label: "OFFICE" },
    garage:   { fill: "rgba(110,125,125,0.1)",  stroke: "#6e7d7d", label: "GARAGE" },
    utility:  { fill: "rgba(210,110,20,0.1)",   stroke: "#d26e14", label: "UTILITY" },
    dining:   { fill: "rgba(210,80,80,0.1)",    stroke: "#d25050", label: "DINING" },
    corridor: { fill: "rgba(180,180,180,0.05)", stroke: "#909090", label: "CORRIDOR" },
  };

  const getRoomStyle = (type: string) => {
    const k = Object.keys(ROOM_STYLE).find(k => type.toLowerCase().includes(k));
    return k ? ROOM_STYLE[k] : { fill: "rgba(13,242,242,0.07)", stroke: "#0df2f2", label: type.toUpperCase().replace(/_/g, " ") };
  };

  const drawFurniture = (ctx: CanvasRenderingContext2D, type: string, rx: number, ry: number, rw: number, rh: number, stroke: string) => {
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    const t = type.toLowerCase();
    if (t.includes("living")) {
      // Sofa
      const sw = rw * 0.58; const sh = rh * 0.18; const sx = rx + rw * 0.1; const sy = ry + rh * 0.7;
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.strokeRect(sx, sy - sh * 0.6, sw * 0.16, sh * 0.6);
      ctx.strokeRect(sx + sw - sw * 0.16, sy - sh * 0.6, sw * 0.16, sh * 0.6);
      // Coffee table
      ctx.strokeRect(rx + rw * 0.28, ry + rh * 0.4, rw * 0.38, rh * 0.18);
      // TV unit
      ctx.strokeRect(rx + rw * 0.2, ry + rh * 0.08, rw * 0.55, rh * 0.06);
    } else if (t.includes("bedroom")) {
      // Bed
      const bw = Math.min(rw * 0.72, rh * 0.68); const bh = bw * 0.72;
      const bx = rx + (rw - bw) / 2; const by = ry + rh * 0.12;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.strokeRect(bx + bw * 0.08, by + bh * 0.04, bw * 0.37, bh * 0.22);
      ctx.strokeRect(bx + bw * 0.55, by + bh * 0.04, bw * 0.37, bh * 0.22);
      ctx.strokeRect(bx, by - bh * 0.09, bw, bh * 0.09); // headboard
      ctx.strokeRect(bx - bw * 0.2, by, bw * 0.16, bw * 0.16); // bedside
      ctx.strokeRect(bx + bw + bw * 0.04, by, bw * 0.16, bw * 0.16);
    } else if (t.includes("kitchen")) {
      ctx.strokeRect(rx + 2, ry + 2, rw - 4, rh * 0.16); // counter top
      ctx.strokeRect(rx + 2, ry + 2, rw * 0.16, rh - 4); // counter left
      // Stove
      const stx = rx + rw * 0.28; const sty = ry + rh * 0.04;
      ctx.strokeRect(stx, sty, rw * 0.26, rh * 0.14);
      ctx.beginPath(); ctx.arc(stx + rw * 0.07, sty + rh * 0.07, rw * 0.04, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(stx + rw * 0.19, sty + rh * 0.07, rw * 0.04, 0, Math.PI * 2); ctx.stroke();
      // Sink
      ctx.strokeRect(rx + rw * 0.63, ry + 2, rw * 0.2, rh * 0.16);
      ctx.beginPath(); ctx.arc(rx + rw * 0.73, ry + rh * 0.09, rh * 0.025, 0, Math.PI * 2); ctx.stroke();
    } else if (t.includes("bathroom")) {
      // Toilet
      ctx.strokeRect(rx + rw * 0.08, ry + rh * 0.6, rw * 0.32, rh * 0.3);
      ctx.beginPath(); ctx.ellipse(rx + rw * 0.24, ry + rh * 0.76, rw * 0.12, rh * 0.1, 0, 0, Math.PI * 2); ctx.stroke();
      // Sink
      ctx.strokeRect(rx + rw * 0.54, ry + rh * 0.6, rw * 0.32, rh * 0.26);
      ctx.beginPath(); ctx.arc(rx + rw * 0.7, ry + rh * 0.73, rw * 0.08, 0, Math.PI * 2); ctx.stroke();
      // Bathtub/shower
      ctx.strokeRect(rx + rw * 0.06, ry + rh * 0.05, rw * 0.88, rh * 0.45);
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(rx + rw * 0.5, ry + rh * 0.27, rh * 0.12, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    } else if (t.includes("office")) {
      ctx.strokeRect(rx + rw * 0.08, ry + rh * 0.08, rw * 0.72, rh * 0.25);
      ctx.beginPath(); ctx.arc(rx + rw * 0.44, ry + rh * 0.5, rh * 0.13, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeRect(rx + rw * 0.08, ry + rh * 0.72, rw * 0.82, rh * 0.2);
    } else if (t.includes("dining")) {
      const tw = rw * 0.58; const th = rh * 0.4;
      const tx = rx + (rw - tw) / 2; const ty = ry + (rh - th) / 2;
      ctx.strokeRect(tx, ty, tw, th);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath(); ctx.ellipse(tx + tw * (0.18 + i * 0.32), ty - th * 0.14, tw * 0.1, th * 0.1, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(tx + tw * (0.18 + i * 0.32), ty + th + th * 0.14, tw * 0.1, th * 0.1, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  const draw = useCallback((_t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.offsetWidth || 640;
    const H = canvas.offsetHeight || 580;
    canvas.width = W; canvas.height = H;

    ctx.fillStyle = "#0b1515"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(13,242,242,0.022)"; ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    if (rooms.length === 0) {
      ctx.fillStyle = "rgba(13,242,242,0.25)"; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
      ctx.fillText("AWAITING FLOOR PLAN GENERATION", W / 2, H / 2 - 14);
      ctx.fillStyle = "rgba(13,242,242,0.12)"; ctx.font = "10px monospace";
      ctx.fillText("Select a plot and run analysis to generate architectural layout", W / 2, H / 2 + 10);
      return;
    }

    const SCALE = zoom;
    const WALL_T = Math.max(4, zoom * 0.22);
    const maxX = Math.max(...rooms.map(r => r.x + r.width));
    const maxY = Math.max(...rooms.map(r => r.y + r.height));
    const PAD = 60;
    const offX = (W - maxX * SCALE) / 2;
    const offY = (H - maxY * SCALE) / 2;

    // Solar arc
    if (showSolarPath) {
      ctx.save(); ctx.strokeStyle = "rgba(245,158,11,0.28)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const a = (Math.PI * i) / 30;
        const sx = offX - PAD + (maxX * SCALE + PAD * 2) * (i / 30);
        const sy = offY - PAD * 1.4 - Math.sin(a) * 36;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "rgba(245,158,11,0.5)"; ctx.beginPath(); ctx.arc(offX - PAD + (maxX * SCALE + PAD * 2) * 0.75, offY - PAD * 1.55, 7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Plot boundary
    ctx.strokeStyle = "rgba(13,242,242,0.16)"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.strokeRect(offX - PAD, offY - PAD, maxX * SCALE + PAD * 2, maxY * SCALE + PAD * 2); ctx.setLineDash([]);
    ctx.font = "8px monospace"; ctx.fillStyle = "rgba(13,242,242,0.38)"; ctx.textAlign = "left";
    ctx.fillText(`${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E`, offX - PAD + 2, offY - PAD - 4);

    // Pass 1: room fills
    rooms.forEach(room => {
      if (room.floor !== 1) return;
      const rx = offX + room.x * SCALE; const ry = offY + room.y * SCALE;
      const rw = room.width * SCALE; const rh = room.height * SCALE;
      ctx.fillStyle = getRoomStyle(room.type).fill;
      ctx.fillRect(rx, ry, rw, rh);
    });

    // Pass 2: thick walls
    rooms.forEach(room => {
      if (room.floor !== 1) return;
      const rx = offX + room.x * SCALE; const ry = offY + room.y * SCALE;
      const rw = room.width * SCALE; const rh = room.height * SCALE;
      const style = getRoomStyle(room.type);
      ctx.fillStyle = "#1e3535";
      ctx.fillRect(rx - WALL_T / 2, ry - WALL_T, rw + WALL_T, WALL_T);
      ctx.fillRect(rx - WALL_T / 2, ry + rh, rw + WALL_T, WALL_T);
      ctx.fillRect(rx - WALL_T, ry - WALL_T, WALL_T, rh + WALL_T * 2);
      ctx.fillRect(rx + rw, ry - WALL_T, WALL_T, rh + WALL_T * 2);
      ctx.strokeStyle = style.stroke; ctx.lineWidth = 1.5; ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(255,255,255,0.1)"; ctx.lineWidth = 0.5;
      ctx.strokeRect(rx - WALL_T, ry - WALL_T, rw + WALL_T * 2, rh + WALL_T * 2);
    });

    // Pass 3: doors
    rooms.forEach((room, idx) => {
      if (room.floor !== 1) return;
      const rx = offX + room.x * SCALE; const ry = offY + room.y * SCALE;
      const rw = room.width * SCALE; const rh = room.height * SCALE;
      const dw = Math.min(rw * 0.42, SCALE * 0.88);
      const side = idx % 3 === 2 ? "right" : "bottom";
      if (side === "bottom") {
        const dx = rx + (rw - dw) / 2;
        ctx.fillStyle = "#0b1515"; ctx.fillRect(dx, ry + rh - 1, dw, WALL_T + 2);
        ctx.strokeStyle = "rgba(220,210,180,0.85)"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(dx, ry + rh); ctx.lineTo(dx + dw, ry + rh); ctx.stroke();
        ctx.strokeStyle = "rgba(220,210,180,0.3)"; ctx.lineWidth = 0.9; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.arc(dx, ry + rh, dw, 0, Math.PI / 2); ctx.stroke(); ctx.setLineDash([]);
      } else {
        const dy = ry + (rh - dw) / 2;
        ctx.fillStyle = "#0b1515"; ctx.fillRect(rx + rw - 1, dy, WALL_T + 2, dw);
        ctx.strokeStyle = "rgba(220,210,180,0.85)"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(rx + rw, dy); ctx.lineTo(rx + rw, dy + dw); ctx.stroke();
        ctx.strokeStyle = "rgba(220,210,180,0.3)"; ctx.lineWidth = 0.9; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.arc(rx + rw, dy, dw, Math.PI / 2, Math.PI); ctx.stroke(); ctx.setLineDash([]);
      }
    });

    // Pass 4: windows
    rooms.forEach(room => {
      if (room.floor !== 1) return;
      const rx = offX + room.x * SCALE; const ry = offY + room.y * SCALE;
      const rw = room.width * SCALE; const rh = room.height * SCALE;
      const t = room.type.toLowerCase();
      if (t.includes("bathroom") || t.includes("utility")) return;
      // Top window
      const ww = rw * 0.42; const wx = rx + (rw - ww) / 2;
      ctx.fillStyle = "rgba(125,211,212,0.2)"; ctx.fillRect(wx, ry - WALL_T, ww, WALL_T);
      ctx.strokeStyle = "#7dd3d4"; ctx.lineWidth = 1.2; ctx.strokeRect(wx, ry - WALL_T, ww, WALL_T);
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(wx + ww / 3, ry - WALL_T); ctx.lineTo(wx + ww / 3, ry);
      ctx.moveTo(wx + (2*ww)/3, ry - WALL_T); ctx.lineTo(wx + (2*ww)/3, ry); ctx.stroke();
      // Side window for large rooms
      if (rw > SCALE * 4) {
        const wh = rh * 0.36; const wy = ry + (rh - wh) / 2;
        ctx.fillStyle = "rgba(125,211,212,0.2)"; ctx.fillRect(rx + rw, wy, WALL_T, wh);
        ctx.strokeStyle = "#7dd3d4"; ctx.lineWidth = 1.2; ctx.strokeRect(rx + rw, wy, WALL_T, wh);
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(rx+rw, wy+wh/3); ctx.lineTo(rx+rw+WALL_T, wy+wh/3);
        ctx.moveTo(rx+rw, wy+(2*wh)/3); ctx.lineTo(rx+rw+WALL_T, wy+(2*wh)/3); ctx.stroke();
      }
    });

    // Pass 5: furniture
    rooms.forEach(room => {
      if (room.floor !== 1) return;
      const rx = offX + room.x * SCALE + WALL_T; const ry = offY + room.y * SCALE + WALL_T;
      const rw = room.width * SCALE - WALL_T * 2; const rh = room.height * SCALE - WALL_T * 2;
      if (rw > 40 && rh > 40) drawFurniture(ctx, room.type, rx, ry, rw, rh, getRoomStyle(room.type).stroke);
    });

    // Pass 6: labels + dims
    rooms.forEach(room => {
      if (room.floor !== 1) return;
      const rx = offX + room.x * SCALE; const ry = offY + room.y * SCALE;
      const rw = room.width * SCALE; const rh = room.height * SCALE;
      const style = getRoomStyle(room.type);
      const cx = rx + rw / 2; const cy = ry + rh / 2;
      ctx.fillStyle = style.stroke; ctx.font = `bold ${Math.max(8, Math.min(11, rw / 8))}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(style.label, cx, cy - 7);
      const wFt = (room.width * 3.281).toFixed(1); const hFt = (room.height * 3.281).toFixed(1);
      ctx.fillStyle = "rgba(255,255,255,0.42)"; ctx.font = `${Math.max(7, Math.min(9, rw/11))}px monospace`;
      ctx.fillText(`${wFt}' × ${hFt}'`, cx, cy + 6);
      ctx.fillStyle = "rgba(255,255,255,0.22)"; ctx.font = "7px monospace";
      ctx.fillText(`${(room.width * room.height).toFixed(0)} m²`, cx, cy + 16);
      // Dimension line top
      if (rw > 55) {
        ctx.strokeStyle = "rgba(200,200,200,0.4)"; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(rx, ry - WALL_T - 6); ctx.lineTo(rx + rw, ry - WALL_T - 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(rx, ry-WALL_T-9); ctx.lineTo(rx, ry-WALL_T-3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(rx+rw, ry-WALL_T-9); ctx.lineTo(rx+rw, ry-WALL_T-3); ctx.stroke();
        ctx.fillStyle = "rgba(200,200,200,0.55)"; ctx.font = "7px monospace";
        ctx.fillText(`${room.width.toFixed(1)}m`, cx, ry - WALL_T - 9);
      }
    });

    // Wind flow
    if (showWindFlow) {
      ctx.save(); ctx.strokeStyle = "rgba(59,130,246,0.22)"; ctx.lineWidth = 1; ctx.setLineDash([4, 8]);
      for (let i = 0; i < 5; i++) {
        const wy = offY + (i + 0.5) * (maxY * SCALE / 5);
        ctx.beginPath(); ctx.moveTo(offX - PAD - 18, wy); ctx.lineTo(offX - PAD + maxX * SCALE + PAD * 2 + 18, wy); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.fillStyle = "rgba(59,130,246,0.5)"; ctx.font = "8px monospace";
      ctx.textAlign = "left"; ctx.fillText("↓ PREVAILING WIND", offX - PAD + 4, offY - PAD + 14); ctx.restore();
    }

    // Trees (outside building)
    trees.forEach((_, i) => {
      const tx = offX - PAD * 0.6 + (i % 2) * SCALE * 1.4;
      const ty = offY - PAD * 0.55;
      ctx.beginPath(); ctx.arc(tx, ty, 9, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(46,204,113,0.18)"; ctx.fill();
      ctx.strokeStyle = "#2ecc71"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "#2ecc71"; ctx.font = "7px monospace"; ctx.textAlign = "center";
      ctx.fillText(`T${i+1}`, tx, ty + 3);
    });

    // North arrow
    const nx = W - 38; const ny = H - 48;
    ctx.fillStyle = "#0df2f2"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center"; ctx.fillText("N", nx, ny - 18);
    ctx.strokeStyle = "#0df2f2"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(nx, ny - 14); ctx.lineTo(nx - 5, ny + 4); ctx.lineTo(nx, ny + 2); ctx.lineTo(nx + 5, ny + 4); ctx.closePath();
    ctx.fillStyle = "rgba(13,242,242,0.6)"; ctx.fill(); ctx.stroke();

    // Scale bar
    const sbPx = SCALE * 5;
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fillRect(20, H - 22, sbPx, 3);
    ctx.font = "8px monospace"; ctx.textAlign = "left"; ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText("5m", 20 + sbPx + 3, H - 18);

    // Status bar
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(0, H - 22, W, 22);
    ctx.fillStyle = "rgba(13,242,242,0.55)"; ctx.font = "9px monospace"; ctx.textAlign = "left";
    const sunH = floorPlan?.sunlight_score ? `${(floorPlan.sunlight_score * 12).toFixed(1)}h/day` : "—";
    ctx.fillText(`◉ GROUND FLOOR   ● ${rooms.filter((r: Room) => r.floor === 1).length} ROOMS   ☀ SUN: ${sunH}   SCALE 1:100`, 14, H - 7);

  }, [rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow, floorPlan]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

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
    { lat: 34.053, lon: -118.244, confidence: 0.97 },
    { lat: 34.052, lon: -118.243, confidence: 0.82 },
  ];
  const ecoScore = floorPlan ? Math.round(floorPlan.fitness_score * 100) : (analysis ? Math.round(analysis.buildability_score) : 94);
  const solarPct = floorPlan ? Math.round(floorPlan.sunlight_score * 100) : 88;
  const ventPct = floorPlan ? Math.round(floorPlan.ventilation_score * 100) : 95;
  const treeDist = floorPlan?.tree_preserved_count ?? 0;

  const addLog = (msg: string) => {
    const n = new Date();
    const t = `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}:${String(n.getSeconds()).padStart(2,"0")}`;
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

  useEffect(() => {
    if (!floorPlan && plotId && analysis) { handleRegenerate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotId]);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>{`body{background:#080e0e} .gl{background:rgba(10,26,26,0.7);backdrop-filter:blur(10px);border:1px solid rgba(13,242,242,0.08)} .glm{background:rgba(13,242,242,0.04);border:1px solid rgba(13,242,242,0.1)} @keyframes aip{0%,100%{opacity:1}50%{opacity:0.5}} .aip{animation:aip 2s ease-in-out infinite}`}</style>
      <div className="h-screen w-screen flex flex-col overflow-hidden" style={{ background: "#080e0e", fontFamily: "'Space Grotesk',sans-serif" }}>
        <header className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/5" style={{ background: "rgba(8,14,14,0.98)" }}>
          <Link href="/" className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-2xl">deployed_code</span>
            <div><div className="text-white font-bold text-base tracking-tight">ECO-3D <span className="text-primary/60 font-light">Studio</span></div>
              <div className="text-[9px] text-slate-500 uppercase tracking-[0.15em]">AI GENERATIVE ARCHITECTURE</div></div>
          </Link>
          <nav className="flex items-center gap-1">
            {[{ l: "Project Alpha", h: `/map` }, { l: "Blueprint Generator", h: `/analysis/${plotId}`, a: true }, { l: "Environmental Data", h: `/environment/${plotId}` }, { l: "Export", h: `/report/${plotId}` }].map(item => (
              <Link key={item.l} href={item.h} className={`px-4 py-2 text-[12px] font-medium transition-all ${(item as any).a ? "text-primary border-b-2 border-primary" : "text-slate-400 hover:text-white"}`}>{item.l}</Link>
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
                <div><label className="text-[11px] text-slate-400 mb-1.5 block">Target Area</label>
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
                <span className="text-[10px] font-bold uppercase tracking-widest text-primary">ARCHITECTURAL FLOOR PLAN — SCALE 1:100</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="glm px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-slate-300">X: {lat.toFixed(4)}° N</div>
                <div className="glm px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-slate-300">Y: {lon.toFixed(4)}° E</div>
              </div>
              <div className="gl px-3 py-2 rounded-lg">
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Legend</div>
                {[{ c: "#7dd3d4", l: "Windows" }, { c: "rgba(220,210,180,0.8)", l: "Doors" }, { c: "#2ecc71", l: "Trees" }, { c: "#f59e0b", l: "Solar Arc" }].map(({ c, l }) => (
                  <div key={l} className="flex items-center gap-2 mb-1">
                    <span style={{ width: 10, height: 10, background: c, display: "inline-block", borderRadius: 2 }} />
                    <span className="text-[10px] text-slate-400">{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 relative overflow-hidden" style={{ background: "#0a1a1a" }}>
              <BlueprintCanvas rooms={rooms} trees={trees} lat={lat} lon={lon} zoom={zoom} showSolarPath={showSolar} showWindFlow={showWind} floorPlan={floorPlan} />
              <div className="absolute bottom-4 right-4 flex flex-col gap-1">
                {[{ i: "add", a: () => setZoom(z => Math.min(z + 2, 32)) }, { i: "remove", a: () => setZoom(z => Math.max(z - 2, 6)) }, { i: "center_focus_strong", a: () => setZoom(14) }].map(({ i, a }) => (
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
              <span>⬡ PROFESSIONAL BLUEPRINT 3.0</span><span>⊙ SITE: {plotId || "—"}</span>
              <div className="flex items-center gap-3">
                <button className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"><span className="material-symbols-outlined text-sm">download</span>Export DXF</button>
                <button className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"><span className="material-symbols-outlined text-sm">share</span>Share</button>
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
                <EffBar label="Tree Preservation" value={treeDist === 0 ? 100 : 100 - treeDist * 5} status={treeDist === 0 ? "Full" : `${treeDist} trees`} color="#2ecc71" />
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
                      {analysis.score_references.map((ref: string, idx: number) => (
                        <div key={idx} className="text-[9px] text-slate-400 border-l border-primary/30 pl-1.5 mb-1">{ref}</div>
                      ))}
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
