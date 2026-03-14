"use client";

import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { generateFloorPlan } from "@/lib/api";

interface Room { id?: string; type: string; width: number; height: number; x: number; y: number; floor: number; orientation: string; }
interface Wall { id?: string; room_id: string; type: string; orientation: string; x: number; y: number; x2?: number; y2?: number; length: number; thickness: number; floor: number; }
interface Door { id?: string; room_to: string; type: string; x: number; y: number; width: number; orientation: string; floor: number; }
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

  }, [rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow, plotShape, plotArea, windDir, windVec, windParticles]);

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
function BlueprintCanvas({ rooms, walls, doors, windows, trees, lat, lon, zoom, showSolarPath, showWindFlow, floorPlan, plotShape, plotArea, windDir }:
  { rooms: Room[]; walls: Wall[]; doors: Door[]; windows: WindowEl[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; floorPlan: any; plotShape: string; plotArea: number; windDir: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const windParticles = useRef<Array<{x:number;y:number;life:number;speed:number;alpha:number}>>([]);

  const getRoomStyle = useCallback((type: string) => {
    const palette: Record<string, { bg: string; border: string; label: string }> = {
      living: { bg: "rgba(13,200,200,0.10)", border: "#0bc8c8", label: "LIVING ROOM" },
      bedroom: { bg: "rgba(74,157,232,0.11)", border: "#4a9de8", label: "BEDROOM" },
      kitchen: { bg: "rgba(44,180,110,0.10)", border: "#2cb46e", label: "KITCHEN" },
      bathroom: { bg: "rgba(155,114,212,0.11)", border: "#9b72d4", label: "BATHROOM" },
      office: { bg: "rgba(232,195,58,0.11)", border: "#e8c33a", label: "STUDY" },
      garage: { bg: "rgba(143,160,160,0.10)", border: "#8fa0a0", label: "GARAGE" },
      utility: { bg: "rgba(224,128,80,0.10)", border: "#e08050", label: "UTILITY" },
      dining: { bg: "rgba(232,122,58,0.10)", border: "#e87a3a", label: "DINING" },
      puja_room: { bg: "rgba(200,160,32,0.10)", border: "#c8a020", label: "PUJA ROOM" },
    };
    const key = Object.keys(palette).find(k => type.toLowerCase().replace("_", "").includes(k.replace("_", "")));
    return key ? palette[key] : { bg: "rgba(13,242,242,0.06)", border: "#0df2f2", label: type.toUpperCase() };
  }, []);

  const windVec = useMemo(() => {
    const M: Record<string,[number,number]> = {
      N:[0,-1],NE:[1,-1],E:[1,0],SE:[1,1],S:[0,1],SW:[-1,1],W:[-1,0],NW:[-1,-1],
      NNE:[0.5,-1],SSW:[-0.5,1],ENE:[1,-0.5],WSW:[-1,0.5],NNW:[-0.5,-1],SSE:[0.5,1],ESE:[1,0.5],WNW:[-1,-0.5],
    };
    const key = Object.keys(M).find(k => windDir.toUpperCase().startsWith(k)) ?? "SW";
    const [x, y] = M[key];
    const len = Math.sqrt(x * x + y * y) || 1;
    return { x: x / len, y: y / len };
  }, [windDir]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.offsetWidth || 700;
    const H = canvas.offsetHeight || 600;
    canvas.width = W;
    canvas.height = H;

    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);
    const GRID = 22;
    ctx.strokeStyle = "rgba(13,242,242,0.06)";
    ctx.lineWidth = 0.5;
    for (let gx = 0; gx < W; gx += GRID) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += GRID) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    ctx.strokeStyle = "rgba(13,242,242,0.11)";
    ctx.lineWidth = 0.8;
    for (let gx = 0; gx < W; gx += GRID * 5) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += GRID * 5) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    const floor1 = rooms.filter(room => (room.floor ?? 1) === 1);
    const floorWalls = walls.filter(wall => (wall.floor ?? 1) === 1);
    const floorDoors = doors.filter(door => (door.floor ?? 1) === 1);
    const floorWindows = windows.filter(window => (window.floor ?? 1) === 1);

    if (floor1.length === 0) {
      ctx.fillStyle = "#0df2f2";
      ctx.font = "bold 14px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("AWAITING FLOOR PLAN GENERATION", W / 2, H / 2 - 10);
      ctx.fillStyle = "rgba(13,242,242,0.4)";
      ctx.font = "11px sans-serif";
      ctx.fillText("Select a plot and run analysis", W / 2, H / 2 + 14);
      return;
    }

    const minX = Math.min(...floor1.map(room => room.x));
    const minY = Math.min(...floor1.map(room => room.y));
    const maxX = Math.max(...floor1.map(room => room.x + room.width));
    const maxY = Math.max(...floor1.map(room => room.y + room.height));
    const scale = Math.min((W - 172) / Math.max(maxX - minX, 0.1), (H - (showSolarPath ? 194 : 150)) / Math.max(maxY - minY, 0.1));
    const bw = (maxX - minX) * scale;
    const bh = (maxY - minY) * scale;
    const offX = (W - bw) / 2;
    const offY = Math.max(showSolarPath ? 118 : 82, (H - bh) / 2 + 10);
    const wallThickness = Math.max(6, scale * 0.36);
    const px = (x: number) => offX + (x - minX) * scale;
    const py = (y: number) => offY + (y - minY) * scale;
    const ps = (v: number) => v * scale;

    if (showSolarPath) {
      const now = new Date();
      const hour = now.getHours() + now.getMinutes() / 60;
      const safeLeft = Math.max(28, offX + 6);
      const safeRight = Math.min(W - 28, offX + bw - 6);
      const span = Math.max(96, safeRight - safeLeft);
      const arcBaseY = Math.max(44, offY - 28);
      const arcAmp = Math.min(38, Math.max(18, arcBaseY - 16));
      ctx.save();
      ctx.strokeStyle = "rgba(250,160,20,0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (let i = 0; i <= 30; i++) {
        const sx = safeLeft + span * (i / 30);
        const sy = arcBaseY - Math.sin((Math.PI * i) / 30) * arcAmp;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const progress = Math.max(0, Math.min(1, (hour - 6) / 12));
      const sunX = safeLeft + span * progress;
      const sunY = arcBaseY - Math.max(0, Math.sin(Math.max(0, (hour - 6) * Math.PI / 12))) * arcAmp;
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.arc(sunX, sunY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(245,158,11,0.5)";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(sunX + Math.cos(a) * 8, sunY + Math.sin(a) * 8);
        ctx.lineTo(sunX + Math.cos(a) * 12, sunY + Math.sin(a) * 12);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,185,30,0.95)";
      ctx.font = "8px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`, sunX, sunY - 15);
      ctx.restore();
    }

    ctx.fillStyle = "rgba(13,242,242,0.6)";
    ctx.font = "8px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`PLOT: ${plotShape.toUpperCase()} - ${plotArea}m2`, offX + 2, offY - wallThickness - 12);
    ctx.fillText(`WIND: ${windDir}`, offX + 2, offY - wallThickness - 2);

    ctx.fillStyle = "#111820";
    ctx.fillRect(offX, offY, bw, bh);

    floor1.forEach(room => {
      const style = getRoomStyle(room.type);
      ctx.fillStyle = style.bg;
      ctx.fillRect(px(room.x), py(room.y), ps(room.width), ps(room.height));
    });

    floorWalls.forEach(wall => {
      const horizontal = wall.orientation === "horizontal";
      const ww = horizontal ? ps(wall.length) : Math.max(3, ps(wall.thickness));
      const wh = horizontal ? Math.max(3, ps(wall.thickness)) : ps(wall.length);
      const wx = px(wall.x) - ww / 2;
      const wy = py(wall.y) - wh / 2;
      const exterior = wall.type === "exterior";
      ctx.fillStyle = exterior ? "#1d3737" : "#172c2c";
      ctx.fillRect(wx, wy, ww, wh);
      ctx.strokeStyle = exterior ? "rgba(13,242,242,0.84)" : "rgba(13,242,242,0.28)";
      ctx.lineWidth = exterior ? 1.2 : 0.8;
      ctx.strokeRect(wx, wy, ww, wh);
    });

    floorDoors.forEach(door => {
      const span = ps(door.width);
      ctx.strokeStyle = "rgba(13,242,242,0.85)";
      ctx.lineWidth = 1.1;
      if (door.orientation === "horizontal") {
        const dx = px(door.x) - span / 2;
        const dy = py(door.y) - wallThickness / 2;
        ctx.fillStyle = "#0d1117";
        ctx.fillRect(dx, dy - 1, span, wallThickness + 2);
        ctx.beginPath(); ctx.moveTo(dx, dy + wallThickness / 2); ctx.lineTo(dx + span, dy + wallThickness / 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(dx, dy + wallThickness / 2, span, -Math.PI / 2, 0); ctx.stroke();
      } else {
        const dy = py(door.y) - span / 2;
        const dx = px(door.x) - wallThickness / 2;
        ctx.fillStyle = "#0d1117";
        ctx.fillRect(dx - 1, dy, wallThickness + 2, span);
        ctx.beginPath(); ctx.moveTo(dx + wallThickness / 2, dy); ctx.lineTo(dx + wallThickness / 2, dy + span); ctx.stroke();
        ctx.beginPath(); ctx.arc(dx + wallThickness / 2, dy, span, Math.PI, 1.5 * Math.PI); ctx.stroke();
      }
    });

    const drawWindow = (x: number, y: number, w: number, h: number, horizontal: boolean) => {
      ctx.fillStyle = "rgba(64,180,248,0.46)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#b0d8e8";
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x, y, w, h);
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        if (horizontal) {
          const xx = x + (w * i) / 3;
          ctx.moveTo(xx, y);
          ctx.lineTo(xx, y + h);
        } else {
          const yy = y + (h * i) / 3;
          ctx.moveTo(x, yy);
          ctx.lineTo(x + w, yy);
        }
        ctx.stroke();
      }
    };

    floorWindows.forEach(win => {
      const parts = win.wall.split("_");
      const edge = parts[parts.length - 1];
      const roomId = parts.slice(0, -1).join("_");
      const room = floor1.find(item => item.id === roomId);
      if (!room) return;
      const span = ps(win.width);
      if (edge === "top") drawWindow(px(room.x + room.width / 2) - span / 2, py(room.y), span, wallThickness, true);
      if (edge === "bottom") drawWindow(px(room.x + room.width / 2) - span / 2, py(room.y + room.height) - wallThickness, span, wallThickness, true);
      if (edge === "left") drawWindow(px(room.x), py(room.y + room.height / 2) - span / 2, wallThickness, span, false);
      if (edge === "right") drawWindow(px(room.x + room.width) - wallThickness, py(room.y + room.height / 2) - span / 2, wallThickness, span, false);
    });

    floor1.forEach(room => {
      const style = getRoomStyle(room.type);
      const rx = px(room.x);
      const ry = py(room.y);
      const rw = ps(room.width);
      const rh = ps(room.height);
      const cx = rx + rw / 2;
      const cy = ry + rh / 2;
      const fs = Math.max(7, Math.min(12, rw / 8));
      ctx.fillStyle = style.border;
      ctx.font = `bold ${fs}px 'Space Grotesk',sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(style.label, cx, cy - fs * 0.7);
      ctx.fillStyle = "rgba(180,200,220,0.82)";
      ctx.font = `${Math.max(6, fs - 2)}px monospace`;
      ctx.fillText(`${room.width.toFixed(2)} x ${room.height.toFixed(2)}`, cx, cy + fs * 0.35);
      if (room.orientation) {
        ctx.fillStyle = "rgba(13,242,242,0.52)";
        ctx.font = `${Math.max(5, fs - 3)}px monospace`;
        ctx.fillText(room.orientation, cx, cy + fs * 1.3);
      }
    });

    if (showWindFlow) {
      if (windParticles.current.length < 35) {
        for (let i = 0; i < 2; i++) {
          let spawnX: number;
          let spawnY: number;
          if (Math.abs(windVec.x) >= Math.abs(windVec.y)) {
            spawnX = windVec.x > 0 ? offX - ps(1.5) - Math.random() * ps(1) : offX + bw + ps(0.5) + Math.random() * ps(1);
            spawnY = offY - ps(0.5) + Math.random() * (bh + ps(1));
          } else {
            spawnX = offX - ps(0.5) + Math.random() * (bw + ps(1));
            spawnY = windVec.y > 0 ? offY - ps(1.5) - Math.random() * ps(1) : offY + bh + ps(0.5) + Math.random() * ps(1);
          }
          windParticles.current.push({ x: spawnX, y: spawnY, life: 0, speed: 1.8 + Math.random() * 1.2, alpha: 0 });
        }
      }

      windParticles.current = windParticles.current.filter(particle => {
        if (particle.life >= 100) return false;
        const pastLeeward =
          (windVec.x > 0.1 && particle.x > offX + bw + ps(2)) ||
          (windVec.x < -0.1 && particle.x < offX - ps(2)) ||
          (windVec.y > 0.1 && particle.y > offY + bh + ps(2)) ||
          (windVec.y < -0.1 && particle.y < offY - ps(2));
        return !pastLeeward;
      });

      windParticles.current.forEach(particle => {
        particle.life++;
        particle.x += windVec.x * particle.speed * 1.6;
        particle.y += windVec.y * particle.speed * 1.6;
        particle.alpha = Math.sin(particle.life / 100 * Math.PI) * 0.85;
        const len = particle.speed * 9;
        const ex = particle.x - windVec.x * len;
        const ey = particle.y - windVec.y * len;
        ctx.strokeStyle = `rgba(60,160,240,${particle.alpha})`;
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(particle.x, particle.y);
        ctx.stroke();
        const angle = Math.atan2(windVec.y, windVec.x);
        ctx.fillStyle = `rgba(80,180,255,${particle.alpha})`;
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-5, -2.5);
        ctx.lineTo(-5, 2.5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    }

    const northX = W - 38;
    const northY = H - 58;
    ctx.fillStyle = "#0df2f2";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("N", northX, northY - 22);
    ctx.beginPath();
    ctx.moveTo(northX, northY - 18);
    ctx.lineTo(northX - 6, northY + 4);
    ctx.lineTo(northX, northY + 2);
    ctx.lineTo(northX + 6, northY + 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#0df2f2";
    ctx.lineWidth = 1;
    ctx.stroke();

    const sbPx = scale * 5;
    ctx.fillStyle = "rgba(13,242,242,0.7)";
    ctx.fillRect(20, H - 18, sbPx, 2);
    ctx.fillRect(20, H - 22, 2, 6);
    ctx.fillRect(20 + sbPx - 2, H - 22, 2, 6);
    ctx.font = "7px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(13,242,242,0.5)";
    ctx.fillText("0", 20, H - 5);
    ctx.fillText("5m", 20 + sbPx + 2, H - 5);
    ctx.textAlign = "right";
    ctx.fillText(`${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E`, W - 20, H - 18);

    trees.slice(0, 3).forEach((_, i) => {
      const tx = offX - 35 - i * 20;
      const ty = offY + bh * 0.25 + i * 24;
      ctx.beginPath();
      ctx.arc(tx, ty, 11, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(40,200,80,0.15)";
      ctx.fill();
      ctx.strokeStyle = "#30d060";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#30d060";
      ctx.font = "7px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`T${i + 1}`, tx, ty);
    });
  }, [rooms, walls, doors, windows, trees, lat, lon, zoom, showSolarPath, showWindFlow, plotShape, plotArea, windDir, windVec, getRoomStyle]);

  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      draw();
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  return <canvas ref={canvasRef} className="w-full h-full" style={{ display: "block" }} />;
}

export default function AnalysisPage() {
  const params = useParams(); const router = useRouter();
  const plotId = params.id as string;

  const [houseType, setHouseType] = useState("Eco-Villa (Single Story)");
  const [plotShape, setPlotShape] = useState("rectangle");
  const [targetArea, setTargetArea] = useState("240");
  const [numFloors, setNumFloors] = useState(1);
  const [treePres, setTreePres] = useState(true);
  const [maxSun, setMaxSun] = useState(true);
  const [natVent, setNatVent] = useState(true);
  const [sustPrio, setSustPrio] = useState(true);
  const [showSolar, setShowSolar] = useState(true);
  const [showWind, setShowWind] = useState(true);
  const [zoom, setZoom] = useState(14);
  const [generating, setGenerating] = useState(false);

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
    setFloorPlan, setFloorPlanVariants, setActiveVariantIndex,
    floorPlanVariants, activeVariantIndex, setGeneratingFloorPlan,
  } = useEco3DStore();
  const lat = selectedLat ?? 34.0522;
  const lon = selectedLon ?? -118.2437;

  // Active variant rooms (carousel drives what's displayed)
  const activeVariant = floorPlanVariants[activeVariantIndex] ?? null;
  const rooms = activeVariant?.layout ?? floorPlan?.layout ?? [];
  const walls = activeVariant?.walls ?? floorPlan?.walls ?? [];
  const doors = activeVariant?.doors ?? floorPlan?.doors ?? [];
  const windows = activeVariant?.windows ?? floorPlan?.windows ?? [];
  const trees = analysis?.tree_coordinates?.slice(0,4) ?? [];
  const ecoScore = activeVariant
    ? Math.round(activeVariant.fitness_score * 100)
    : floorPlan ? Math.round(floorPlan.fitness_score * 100)
    : (analysis ? Math.round(analysis.buildability_score) : 71);
  const solarPct = activeVariant
    ? Math.round(activeVariant.solar_score * 100)
    : floorPlan ? Math.round(floorPlan.sunlight_score * 100) : 88;
  const ventPct = activeVariant
    ? Math.round(activeVariant.ventilation_score * 100)
    : floorPlan ? Math.round(floorPlan.ventilation_score * 100) : 95;
  const treeDist = floorPlan?.tree_preserved_count ?? 0;
  const windDir = analysis?.environmental?.wind_direction ?? "SW";

  // Area input: user can type sqft or m²
  const [areaUnit, setAreaUnit] = useState<"sqft"|"sqm">("sqm");
  const areaInSqm = useMemo(() => {
    const v = parseFloat(targetArea) || 240;
    return areaUnit === "sqft" ? Math.round(v * 0.0929) : v;
  }, [targetArea, areaUnit]);
  const area = areaInSqm;

  const limits = useMemo(() => computeRoomLimits(area), [area]);

  const addLog = (msg: string) => {
    const n = new Date();
    const t = `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}:${String(n.getSeconds()).padStart(2,"0")}`;
    setLogs(prev => [{ time: t, msg }, ...prev].slice(0, 8));
  };

  const handleRegenerate = async () => {
    setGenerating(true);
    addLog(`Generating 5 variants for ${plotShape} · ${area} m²...`);
    try {
      const fp = await generateFloorPlan({
        plot_id: plotId,
        plot_area_sqm: area,
        num_floors: numFloors,
        preserve_trees: treePres,
        plot_shape: plotShape,
        house_type: houseType,
        room_preferences: {
          bedrooms: numBedrooms, bathrooms: numBathrooms,
          puja_room: hasPuja, garage: hasGarage,
          office: hasOffice, dining: hasDining, utility: hasUtility,
        },
        maximize_sunlight: maxSun,
        natural_ventilation: natVent,
        sustainability_priority: sustPrio,
      });
      setFloorPlan(fp);
      // Extract variants from properly typed response
      const variants = fp.variants ?? [];
      const bestIdx  = fp.best_variant_index ?? 0;
      if (variants.length > 0) {
        setFloorPlanVariants(variants, bestIdx);
        addLog(`✓ ${variants.length} variants generated — best: "${variants[bestIdx]?.style}"`);
        addLog(`Solar: ${Math.round((variants[bestIdx]?.solar_score??0)*100)}% · Vent: ${Math.round((variants[bestIdx]?.ventilation_score??0)*100)}% · Area: ${variants[bestIdx]?.total_area?.toFixed(0)} m²`);
      } else {
        addLog(`✓ ${fp.layout.length} rooms — fitness ${(fp.fitness_score*100).toFixed(0)}%`);
      }
      setGeneratingFloorPlan(false);
    } catch (err: any) {
      addLog(`Generation error: ${err?.message ?? "check backend"}`);
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (!floorPlan && plotId && analysis) handleRegenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotId]);

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
          <aside className="w-80 flex-shrink-0 flex flex-col border-r border-white/5 overflow-y-auto" style={{ background: "rgba(6,12,12,0.98)" }}>
            <div className="p-4 flex flex-col gap-4 flex-1">

              {/* House Type */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary mb-3">Configuration</div>
                <label className="text-[11px] text-slate-400 mb-1.5 block">House Type</label>
                <select value={houseType} onChange={e => setHouseType(e.target.value)} className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white appearance-none cursor-pointer focus:outline-none mb-3" style={{ background: "rgba(13,242,242,0.04)" }}>
                  {HOUSE_TYPES.map(t => <option key={t} value={t} style={{ background: "#0a1a1a" }}>{t}</option>)}
                </select>

                {/* Plot Shape */}
                <label className="text-[11px] text-slate-400 mb-1.5 block">Plot Shape</label>
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  {PLOT_SHAPES.map(ps => (
                    <button key={ps.value} onClick={() => setPlotShape(ps.value)}
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
                    <input type="number" value={targetArea} onChange={e => setTargetArea(e.target.value)}
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
                <button onClick={handleRegenerate} disabled={generating}
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
          </aside>

          {/* ── CENTER CANVAS ── */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-white/5">

            {/* ── Variant carousel ── */}
            {floorPlanVariants.length > 0 && (
              <div style={{ flexShrink:0, background:"rgba(8,14,14,0.98)", borderBottom:"1px solid rgba(255,255,255,0.05)", padding:"10px 16px", display:"flex", alignItems:"center", gap:12 }}>
                <button
                  onClick={() => setActiveVariantIndex(Math.max(0, activeVariantIndex - 1))}
                  disabled={activeVariantIndex === 0}
                  style={{ width:30, height:30, borderRadius:8, border:"1px solid rgba(13,242,242,0.2)", background:"transparent", color: activeVariantIndex===0?"#334155":"#0df2f2", cursor: activeVariantIndex===0?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
                >
                  <span className="material-symbols-outlined" style={{fontSize:18}}>chevron_left</span>
                </button>

                <div style={{ flex:1, display:"flex", gap:8, overflowX:"auto" }}>
                  {floorPlanVariants.map((v, i) => (
                    <button key={v.id} onClick={() => setActiveVariantIndex(i)}
                      style={{
                        flexShrink:0, padding:"6px 14px", borderRadius:8, fontSize:10, fontWeight:700, cursor:"pointer",
                        border:`1px solid ${i===activeVariantIndex ? "#0df2f2" : "rgba(255,255,255,0.08)"}`,
                        background: i===activeVariantIndex ? "rgba(13,242,242,0.12)" : "transparent",
                        color: i===activeVariantIndex ? "#0df2f2" : "#64748b",
                        display:"flex", flexDirection:"column", alignItems:"center", gap:2, minWidth:100,
                      }}
                    >
                      <span style={{textTransform:"uppercase",letterSpacing:"0.08em"}}>{v.style}</span>
                      <span style={{fontFamily:"monospace", fontSize:9, color: i===activeVariantIndex?"rgba(13,242,242,0.7)":"#334155"}}>
                        ECO {Math.round((v.eco_score ?? v.fitness_score)*100)}% · {v.total_area.toFixed(0)}m²
                      </span>
                      {v.is_best && <span style={{fontSize:8, color:"#fbbf24", textTransform:"uppercase", letterSpacing:"0.1em"}}>★ Best</span>}
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => setActiveVariantIndex(Math.min(floorPlanVariants.length-1, activeVariantIndex+1))}
                  disabled={activeVariantIndex === floorPlanVariants.length-1}
                  style={{ width:30, height:30, borderRadius:8, border:"1px solid rgba(13,242,242,0.2)", background:"transparent", color: activeVariantIndex===floorPlanVariants.length-1?"#334155":"#0df2f2", cursor: activeVariantIndex===floorPlanVariants.length-1?"not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}
                >
                  <span className="material-symbols-outlined" style={{fontSize:18}}>chevron_right</span>
                </button>

                <div style={{flexShrink:0, borderLeft:"1px solid rgba(255,255,255,0.06)", paddingLeft:12, fontSize:10, color:"#475569", fontFamily:"monospace"}}>
                  {activeVariantIndex+1} / {floorPlanVariants.length}
                </div>
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
                showSolarPath={showSolar} showWindFlow={showWind} floorPlan={floorPlan}
                plotShape={plotShape} plotArea={area} windDir={windDir} />
              <div className="absolute bottom-4 right-4 flex flex-col gap-1">
                {[{i:"add",a:()=>setZoom(z=>Math.min(z+2,32))},{i:"remove",a:()=>setZoom(z=>Math.max(z-2,6))},{i:"center_focus_strong",a:()=>setZoom(14)}].map(({i,a}) => (
                  <button key={i} onClick={a} className="w-9 h-9 rounded-lg flex items-center justify-center hover:text-primary transition-all text-slate-600 border border-slate-300/20 bg-white/5">
                    <span className="material-symbols-outlined text-lg">{i}</span>
                  </button>
                ))}
              </div>
              <div className="absolute top-3 left-3 flex flex-col gap-1.5">
                {[{l:"Solar",on:showSolar,s:setShowSolar,c:"#e88c00"},{l:"Wind",on:showWind,s:setShowWind,c:"#3b82f6"}].map(({l,on,s,c}) => (
                  <button key={l} onClick={() => s(!on)} className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wide transition-all"
                    style={{background:on?`${c}22`:"rgba(240,240,240,0.8)",border:`1px solid ${on?c:"rgba(50,60,70,0.2)"}`,color:on?c:"#334455"}}>{l}</button>
                ))}
              </div>
              <button onClick={() => router.push(`/model3d/${plotId}`)} className="absolute bottom-4 left-4 flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest"
                style={{background:"#0df2f2",color:"#080e0e",boxShadow:"0 0 16px rgba(13,242,242,0.25)"}}>
                <span className="material-symbols-outlined text-sm">view_in_ar</span>View 3D Model
              </button>
            </div>
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-t border-white/5 text-[10px] font-mono text-slate-500" style={{ background: "rgba(8,14,14,0.98)" }}>
              <span>⬡ PROFESSIONAL BLUEPRINT 3.0</span>
              <span>⊙ SITE: {plotId || "—"} · {plotShape.toUpperCase()}</span>
              <div className="flex items-center gap-3">
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
                <button onClick={handleRegenerate} className="flex items-center gap-1 px-3 py-1 rounded font-bold text-[10px]" style={{background:"#0df2f2",color:"#080e0e"}}>Save Design</button>
              </div>
            </div>
          </div>

          {/* ── RIGHT PANEL ── */}
          <aside className="w-80 flex-shrink-0 flex flex-col overflow-y-auto" style={{ background: "rgba(6,12,12,0.98)" }}>
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
                <div className="glm p-3 rounded-lg space-y-3">
                  {/* ── Core scores ── */}
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

                  {/* ── Topography ── */}
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

                  {/* ── Climate ── */}
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">Climate (Real-Time)</div>
                    {[
                      { k: "Rainfall",     v: `${analysis.environmental.rainfall_mm.toFixed(0)} mm/yr` },
                      { k: "Wind",         v: `${analysis.environmental.wind_ms?.toFixed(1) ?? "—"} m/s ${analysis.environmental.wind_direction}` },
                      { k: "Sun Hours",    v: `${analysis.environmental.sun_exposure_hours.toFixed(1)} h/day` },
                      { k: "Solar Rad.",   v: analysis.environmental.solar_radiation_kwh ? `${(analysis.environmental.solar_radiation_kwh as number).toFixed(1)} kWh/m²/d` : "—" },
                      { k: "NDVI",         v: analysis.environmental.ndvi.toFixed(3) },
                    ].map(({ k, v }) => (
                      <div key={k} className="flex justify-between py-1 border-b border-white/5">
                        <span className="text-[10px] text-slate-500">{k}</span>
                        <span className="text-[10px] font-mono text-slate-200">{v}</span>
                      </div>
                    ))}
                  </div>

                  {/* ── Soil Profile (SoilGrids v2) ── */}
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">Soil Profile — SoilGrids v2</div>
                    {[
                      { k: "Type",         v: analysis.environmental.soil_type },
                      { k: "Clay",         v: analysis.environmental.clay_pct != null ? `${(analysis.environmental.clay_pct as number).toFixed(1)}%` : "—" },
                      { k: "Sand",         v: analysis.environmental.sand_pct != null ? `${(analysis.environmental.sand_pct as number).toFixed(1)}%` : "—" },
                      { k: "Silt",         v: analysis.environmental.silt_pct != null ? `${(analysis.environmental.silt_pct as number).toFixed(1)}%` : "—" },
                      { k: "pH",           v: analysis.environmental.soil_ph != null ? `${(analysis.environmental.soil_ph as number).toFixed(1)}` : "—" },
                      { k: "Organic C",    v: analysis.environmental.organic_carbon != null ? `${(analysis.environmental.organic_carbon as number).toFixed(1)} g/kg` : "—" },
                      { k: "Bulk Density", v: analysis.environmental.bulk_density != null ? `${(analysis.environmental.bulk_density as number).toFixed(2)} g/cm³` : "—" },
                      { k: "Buildable",    v: analysis.environmental.soil_buildable === false ? "No" : "Yes" },
                    ].map(({ k, v }) => (
                      <div key={k} className="flex justify-between py-1 border-b border-white/5">
                        <span className="text-[10px] text-slate-500">{k}</span>
                        <span className={`text-[10px] font-mono ${k === "Buildable" && v === "No" ? "text-amber-400" : "text-slate-200"}`}>{v}</span>
                      </div>
                    ))}
                    {analysis.environmental.soil_source && (
                      <div className="mt-1 text-[8px] text-slate-600 leading-tight">{analysis.environmental.soil_source as string}</div>
                    )}
                  </div>

                  {/* ── River Flood — GloFAS ── */}
                  <div>
                    <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1.5">River Flood — GloFAS</div>
                    {[
                      { k: "Discharge Peak", v: analysis.environmental.river_discharge_peak_m3s != null ? `${(analysis.environmental.river_discharge_peak_m3s as number).toFixed(1)} m³/s` : "No river nearby" },
                      { k: "Discharge Mean", v: analysis.environmental.river_discharge_mean_m3s != null ? `${(analysis.environmental.river_discharge_mean_m3s as number).toFixed(1)} m³/s` : "—" },
                      { k: "Flood Index",    v: analysis.environmental.glofas_flood_index != null ? `${((analysis.environmental.glofas_flood_index as number) * 100).toFixed(0)}%` : "—" },
                    ].map(({ k, v }) => (
                      <div key={k} className="flex justify-between py-1 border-b border-white/5">
                        <span className="text-[10px] text-slate-500">{k}</span>
                        <span className="text-[10px] font-mono text-slate-200">{v}</span>
                      </div>
                    ))}
                    {analysis.environmental.flood_source && (
                      <div className="mt-1 text-[8px] text-slate-600 leading-tight">{analysis.environmental.flood_source as string}</div>
                    )}
                  </div>
                </div>
              )}
              <button onClick={() => router.push(`/report/${plotId}`)} className="w-full py-2.5 rounded-lg text-[11px] font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-primary/10 transition-all" style={{border:"1px solid #0df2f2",color:"#0df2f2"}}>
                <span className="material-symbols-outlined text-sm">assessment</span>View Detailed Report
              </button>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
