"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";

interface Room {
  type: string; width: number; height: number;
  x: number; y: number; floor: number; orientation: string;
}

// ── Room palette ─────────────────────────────────────────────────────────────
const PALETTE: Record<string, { fill: string; accent: string; hatch?: boolean }> = {
  living: { fill: "rgba(13,200,200,0.07)", accent: "#0bc8c8" },
  bedroom: { fill: "rgba(52,130,210,0.07)", accent: "#3482d2" },
  kitchen: { fill: "rgba(46,180,100,0.07)", accent: "#2eb464" },
  bathroom: { fill: "rgba(140,80,170,0.07)", accent: "#8c50aa", hatch: true },
  office: { fill: "rgba(220,170,10,0.07)", accent: "#dcaa0a" },
  garage: { fill: "rgba(110,125,125,0.07)", accent: "#6e7d7d" },
  utility: { fill: "rgba(210,110,20,0.07)", accent: "#d26e14", hatch: true },
};

const getP = (type: string) => {
  const k = Object.keys(PALETTE).find(k => type.toLowerCase().includes(k));
  return k ? PALETTE[k] : { fill: "rgba(80,80,100,0.06)", accent: "#505064" };
};

// ── Architectural canvas ──────────────────────────────────────────────────────
function FloorPlanCanvas({ rooms, floor }: { rooms: Room[]; floor: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const floorRooms = useMemo(() => rooms.filter(r => r.floor === floor), [rooms, floor]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    if (!canvas || !cont || floorRooms.length === 0) return;

    const ctx = canvas.getContext("2d")!;
    const W = cont.clientWidth;
    const H = cont.clientHeight;
    canvas.width = W;
    canvas.height = H;

    // ── Background + grid ───────────────────────────────────────────────────
    ctx.fillStyle = "#0b1515";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(13,242,242,0.025)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // ── Scale / offset ──────────────────────────────────────────────────────
    const minX = Math.min(...floorRooms.map(r => r.x));
    const minY = Math.min(...floorRooms.map(r => r.y));
    const maxX = Math.max(...floorRooms.map(r => r.x + r.width));
    const maxY = Math.max(...floorRooms.map(r => r.y + r.height));
    const scale = Math.min((W * 0.80) / (maxX - minX), (H * 0.76) / (maxY - minY));
    const offX = (W - (maxX - minX) * scale) / 2 - minX * scale;
    const offY = (H - (maxY - minY) * scale) / 2 - minY * scale;

    const px = (x: number) => offX + x * scale;
    const py = (y: number) => offY + y * scale;
    const ps = (s: number) => s * scale;

    // Wall thicknesses (pixels)
    const WT = Math.max(6, ps(0.26));   // exterior
    const IWT = Math.max(3, ps(0.13));   // interior / partition
    const EPS = 0.08;                     // adjacency tolerance (m)
    const BG = "#0b1515";

    // ── Adjacency helpers ───────────────────────────────────────────────────
    type Side = "top" | "right" | "bottom" | "left";
    const ov1D = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

    const sharedOn = (a: Room, side: Side): { b: Room; lo: number; hi: number } | null => {
      for (const b of floorRooms) {
        if (b === a) continue;
        let edgeMatch = false, lo = 0, hi = 0;
        if (side === "right") { edgeMatch = Math.abs((a.x + a.width) - b.x) < EPS; const o = ov1D(a.y, a.y + a.height, b.y, b.y + b.height); if (edgeMatch && o > 0.25) { lo = Math.max(a.y, b.y); hi = Math.min(a.y + a.height, b.y + b.height); } else edgeMatch = false; }
        if (side === "left") { edgeMatch = Math.abs(a.x - (b.x + b.width)) < EPS; const o = ov1D(a.y, a.y + a.height, b.y, b.y + b.height); if (edgeMatch && o > 0.25) { lo = Math.max(a.y, b.y); hi = Math.min(a.y + a.height, b.y + b.height); } else edgeMatch = false; }
        if (side === "bottom") { edgeMatch = Math.abs((a.y + a.height) - b.y) < EPS; const o = ov1D(a.x, a.x + a.width, b.x, b.x + b.width); if (edgeMatch && o > 0.25) { lo = Math.max(a.x, b.x); hi = Math.min(a.x + a.width, b.x + b.width); } else edgeMatch = false; }
        if (side === "top") { edgeMatch = Math.abs(a.y - (b.y + b.height)) < EPS; const o = ov1D(a.x, a.x + a.width, b.x, b.x + b.width); if (edgeMatch && o > 0.25) { lo = Math.max(a.x, b.x); hi = Math.min(a.x + a.width, b.x + b.width); } else edgeMatch = false; }
        if (edgeMatch) return { b, lo, hi };
      }
      return null;
    };

    // ── PASS 1 – room fills + diagonal hatch for wet rooms ──────────────────
    floorRooms.forEach(r => {
      const p = getP(r.type);
      const rx = px(r.x) + WT / 2, ry = py(r.y) + WT / 2;
      const rw = ps(r.width) - WT, rh = ps(r.height) - WT;
      ctx.fillStyle = p.fill;
      ctx.fillRect(rx, ry, rw, rh);

      if (p.hatch && rw > 18 && rh > 18) {
        ctx.save();
        ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
        ctx.strokeStyle = p.accent + "28";
        ctx.lineWidth = 0.7;
        const step = 11;
        for (let d = -(rw + rh); d < rw + rh; d += step) {
          ctx.beginPath(); ctx.moveTo(rx + d, ry); ctx.lineTo(rx + d + rh, ry + rh); ctx.stroke();
        }
        ctx.restore();
      }
    });

    // ── PASS 2 – walls ──────────────────────────────────────────────────────
    const drawnInt = new Set<string>();

    floorRooms.forEach(r => {
      const rx = px(r.x), ry = py(r.y), rw = ps(r.width), rh = ps(r.height);
      const sides: Side[] = ["top", "right", "bottom", "left"];

      sides.forEach(side => {
        const sh = sharedOn(r, side);
        const ext = !sh;
        const T = ext ? WT : IWT;

        if (sh) {
          const key = [[r.x, r.y], [sh.b.x, sh.b.y]].map(p => p.join(",")).sort().join("|") + side[0];
          if (drawnInt.has(key)) return;
          drawnInt.add(key);
        }

        let wx = 0, wy = 0, ww = 0, wh = 0;
        if (side === "top") { wx = rx; wy = ry; ww = rw; wh = T; }
        if (side === "bottom") { wx = rx; wy = ry + rh - T; ww = rw; wh = T; }
        if (side === "left") { wx = rx; wy = ry; ww = T; wh = rh; }
        if (side === "right") { wx = rx + rw - T; wy = ry; ww = T; wh = rh; }

        ctx.fillStyle = ext ? "#1e3838" : "#162e2e";
        ctx.fillRect(wx, wy, ww, wh);
        ctx.strokeStyle = ext ? "rgba(13,242,242,0.7)" : "rgba(13,242,242,0.28)";
        ctx.lineWidth = ext ? 1.2 : 0.6;
        ctx.strokeRect(wx, wy, ww, wh);
      });
    });

    // ── PASS 3 – doors ──────────────────────────────────────────────────────
    const DOOR_M = 0.85;
    const pairedDoors = new Set<string>();
    const hasDoor = new Set<Room>();

    const cutAndDrawDoor = (
      gx: number, gy: number, gw: number, gh: number,  // gap rect
      hingX: number, hingY: number,                     // arc hinge point
      arcR: number, arcA0: number, arcA1: number,      // arc params
      lineX0: number, lineY0: number, lineX1: number, lineY1: number // door leaf
    ) => {
      ctx.fillStyle = BG; ctx.fillRect(gx, gy, gw, gh);
      ctx.strokeStyle = "rgba(13,242,242,0.85)"; ctx.lineWidth = 1.0;
      ctx.setLineDash([]);
      // door leaf
      ctx.beginPath(); ctx.moveTo(lineX0, lineY0); ctx.lineTo(lineX1, lineY1); ctx.stroke();
      // swing arc
      ctx.beginPath(); ctx.arc(hingX, hingY, arcR, arcA0, arcA1); ctx.stroke();
    };

    floorRooms.forEach(r => {
      const rx = px(r.x), ry = py(r.y), rw = ps(r.width), rh = ps(r.height);
      const dw = Math.min(ps(DOOR_M), rw * 0.55, rh * 0.55);

      const sides: Side[] = ["bottom", "right", "top", "left"];
      for (const side of sides) {
        const sh = sharedOn(r, side);
        if (!sh) continue;
        const pairKey = [[r.x, r.y], [sh.b.x, sh.b.y]].map(p => p.join(",")).sort().join("|");
        if (pairedDoors.has(pairKey)) continue;
        pairedDoors.add(pairKey);

        const mid = (sh.lo + sh.hi) / 2;
        const T = IWT;

        if (side === "bottom") {
          const dx = px(mid) - dw / 2, dy = ry + rh - T;
          cutAndDrawDoor(dx, dy - 1, dw, T + 2, dx, dy + T, dw, -Math.PI / 2, 0, dx, dy + T, dx + dw, dy + T);
        } else if (side === "top") {
          const dx = px(mid) - dw / 2, dy = ry;
          cutAndDrawDoor(dx, dy - 1, dw, T + 2, dx + dw, dy, dw, Math.PI / 2, Math.PI, dx, dy, dx + dw, dy);
        } else if (side === "right") {
          const dy = py(mid) - dw / 2, dx = rx + rw - T;
          cutAndDrawDoor(dx - 1, dy, T + 2, dw, dx + T, dy, dw, Math.PI, 3 * Math.PI / 2, dx + T, dy, dx + T, dy + dw);
        } else if (side === "left") {
          const dy = py(mid) - dw / 2, dx = rx;
          cutAndDrawDoor(dx - 1, dy, T + 2, dw, dx, dy, dw, 0, Math.PI / 2, dx, dy, dx, dy + dw);
        }
        hasDoor.add(r); hasDoor.add(sh.b);
      }
    });

    // Isolated rooms get an exterior door on the bottom wall
    floorRooms.forEach(r => {
      if (hasDoor.has(r)) return;
      const rx = px(r.x), ry = py(r.y), rw = ps(r.width), rh = ps(r.height);
      const dw = Math.min(ps(DOOR_M), rw * 0.55);
      const dx = rx + rw / 2 - dw / 2, dy = ry + rh - WT;
      cutAndDrawDoor(dx, dy - 1, dw, WT + 2, dx, dy + WT, dw, -Math.PI / 2, 0, dx, dy + WT, dx + dw, dy + WT);
    });

    // ── PASS 4 – windows ────────────────────────────────────────────────────
    const HABITABLE = ["living", "bedroom", "kitchen", "office", "dining", "lounge"];
    const BATHLIKE = ["bathroom", "toilet", "wc", "bath"];

    const drawWindow = (gx: number, gy: number, gw: number, gh: number, horiz: boolean) => {
      ctx.fillStyle = "rgba(13,242,242,0.10)";
      ctx.fillRect(gx, gy, gw, gh);
      ctx.strokeStyle = "rgba(160,240,240,0.9)"; ctx.lineWidth = 1;
      // outer frame
      ctx.strokeRect(gx, gy, gw, gh);
      // 2 glazing bars (divide window into 3 panes)
      const segs = 3;
      for (let i = 1; i < segs; i++) {
        ctx.beginPath();
        if (horiz) {
          const x = gx + gw * i / segs;
          ctx.moveTo(x, gy); ctx.lineTo(x, gy + gh);
        } else {
          const y = gy + gh * i / segs;
          ctx.moveTo(gx, y); ctx.lineTo(gx + gw, y);
        }
        ctx.stroke();
      }
    };

    floorRooms.forEach(r => {
      const lc = r.type.toLowerCase();
      const isHab = HABITABLE.some(h => lc.includes(h));
      const isBath = BATHLIKE.some(h => lc.includes(h));
      if (!isHab && !isBath) return;

      const rx = px(r.x), ry = py(r.y), rw = ps(r.width), rh = ps(r.height);
      const winM = isBath ? 0.65 : 1.1;
      const ww = Math.min(ps(winM), rw * 0.45, 80);
      const wh = Math.min(ps(winM), rh * 0.45, 80);

      // top exterior wall
      if (!sharedOn(r, "top") && rw > ps(1.5)) {
        const cx = rx + rw / 2;
        drawWindow(cx - ww / 2, ry, ww, WT, true);
        if (isHab && rw > ps(4.5)) { drawWindow(cx - ww * 1.3, ry, ww, WT, true); drawWindow(cx + ww * 0.3, ry, ww, WT, true); }
      }
      // bottom exterior wall
      if (!sharedOn(r, "bottom") && rw > ps(1.5) && !sharedOn(r, "top")) {
        drawWindow(rx + rw / 2 - ww / 2, ry + rh - WT, ww, WT, true);
      }
      // left exterior wall
      if (!sharedOn(r, "left") && rh > ps(2.0)) {
        drawWindow(rx, ry + rh / 2 - wh / 2, WT, wh, false);
      }
      // right exterior wall
      if (!sharedOn(r, "right") && rh > ps(2.0)) {
        drawWindow(rx + rw - WT, ry + rh / 2 - wh / 2, WT, wh, false);
      }
    });

    // ── PASS 5 – room labels ─────────────────────────────────────────────────
    floorRooms.forEach(r => {
      const rx = px(r.x), ry = py(r.y), rw = ps(r.width), rh = ps(r.height);
      const iW = rw - WT * 2, iH = rh - WT * 2;
      if (iW < 22 || iH < 14) return;
      const cx = rx + rw / 2, cy = ry + rh / 2;
      const fs = Math.max(8, Math.min(13, iW * 0.11));
      ctx.save();
      ctx.beginPath(); ctx.rect(rx + WT, ry + WT, iW, iH); ctx.clip();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = getP(r.type).accent;
      ctx.font = `700 ${fs}px 'Space Grotesk', monospace`;
      ctx.fillText(r.type.replace(/_/g, " ").toUpperCase(), cx, cy - fs * 0.65);
      ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.font = `${Math.max(7, fs - 2)}px monospace`;
      ctx.fillText(`${(r.width * r.height).toFixed(1)} m²`, cx, cy + fs * 0.65);
      ctx.restore();
    });

    // ── PASS 6 – dimension lines ─────────────────────────────────────────────
    ctx.setLineDash([2, 3]);
    floorRooms.forEach(r => {
      const rx = px(r.x), ry = py(r.y), rw = ps(r.width), rh = ps(r.height);
      const OFF = 16;
      ctx.strokeStyle = "rgba(13,242,242,0.38)"; ctx.lineWidth = 0.7;

      if (rw > 55) {
        const yd = ry - OFF;
        ctx.beginPath();
        ctx.moveTo(rx, ry); ctx.lineTo(rx, yd);
        ctx.moveTo(rx + rw, ry); ctx.lineTo(rx + rw, yd);
        ctx.moveTo(rx, yd); ctx.lineTo(rx + rw, yd);
        // ticks
        ctx.moveTo(rx - 3, yd - 4); ctx.lineTo(rx + 3, yd + 4);
        ctx.moveTo(rx + rw - 3, yd - 4); ctx.lineTo(rx + rw + 3, yd + 4);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(180,240,240,0.55)"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${r.width.toFixed(1)}m`, rx + rw / 2, yd - 2);
        ctx.setLineDash([2, 3]);
      }
      if (rh > 55) {
        const xd = rx + rw + OFF;
        ctx.beginPath();
        ctx.moveTo(rx + rw, ry); ctx.lineTo(xd, ry);
        ctx.moveTo(rx + rw, ry + rh); ctx.lineTo(xd, ry + rh);
        ctx.moveTo(xd, ry); ctx.lineTo(xd, ry + rh);
        ctx.moveTo(xd - 4, ry - 3); ctx.lineTo(xd + 4, ry + 3);
        ctx.moveTo(xd - 4, ry + rh - 3); ctx.lineTo(xd + 4, ry + rh + 3);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.save();
        ctx.translate(xd + 10, ry + rh / 2);
        ctx.rotate(Math.PI / 2);
        ctx.fillStyle = "rgba(180,240,240,0.55)"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${r.height.toFixed(1)}m`, 0, 0);
        ctx.restore();
        ctx.setLineDash([2, 3]);
      }
    });
    ctx.setLineDash([]);

    // ── North arrow ──────────────────────────────────────────────────────────
    const NAX = W - 44, NAY = H - 44, NAR = 16;
    ctx.strokeStyle = "rgba(13,242,242,0.55)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(NAX, NAY, NAR, 0, Math.PI * 2); ctx.stroke();
    // filled N half
    ctx.fillStyle = "#0df2f2";
    ctx.beginPath(); ctx.moveTo(NAX, NAY - NAR + 2); ctx.lineTo(NAX - 4, NAY + 2); ctx.lineTo(NAX, NAY - 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(13,242,242,0.22)";
    ctx.beginPath(); ctx.moveTo(NAX, NAY - NAR + 2); ctx.lineTo(NAX + 4, NAY + 2); ctx.lineTo(NAX, NAY - 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(13,242,242,0.85)"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("N", NAX, NAY - NAR - 1);

    // ── Scale bar ────────────────────────────────────────────────────────────
    const targetPx = W * 0.12;
    let scaleM = Math.pow(10, Math.round(Math.log10(targetPx / scale)));
    if (scaleM * scale > targetPx * 1.8) scaleM /= 2;
    const sbPx = scaleM * scale;
    const SBX = 18, SBY = H - 16;
    ctx.strokeStyle = "rgba(13,242,242,0.6)"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(SBX, SBY); ctx.lineTo(SBX + sbPx, SBY);
    ctx.moveTo(SBX, SBY - 4); ctx.lineTo(SBX, SBY + 4);
    ctx.moveTo(SBX + sbPx, SBY - 4); ctx.lineTo(SBX + sbPx, SBY + 4);
    ctx.stroke();
    ctx.fillStyle = "rgba(13,242,242,0.65)"; ctx.font = "8px monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(`${scaleM}m`, SBX + sbPx / 2, SBY + 6);

    // ── Floor label ──────────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(13,242,242,0.18)"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`FLOOR ${floor}`, 12, 12);

  }, [floorRooms, floor]);

  useEffect(() => {
    redraw();
    const ro = new ResizeObserver(redraw);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  if (floorRooms.length === 0) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center">
        <p className="text-slate-500 text-sm">No rooms on floor {floor}</p>
      </div>
    );
  }
  return (
    <div ref={containerRef} className="w-full h-full">
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}

// ── Score card ────────────────────────────────────────────────────────────────
function ScoreCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="rounded-xl p-5 flex flex-col gap-3" style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.1)" }}>
      <span className="material-symbols-outlined text-primary text-2xl">{icon}</span>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{label}</div>
        <div className="text-2xl font-black text-white mt-0.5">{value}</div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FloorPlanPage() {
  const params = useParams();
  const plotId = params.id as string;
  const { floorPlan } = useEco3DStore();
  const [activeFloor, setActiveFloor] = useState(1);

  const floors = useMemo(
    () => floorPlan ? Array.from(new Set(floorPlan.layout.map(r => r.floor))).sort() : [1],
    [floorPlan]
  );
  const rooms = floorPlan?.layout ?? [];
  const totalArea = floorPlan?.total_area ?? 0;

  useEffect(() => { setActiveFloor(floors[0] ?? 1); }, [floors]);

  return (
    <>
      <div className="min-h-screen w-full" style={{ background: "#080e0e", fontFamily: "'Space Grotesk',sans-serif" }}>
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-3 border-b border-white/5 sticky top-0 z-50" style={{ background: "rgba(8,14,14,0.98)" }}>
          <Link href="/" className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">deployed_code</span>
            <span className="font-bold text-white text-sm">ECO-3D</span>
          </Link>
          <nav className="flex items-center gap-4">
            <Link href={`/analysis/${plotId}`} className="text-[11px] text-slate-400 hover:text-white transition-colors">Blueprint Generator</Link>
            <Link href={`/environment/${plotId}`} className="text-[11px] text-slate-400 hover:text-white transition-colors">Environmental Data</Link>
            <Link href={`/model3d/${plotId}`} className="text-[11px] text-primary hover:brightness-110 transition-all flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">view_in_ar</span> 3D Model
            </Link>
            <Link href={`/report/${plotId}`} className="text-[11px] text-slate-400 hover:text-white transition-colors">Export</Link>
          </nav>
          <span className="text-[11px] font-mono text-slate-500">{plotId}</span>
        </header>

        <div className="max-w-7xl mx-auto px-6 py-8">
          {/* Title */}
          <div className="mb-8">
            <h1 className="text-4xl font-black text-white uppercase tracking-tight mb-1">Floor Plan</h1>
            <p className="text-slate-500 text-sm font-mono">
              {plotId} · {rooms.length} rooms · {totalArea.toFixed(0)} m²
            </p>
          </div>

          {/* Score cards */}
          <div className="grid grid-cols-4 gap-4 mb-8">
            <ScoreCard icon="star" label="Fitness Score" value={floorPlan ? `${Math.round(floorPlan.fitness_score * 100)}%` : "—"} />
            <ScoreCard icon="wb_sunny" label="Sunlight" value={floorPlan ? `${Math.round(floorPlan.sunlight_score * 100)}%` : "—"} />
            <ScoreCard icon="air" label="Ventilation" value={floorPlan ? `${Math.round(floorPlan.ventilation_score * 100)}%` : "—"} />
            <ScoreCard icon="forest" label="Trees Saved" value={floorPlan ? String(floorPlan.tree_preserved_count) : "—"} />
          </div>

          {/* Legend */}
          <div className="flex items-center gap-6 mb-4 px-1">
            {[
              { label: "Exterior Wall", color: "#0df2f2", solid: true },
              { label: "Interior Wall", color: "rgba(13,242,242,0.35)", solid: true },
              { label: "Door (swing arc)", color: "#0df2f2", solid: false },
              { label: "Window (glazing)", color: "rgba(160,240,240,0.9)", solid: false },
            ].map(({ label, color, solid }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="inline-block w-5 h-3 rounded-sm" style={{ background: solid ? color : "transparent", border: `1.5px solid ${color}` }} />
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
              </div>
            ))}
          </div>

          {/* Floor plan canvas */}
          <div className="rounded-2xl overflow-hidden mb-6" style={{ background: "rgba(10,26,26,0.6)", border: "1px solid rgba(13,242,242,0.08)" }}>
            {/* Floor tabs */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
              {floors.map(f => (
                <button key={f} onClick={() => setActiveFloor(f)}
                  className="px-5 py-1.5 rounded font-bold text-[12px] uppercase tracking-widest transition-all"
                  style={{
                    background: activeFloor === f ? "#0df2f2" : "transparent",
                    color: activeFloor === f ? "#080e0e" : "#64748b",
                    border: `1px solid ${activeFloor === f ? "#0df2f2" : "rgba(255,255,255,0.08)"}`,
                  }}>
                  Floor {f}
                </button>
              ))}
              <div className="ml-auto text-[10px] font-mono text-slate-600">
                {rooms.filter(r => r.floor === activeFloor).length} rooms on this floor
              </div>
            </div>

            {/* Canvas */}
            <div style={{ height: "540px", background: "#0b1515" }}>
              {rooms.length > 0
                ? <FloorPlanCanvas key={`${plotId}-floor${activeFloor}`} rooms={rooms} floor={activeFloor} />
                : <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                  <span className="material-symbols-outlined text-primary/30 text-5xl">architecture</span>
                  <p className="text-slate-500 text-sm">Select a plot on the map to generate a floor plan</p>
                  <Link href="/map" className="text-[11px] text-primary underline">Go to Map →</Link>
                </div>
              }
            </div>
          </div>

          {/* Room schedule */}
          <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(10,26,26,0.6)", border: "1px solid rgba(13,242,242,0.08)" }}>
            <div className="px-6 py-4 border-b border-white/5">
              <h3 className="text-[11px] font-bold uppercase tracking-widest text-primary">Room Schedule</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/5">
                    {["Type", "Floor", "Width", "Height", "Area", "Orientation"].map(h => (
                      <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rooms.map((room, i) => {
                    const accent = getP(room.type).accent;
                    return (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: accent }} />
                            <span className="text-sm font-semibold text-white capitalize">{room.type.replace(/_/g, " ")}</span>
                          </div>
                        </td>
                        <td className="px-6 py-3 text-sm text-slate-400">{room.floor}</td>
                        <td className="px-6 py-3 text-sm font-mono text-slate-300">{room.width.toFixed(1)}m</td>
                        <td className="px-6 py-3 text-sm font-mono text-slate-300">{room.height.toFixed(1)}m</td>
                        <td className="px-6 py-3 text-sm font-mono text-primary">{(room.width * room.height).toFixed(1)}m²</td>
                        <td className="px-6 py-3 text-sm text-slate-400">{room.orientation}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
