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

// ─────────────────────────────────────────────────────────────────────────────
// Professional Architectural Floor Plan Canvas
// Renders: outer bounding wall, rooms tiled (no overlap), shared walls,
// doors with arc swings, windows, furniture, dimension lines, north arrow
// ─────────────────────────────────────────────────────────────────────────────

// ── Professional Architectural Floor Plan Canvas ──────────────────────────────
// Draws a proper house plan: outer boundary wall, room grid, connected doors,
// windows on exterior walls, furniture, dimension lines, north arrow, scale bar.

function BlueprintCanvas({ rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow, floorPlan }:
  { rooms: Room[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; floorPlan: any; }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const ROOM_CFG: Record<string, { bg: string; border: string; label: string }> = {
    living:   { bg: "rgba(13,200,200,0.07)",  border: "#0bc8c8", label: "LIVING ROOM" },
    bedroom:  { bg: "rgba(60,130,220,0.07)",   border: "#4a9de8", label: "BEDROOM" },
    kitchen:  { bg: "rgba(46,180,100,0.07)",   border: "#2cb46e", label: "KITCHEN" },
    bathroom: { bg: "rgba(140,80,200,0.07)",   border: "#9b72d4", label: "BATHROOM" },
    office:   { bg: "rgba(220,180,20,0.07)",   border: "#e8c33a", label: "OFFICE" },
    garage:   { bg: "rgba(110,120,120,0.07)",  border: "#8fa0a0", label: "GARAGE" },
    utility:  { bg: "rgba(220,120,40,0.07)",   border: "#e08050", label: "UTILITY" },
    dining:   { bg: "rgba(220,80,80,0.07)",    border: "#d25050", label: "DINING" },
  };
  const getStyle = (t: string) => {
    const k = Object.keys(ROOM_CFG).find(k => t.toLowerCase().includes(k));
    return k ? ROOM_CFG[k] : { bg: "rgba(13,242,242,0.05)", border: "#0df2f2", label: t.toUpperCase() };
  };

  // Layout rooms into a non-overlapping grid within a bounding box
  // Returns rooms with corrected x,y,width,height so they fit together
  const layoutRooms = (rawRooms: Room[]) => {
    const floor1 = rawRooms.filter(r => (r.floor ?? 1) === 1);
    if (floor1.length === 0) return [];

    // Sort rooms: living > bedroom > kitchen > others
    const ORDER = ["living", "kitchen", "dining", "bedroom", "bedroom", "bathroom", "office", "utility", "garage"];
    const sorted = [...floor1].sort((a, b) => {
      const ai = ORDER.findIndex(o => a.type.toLowerCase().includes(o));
      const bi = ORDER.findIndex(o => b.type.toLowerCase().includes(o));
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

    // Pack rooms into rows — like real floor plan layout
    // Row 1: public rooms (living, kitchen, dining)
    // Row 2: private rooms (bedrooms, bathrooms)
    // Row 3: utility, garage

    const publicTypes = ["living", "kitchen", "dining"];
    const privateTypes = ["bedroom", "bathroom"];
    const serviceTypes = ["office", "utility", "garage", "corridor"];

    const rows: Room[][] = [
      sorted.filter(r => publicTypes.some(t => r.type.toLowerCase().includes(t))),
      sorted.filter(r => privateTypes.some(t => r.type.toLowerCase().includes(t))),
      sorted.filter(r => serviceTypes.some(t => r.type.toLowerCase().includes(t))),
    ].filter(row => row.length > 0);

    // Normalize room sizes to reasonable proportions
    const normalizeSize = (r: Room) => {
      const t = r.type.toLowerCase();
      if (t.includes("living"))   return { w: Math.max(4.5, Math.min(7, r.width)),  h: Math.max(4, Math.min(6, r.height)) };
      if (t.includes("kitchen"))  return { w: Math.max(3.5, Math.min(5.5, r.width)), h: Math.max(3, Math.min(5, r.height)) };
      if (t.includes("dining"))   return { w: Math.max(3, Math.min(5, r.width)),   h: Math.max(3, Math.min(4.5, r.height)) };
      if (t.includes("bedroom"))  return { w: Math.max(3.2, Math.min(5, r.width)),  h: Math.max(3, Math.min(4.5, r.height)) };
      if (t.includes("bathroom")) return { w: Math.max(2, Math.min(3.5, r.width)),  h: Math.max(2, Math.min(3.2, r.height)) };
      if (t.includes("office"))   return { w: Math.max(3, Math.min(4.5, r.width)),  h: Math.max(3, Math.min(4, r.height)) };
      if (t.includes("garage"))   return { w: Math.max(4.5, Math.min(7, r.width)),  h: Math.max(4, Math.min(6, r.height)) };
      return { w: Math.max(2.5, Math.min(4, r.width)), h: Math.max(2, Math.min(3.5, r.height)) };
    };

    // Compute row widths and place rooms
    const placed: Array<Room & { pw: number; ph: number; px: number; py: number }> = [];
    let globalMaxW = 0;

    // First pass: compute max row width for alignment
    const rowSizes = rows.map(row => ({
      totalW: row.reduce((s, r) => s + normalizeSize(r).w, 0),
      maxH: Math.max(...row.map(r => normalizeSize(r).h)),
    }));
    globalMaxW = Math.max(...rowSizes.map(r => r.totalW));

    let curY = 0;
    rows.forEach((row, ri) => {
      const { totalW, maxH } = rowSizes[ri];
      // If row is narrower than max, scale room widths to fill
      const scale = totalW < globalMaxW ? globalMaxW / totalW : 1;
      let curX = 0;
      row.forEach(r => {
        const sz = normalizeSize(r);
        const rw = sz.w * scale;
        const rh = sz.h;
        placed.push({ ...r, pw: rw, ph: rh, px: curX, py: curY });
        curX += rw;
      });
      curY += maxH;
    });

    return placed;
  };

  const draw = useCallback((_t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.offsetWidth || 700;
    const H = canvas.offsetHeight || 600;
    canvas.width = W; canvas.height = H;

    // Background
    ctx.fillStyle = "#080f0f";
    ctx.fillRect(0, 0, W, H);

    // Subtle grid (blueprint paper lines)
    ctx.strokeStyle = "rgba(13,242,242,0.06)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 25) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 25) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    if (rooms.length === 0) {
      ctx.fillStyle = "rgba(13,242,242,0.5)";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("AWAITING FLOOR PLAN GENERATION", W / 2, H / 2 - 12);
      ctx.fillStyle = "rgba(13,242,242,0.3)";
      ctx.font = "10px monospace";
      ctx.fillText("Select a plot and run analysis", W / 2, H / 2 + 10);
      return;
    }

    const SCALE = zoom;
    const WALL_T = Math.max(5, zoom * 0.28);   // outer wall thickness in px
    const INT_T  = Math.max(3, zoom * 0.14);    // interior wall thickness

    // Layout rooms into non-overlapping grid
    const laid = layoutRooms(rooms);
    if (laid.length === 0) return;

    const maxPX = Math.max(...laid.map(r => r.px + r.pw));
    const maxPY = Math.max(...laid.map(r => r.py + r.ph));

    // Center the layout
    const bw = maxPX * SCALE;
    const bh = maxPY * SCALE;
    const offX = (W - bw) / 2;
    const offY = (H - bh) / 2 + 10;

    // ── SOLAR ARC ──
    if (showSolarPath) {
      ctx.save();
      ctx.strokeStyle = "rgba(210,120,20,0.35)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]);
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const a = (Math.PI * i) / 30;
        const sx = offX - 40 + (bw + 80) * (i / 30);
        const sy = offY - 50 - Math.sin(a) * 38;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "rgba(210,140,20,0.6)"; ctx.beginPath();
      ctx.arc(offX + bw * 0.72, offY - 72, 6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ── OUTER HOUSE BOUNDARY WALL ──
    // Draw solid exterior wall around entire house footprint
    ctx.fillStyle = "#c8d4da";  // light wall on dark bg
    // Outer rect
    ctx.fillRect(offX - WALL_T, offY - WALL_T, bw + WALL_T * 2, bh + WALL_T * 2);
    // Inner cutout (floor area)
    ctx.fillStyle = "#080f0f";
    ctx.fillRect(offX, offY, bw, bh);

    // ── ROOM FILLS ──
    laid.forEach(room => {
      const rx = offX + room.px * SCALE;
      const ry = offY + room.py * SCALE;
      const rw = room.pw * SCALE;
      const rh = room.ph * SCALE;
      const s = getStyle(room.type);
      ctx.fillStyle = s.bg;
      ctx.fillRect(rx, ry, rw, rh);
    });

    // ── INTERIOR WALLS (between rooms) ──
    ctx.fillStyle = "#2a3540";
    laid.forEach(room => {
      const rx = offX + room.px * SCALE;
      const ry = offY + room.py * SCALE;
      const rw = room.pw * SCALE;
      const rh = room.ph * SCALE;
      // Draw thin interior wall lines along right and bottom edges of each room
      // Right wall
      if (room.px + room.pw < maxPX - 0.01) {
        ctx.fillRect(rx + rw - INT_T / 2, ry, INT_T, rh);
      }
      // Bottom wall
      if (room.py + room.ph < maxPY - 0.01) {
        ctx.fillRect(rx, ry + rh - INT_T / 2, rw, INT_T);
      }
    });

    // ── DOORS (clear gaps in interior/exterior walls) ──
    laid.forEach((room, idx) => {
      const rx = offX + room.px * SCALE;
      const ry = offY + room.py * SCALE;
      const rw = room.pw * SCALE;
      const rh = room.ph * SCALE;
      const dw = Math.min(rw * 0.38, SCALE * 0.85);
      const dh = Math.min(rh * 0.38, SCALE * 0.85);

      // Door in bottom wall connecting to next row (if not last row)
      const hasBottomDoor = room.py + room.ph < maxPY - 0.01;
      // Door in right wall connecting to next in row (if not last in row)
      const hasRightDoor = room.px + room.pw < maxPX - 0.01 && idx % 2 === 0;

      if (hasBottomDoor) {
        const dx = rx + (rw - dw) / 2;
        const dy = ry + rh - INT_T / 2;
        // Clear door gap
        ctx.fillStyle = "#f8f4ee";
        ctx.fillRect(dx, dy - 1, dw, INT_T + 2);
        // Door leaf
        ctx.strokeStyle = "#c8d4da"; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(dx, ry + rh); ctx.lineTo(dx + dw, ry + rh); ctx.stroke();
        // Swing arc
        ctx.strokeStyle = "rgba(200,212,218,0.35)"; ctx.lineWidth = 0.8; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.arc(dx, ry + rh, dw, 0, Math.PI / 2); ctx.stroke(); ctx.setLineDash([]);
      }

      if (hasRightDoor) {
        const dy2 = ry + (rh - dh) / 2;
        const dx2 = rx + rw - INT_T / 2;
        ctx.fillStyle = "#f8f4ee";
        ctx.fillRect(dx2 - 1, dy2, INT_T + 2, dh);
        ctx.strokeStyle = "#c8d4da"; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(rx + rw, dy2); ctx.lineTo(rx + rw, dy2 + dh); ctx.stroke();
        ctx.strokeStyle = "rgba(200,212,218,0.35)"; ctx.lineWidth = 0.8; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.arc(rx + rw, dy2, dh, Math.PI / 2, Math.PI); ctx.stroke(); ctx.setLineDash([]);
      }
    });

    // ── EXTERIOR WINDOWS ──
    laid.forEach((room, idx) => {
      const rx = offX + room.px * SCALE;
      const ry = offY + room.py * SCALE;
      const rw = room.pw * SCALE;
      const rh = room.ph * SCALE;
      const t = room.type.toLowerCase();
      if (t.includes("bathroom") || t.includes("utility") || t.includes("corridor")) return;

      // Top exterior window (rooms on top row)
      if (room.py < 0.01) {
        const ww = rw * 0.45;
        const wx = rx + (rw - ww) / 2;
        // Clear wall for window
        ctx.fillStyle = "#080f0f"; ctx.fillRect(wx, offY - WALL_T, ww, WALL_T);
        // Glass
        ctx.fillStyle = "rgba(140,200,220,0.4)"; ctx.fillRect(wx + 1, offY - WALL_T + 1, ww - 2, WALL_T - 2);
        // Frame
        ctx.strokeStyle = "#0bc8c8"; ctx.lineWidth = 1.3; ctx.strokeRect(wx, offY - WALL_T, ww, WALL_T);
        // Glazing bar
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(wx + ww / 2, offY - WALL_T); ctx.lineTo(wx + ww / 2, offY); ctx.stroke();
      }

      // Bottom exterior window (rooms on bottom row)
      if (room.py + room.ph > maxPY - 0.01) {
        if (!t.includes("garage")) {
          const ww = rw * 0.42;
          const wx = rx + (rw - ww) / 2;
          ctx.fillStyle = "#080f0f"; ctx.fillRect(wx, offY + bh, ww, WALL_T);
          ctx.fillStyle = "rgba(140,200,220,0.4)"; ctx.fillRect(wx + 1, offY + bh + 1, ww - 2, WALL_T - 2);
          ctx.strokeStyle = "#0bc8c8"; ctx.lineWidth = 1.3; ctx.strokeRect(wx, offY + bh, ww, WALL_T);
          ctx.lineWidth = 0.7;
          ctx.beginPath(); ctx.moveTo(wx + ww / 2, offY + bh); ctx.lineTo(wx + ww / 2, offY + bh + WALL_T); ctx.stroke();
        }
      }

      // Left exterior window (leftmost rooms)
      if (room.px < 0.01) {
        const wh = rh * 0.38;
        const wy = ry + (rh - wh) / 2;
        ctx.fillStyle = "#080f0f"; ctx.fillRect(offX - WALL_T, wy, WALL_T, wh);
        ctx.fillStyle = "rgba(140,200,220,0.4)"; ctx.fillRect(offX - WALL_T + 1, wy + 1, WALL_T - 2, wh - 2);
        ctx.strokeStyle = "#0bc8c8"; ctx.lineWidth = 1.3; ctx.strokeRect(offX - WALL_T, wy, WALL_T, wh);
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(offX - WALL_T, wy + wh / 2); ctx.lineTo(offX, wy + wh / 2); ctx.stroke();
      }

      // Right exterior window (rightmost rooms)
      if (room.px + room.pw > maxPX - 0.01) {
        if (!t.includes("garage")) {
          const wh = rh * 0.38;
          const wy = ry + (rh - wh) / 2;
          ctx.fillStyle = "#080f0f"; ctx.fillRect(offX + bw, wy, WALL_T, wh);
          ctx.fillStyle = "rgba(140,200,220,0.4)"; ctx.fillRect(offX + bw + 1, wy + 1, WALL_T - 2, wh - 2);
          ctx.strokeStyle = "#0bc8c8"; ctx.lineWidth = 1.3; ctx.strokeRect(offX + bw, wy, WALL_T, wh);
          ctx.lineWidth = 0.7;
          ctx.beginPath(); ctx.moveTo(offX + bw, wy + wh / 2); ctx.lineTo(offX + bw + WALL_T, wy + wh / 2); ctx.stroke();
        }
      }
    });

    // ── MAIN ENTRANCE DOOR (exterior) ──
    const entranceRoom = laid.find(r => r.type.toLowerCase().includes("living")) ?? laid[0];
    if (entranceRoom) {
      const ex = offX + entranceRoom.px * SCALE;
      const ew = entranceRoom.pw * SCALE;
      const edw = Math.min(ew * 0.35, SCALE * 0.75);
      const edx = ex + (ew - edw) / 2;
      // Clear entrance in bottom wall
      ctx.fillStyle = "#080f0f"; ctx.fillRect(edx, offY + bh - 1, edw, WALL_T + 2);
      ctx.strokeStyle = "#c8d4da"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(edx, offY + bh + WALL_T); ctx.lineTo(edx + edw, offY + bh + WALL_T); ctx.stroke();
      // Double door
      ctx.strokeStyle = "#c8d4da"; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(edx, offY + bh); ctx.lineTo(edx + edw / 2, offY + bh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(edx + edw / 2, offY + bh); ctx.lineTo(edx + edw, offY + bh); ctx.stroke();
      ctx.strokeStyle = "rgba(200,212,218,0.35)"; ctx.lineWidth = 0.8; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.arc(edx, offY + bh, edw / 2, 0, Math.PI / 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(edx + edw, offY + bh, edw / 2, Math.PI / 2, Math.PI); ctx.stroke();
      ctx.setLineDash([]);
      // Entrance step
      ctx.strokeStyle = "rgba(200,212,218,0.3)"; ctx.lineWidth = 0.8;
      ctx.strokeRect(edx - 4, offY + bh + WALL_T + 2, edw + 8, 5);
    }

    // ── FURNITURE ──
    laid.forEach(room => {
      const rx = offX + room.px * SCALE + WALL_T * 0.4;
      const ry = offY + room.py * SCALE + WALL_T * 0.4;
      const rw = room.pw * SCALE - WALL_T * 0.8;
      const rh = room.ph * SCALE - WALL_T * 0.8;
      const s = getStyle(room.type);
      const t = room.type.toLowerCase();

      ctx.save();
      ctx.strokeStyle = s.border;
      ctx.lineWidth = 0.9;
      ctx.globalAlpha = 0.65;

      if (t.includes("living")) {
        // Sofa along bottom
        const sw = rw * 0.6; const sh = rh * 0.18; const sx = rx + (rw - sw) / 2; const sy = ry + rh * 0.7;
        ctx.fillStyle = "rgba(50,80,100,0.1)"; ctx.fillRect(sx, sy, sw, sh); ctx.strokeRect(sx, sy, sw, sh);
        ctx.strokeRect(sx, sy - sh * 0.55, sw * 0.14, sh * 0.55);
        ctx.strokeRect(sx + sw - sw * 0.14, sy - sh * 0.55, sw * 0.14, sh * 0.55);
        // Coffee table
        ctx.strokeRect(rx + rw * 0.32, ry + rh * 0.42, rw * 0.32, rh * 0.17);
        // TV unit at top
        ctx.fillStyle = "rgba(30,40,50,0.12)"; ctx.fillRect(rx + rw * 0.22, ry + rh * 0.07, rw * 0.52, rh * 0.07); ctx.strokeRect(rx + rw * 0.22, ry + rh * 0.07, rw * 0.52, rh * 0.07);
        // Armchairs
        ctx.strokeRect(rx + rw * 0.04, ry + rh * 0.52, rw * 0.16, rh * 0.2);
        ctx.strokeRect(rx + rw * 0.8, ry + rh * 0.52, rw * 0.16, rh * 0.2);
      } else if (t.includes("kitchen")) {
        // L-shaped counter
        ctx.fillStyle = "rgba(80,120,60,0.08)"; ctx.fillRect(rx + 1, ry + 1, rw - 2, rh * 0.15); ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh * 0.15);
        ctx.fillRect(rx + 1, ry + 1, rw * 0.15, rh - 2); ctx.strokeRect(rx + 1, ry + 1, rw * 0.15, rh - 2);
        // Stove circles
        ctx.beginPath(); ctx.arc(rx + rw * 0.42, ry + rh * 0.07, rw * 0.05, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(rx + rw * 0.58, ry + rh * 0.07, rw * 0.05, 0, Math.PI * 2); ctx.stroke();
        // Sink
        ctx.strokeRect(rx + rw * 0.72, ry + rh * 0.02, rw * 0.22, rh * 0.12);
        ctx.beginPath(); ctx.arc(rx + rw * 0.83, ry + rh * 0.08, rh * 0.028, 0, Math.PI * 2); ctx.stroke();
        // Island/table
        if (rw > SCALE * 3) { ctx.strokeRect(rx + rw * 0.28, ry + rh * 0.45, rw * 0.42, rh * 0.35); }
      } else if (t.includes("dining")) {
        // Dining table + chairs
        const tw = rw * 0.62; const th = rh * 0.46;
        const tx = rx + (rw - tw) / 2; const ty = ry + (rh - th) / 2;
        ctx.fillStyle = "rgba(80,50,20,0.08)"; ctx.fillRect(tx, ty, tw, th); ctx.strokeRect(tx, ty, tw, th);
        for (let i = 0; i < 3; i++) {
          ctx.strokeRect(tx + tw * (0.08 + i * 0.31), ty - rh * 0.12, tw * 0.24, rh * 0.1);
          ctx.strokeRect(tx + tw * (0.08 + i * 0.31), ty + th + rh * 0.02, tw * 0.24, rh * 0.1);
        }
        ctx.strokeRect(tx - rw * 0.1, ty + th * 0.2, rw * 0.08, th * 0.6);
        ctx.strokeRect(tx + tw + rw * 0.02, ty + th * 0.2, rw * 0.08, th * 0.6);
      } else if (t.includes("bedroom")) {
        const bw2 = Math.min(rw * 0.72, rh * 0.7); const bh2 = bw2 * 0.72;
        const bx = rx + (rw - bw2) / 2; const by2 = ry + rh * 0.1;
        ctx.fillStyle = "rgba(50,80,150,0.08)"; ctx.fillRect(bx, by2, bw2, bh2); ctx.strokeRect(bx, by2, bw2, bh2);
        ctx.strokeRect(bx + bw2 * 0.06, by2 + bh2 * 0.04, bw2 * 0.38, bh2 * 0.24);
        ctx.strokeRect(bx + bw2 * 0.56, by2 + bh2 * 0.04, bw2 * 0.38, bh2 * 0.24);
        ctx.fillStyle = "rgba(30,50,80,0.12)"; ctx.fillRect(bx, by2 - bh2 * 0.1, bw2, bh2 * 0.1); ctx.strokeRect(bx, by2 - bh2 * 0.1, bw2, bh2 * 0.1);
        ctx.strokeRect(bx - bw2 * 0.18, by2, bw2 * 0.15, bw2 * 0.15);
        ctx.strokeRect(bx + bw2 + bw2 * 0.03, by2, bw2 * 0.15, bw2 * 0.15);
        // Wardrobe
        ctx.fillStyle = "rgba(60,80,60,0.08)";
        ctx.fillRect(rx + rw * 0.05, ry + rh * 0.82, rw * 0.5, rh * 0.14); ctx.strokeRect(rx + rw * 0.05, ry + rh * 0.82, rw * 0.5, rh * 0.14);
        ctx.beginPath(); ctx.moveTo(rx + rw * 0.3, ry + rh * 0.82); ctx.lineTo(rx + rw * 0.3, ry + rh * 0.96); ctx.stroke();
      } else if (t.includes("bathroom")) {
        // Bathtub
        ctx.fillStyle = "rgba(140,80,200,0.08)"; ctx.fillRect(rx + rw * 0.04, ry + rh * 0.05, rw * 0.88, rh * 0.42); ctx.strokeRect(rx + rw * 0.04, ry + rh * 0.05, rw * 0.88, rh * 0.42);
        ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(rx + rw * 0.5, ry + rh * 0.26, rh * 0.11, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        // Toilet
        ctx.strokeRect(rx + rw * 0.08, ry + rh * 0.6, rw * 0.3, rh * 0.32);
        ctx.beginPath(); ctx.ellipse(rx + rw * 0.23, ry + rh * 0.77, rw * 0.12, rh * 0.1, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeRect(rx + rw * 0.08, ry + rh * 0.56, rw * 0.3, rh * 0.06);
        // Sink
        ctx.strokeRect(rx + rw * 0.52, ry + rh * 0.6, rw * 0.38, rh * 0.28);
        ctx.beginPath(); ctx.arc(rx + rw * 0.71, ry + rh * 0.74, rw * 0.09, 0, Math.PI * 2); ctx.stroke();
      } else if (t.includes("office")) {
        ctx.fillStyle = "rgba(150,120,0,0.08)"; ctx.fillRect(rx + rw * 0.06, ry + rh * 0.06, rw * 0.74, rh * 0.28); ctx.strokeRect(rx + rw * 0.06, ry + rh * 0.06, rw * 0.74, rh * 0.28);
        ctx.beginPath(); ctx.arc(rx + rw * 0.44, ry + rh * 0.54, rh * 0.14, 0, Math.PI * 2); ctx.stroke();
        ctx.fillRect(rx + rw * 0.06, ry + rh * 0.76, rw * 0.88, rh * 0.18); ctx.strokeRect(rx + rw * 0.06, ry + rh * 0.76, rw * 0.88, rh * 0.18);
      } else if (t.includes("garage")) {
        // Car outline
        ctx.strokeStyle = "rgba(100,120,120,0.5)"; ctx.lineWidth = 1;
        const cw = rw * 0.55; const ch = rh * 0.55;
        const cx2 = rx + (rw - cw) / 2; const cy2 = ry + (rh - ch) / 2;
        ctx.strokeRect(cx2, cy2, cw, ch);
        ctx.beginPath(); ctx.ellipse(cx2 + cw * 0.22, cy2 + ch, cw * 0.14, cw * 0.08, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx2 + cw * 0.78, cy2 + ch, cw * 0.14, cw * 0.08, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    });

    // ── ROOM LABELS + DIMENSIONS ──
    laid.forEach(room => {
      const rx = offX + room.px * SCALE;
      const ry = offY + room.py * SCALE;
      const rw = room.pw * SCALE;
      const rh = room.ph * SCALE;
      const s = getStyle(room.type);
      const cx = rx + rw / 2; const cy = ry + rh / 2;

      // Room label
      const fz = Math.max(7, Math.min(10, rw / 9));
      ctx.fillStyle = s.border;
      ctx.font = `bold ${fz}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(s.label, cx, cy - 6);

      // Dimension in feet and metres
      const wFt = (room.pw * 3.281).toFixed(0); const hFt = (room.ph * 3.281).toFixed(0);
      ctx.fillStyle = "rgba(200,220,230,0.7)"; ctx.font = `${Math.max(6, fz - 2)}px monospace`;
      ctx.fillText(`${room.pw.toFixed(1)}m × ${room.ph.toFixed(1)}m`, cx, cy + 6);
      ctx.fillStyle = "rgba(200,220,230,0.45)"; ctx.font = `${Math.max(5, fz - 3)}px monospace`;
      ctx.fillText(`(${wFt}' × ${hFt}')`, cx, cy + 15);
    });

    // ── WIND FLOW ──
    if (showWindFlow) {
      ctx.save(); ctx.strokeStyle = "rgba(50,120,200,0.2)"; ctx.lineWidth = 1; ctx.setLineDash([4, 8]);
      for (let i = 0; i < 4; i++) {
        const wy = offY + (i + 0.5) * bh / 4;
        ctx.beginPath(); ctx.moveTo(offX - 50, wy); ctx.lineTo(offX + bw + 50, wy); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.fillStyle = "rgba(130,180,255,0.7)"; ctx.font = "8px monospace";
      ctx.textAlign = "left"; ctx.fillText("→ PREVAILING WIND", offX + 4, offY - WALL_T - 8); ctx.restore();
    }

    // ── TREES ──
    trees.slice(0, 3).forEach((_, i) => {
      const tx = offX - 30 - i * 18; const ty = offY + bh * 0.2 + i * 22;
      ctx.beginPath(); ctx.arc(tx, ty, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(46,180,80,0.25)"; ctx.fill();
      ctx.strokeStyle = "#2eb450"; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = "#2eb450"; ctx.font = "7px monospace"; ctx.textAlign = "center";
      ctx.fillText(`T${i + 1}`, tx, ty + 3);
    });

    // ── NORTH ARROW ──
    const nx = W - 36; const ny = H - 52;
    ctx.fillStyle = "#c0d4e0"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
    ctx.fillText("N", nx, ny - 18);
    ctx.beginPath(); ctx.moveTo(nx, ny - 14); ctx.lineTo(nx - 5, ny + 4); ctx.lineTo(nx, ny + 2); ctx.lineTo(nx + 5, ny + 4); ctx.closePath();
    ctx.fillStyle = "rgba(192,212,224,0.9)"; ctx.fill();
    ctx.strokeStyle = "#c0d4e0"; ctx.lineWidth = 1; ctx.stroke();

    // ── SCALE BAR ──
    const sbPx = SCALE * 5;
    ctx.fillStyle = "#c0d4e0"; ctx.fillRect(20, H - 22, sbPx, 3);
    ctx.fillRect(20, H - 24, 2, 7); ctx.fillRect(20 + sbPx - 2, H - 24, 2, 7);
    ctx.font = "7px monospace"; ctx.textAlign = "left"; ctx.fillStyle = "rgba(192,212,224,0.7)";
    ctx.fillText("0", 20, H - 6); ctx.fillText("5m", 20 + sbPx + 2, H - 6);

    // ── TITLE BLOCK ──
    ctx.fillStyle = "rgba(192,212,224,0.55)"; ctx.font = "8px monospace";
    ctx.textAlign = "left"; ctx.fillText(`GROUND FLOOR PLAN   ●  ${rooms.filter(r => (r.floor ?? 1) === 1).length} ROOMS   ●  SCALE 1:100`, 20, H - 20);
    ctx.textAlign = "right"; ctx.fillText(`${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E`, W - 20, H - 20);

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
  const trees: Tree[] = analysis?.tree_coordinates?.slice(0, 4) ?? [];
  const ecoScore = floorPlan ? Math.round(floorPlan.fitness_score * 100) : (analysis ? Math.round(analysis.buildability_score) : 71);
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
    if (!floorPlan && plotId && analysis) handleRegenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotId]);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>{`.gl{background:rgba(10,26,26,0.7);backdrop-filter:blur(10px);border:1px solid rgba(13,242,242,0.08)} .glm{background:rgba(13,242,242,0.04);border:1px solid rgba(13,242,242,0.1)} @keyframes aip{0%,100%{opacity:1}50%{opacity:0.5}} .aip{animation:aip 2s ease-in-out infinite}`}</style>
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
                <div className="mb-4"><label className="text-[11px] text-slate-400 mb-1.5 block">House Type</label>
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

          {/* CENTER canvas */}
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
                <div className="text-[9px] font-bold uppercase tracking-widest text-slate-500 mb-1">Legend</div>
                {[{ c: "#b0d8e8", l: "Windows" }, { c: "#2a2a2a", l: "Doors" }, { c: "#2a8a3a", l: "Trees" }, { c: "rgba(230,140,0,0.5)", l: "Solar Arc" }].map(({ c, l }) => (
                  <div key={l} className="flex items-center gap-2 mb-1">
                    <span style={{ width: 10, height: 10, background: c, display: "inline-block", borderRadius: 2 }} />
                    <span className="text-[10px] text-slate-400">{l}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 relative overflow-hidden">
              <BlueprintCanvas rooms={rooms} trees={trees} lat={lat} lon={lon} zoom={zoom} showSolarPath={showSolar} showWindFlow={showWind} floorPlan={floorPlan} />
              <div className="absolute bottom-4 right-4 flex flex-col gap-1">
                {[{ i: "add", a: () => setZoom(z => Math.min(z + 2, 32)) }, { i: "remove", a: () => setZoom(z => Math.max(z - 2, 6)) }, { i: "center_focus_strong", a: () => setZoom(14) }].map(({ i, a }) => (
                  <button key={i} onClick={a} className="w-9 h-9 rounded-lg flex items-center justify-center hover:text-primary transition-all text-slate-600 border border-slate-300/20 bg-white/5">
                    <span className="material-symbols-outlined text-lg">{i}</span>
                  </button>
                ))}
              </div>
              <div className="absolute top-3 left-3 flex flex-col gap-1.5">
                {[{ l: "Solar", on: showSolar, s: setShowSolar, c: "#e88c00" }, { l: "Wind", on: showWind, s: setShowWind, c: "#3b82f6" }].map(({ l, on, s, c }) => (
                  <button key={l} onClick={() => s(!on)} className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide transition-all"
                    style={{ background: on ? `${c}22` : "rgba(240,240,240,0.8)", border: `1px solid ${on ? c : "rgba(50,60,70,0.2)"}`, color: on ? c : "#334455" }}>{l}</button>
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
