"use client";

import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";
import { generateFloorPlan } from "@/lib/api";

interface Room { type: string; width: number; height: number; x: number; y: number; floor: number; orientation: string; }
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
function BlueprintCanvas({ rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow, floorPlan, plotShape, plotArea, windDir }:
  { rooms: Room[]; trees: Tree[]; lat: number; lon: number; zoom: number; showSolarPath: boolean; showWindFlow: boolean; floorPlan: any; plotShape: string; plotArea: number; windDir: string }) {
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
    ctx.fillStyle = "#f4f0e8";  // warm white like drafting paper
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(100,140,160,0.18)"; ctx.lineWidth = 0.5;
    const GRID = 20;
    for(let x=0;x<W;x+=GRID){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
    for(let y=0;y<H;y+=GRID){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}

    if (rooms.length === 0) {
      ctx.fillStyle = "#2a3a4a"; ctx.font = "bold 14px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("AWAITING FLOOR PLAN GENERATION", W/2, H/2-10);
      ctx.fillStyle = "#64748b"; ctx.font = "11px sans-serif";
      ctx.fillText("Select a plot and run analysis", W/2, H/2+14);
      return;
    }

    const SCALE = zoom;
    const OWT = Math.max(8, zoom * 0.45);   // outer wall thickness px
    const IWT = Math.max(4, zoom * 0.2);    // inner wall thickness px

    // ── Shape-specific layout: different arrangement per shape ──
    const shape = plotShape.toLowerCase().replace(/[-\s]/g,"");

    // Lay out rooms into a grid matching the plot shape
    const floor1 = rooms.filter(r => (r.floor ?? 1) === 1);
    const ORDER = ["living","kitchen","dining","bedroom","bedroom","bedroom","bathroom","puja_room","office","utility","garage"];
    const sorted = [...floor1].sort((a,b)=>{
      const ai=ORDER.findIndex(o=>a.type.toLowerCase().includes(o.replace("_","")));
      const bi=ORDER.findIndex(o=>b.type.toLowerCase().includes(o.replace("_","")));
      return (ai<0?99:ai)-(bi<0?99:bi);
    });

    // ── NORMALIZE room sizes to be realistic and proportional ──
    const normalizeSize = (r: Room) => {
      const t = r.type.toLowerCase();
      if(t.includes("living"))   return {w:Math.max(5.0,Math.min(8.0,r.width)),  h:Math.max(4.0,Math.min(6.5,r.height))};
      if(t.includes("kitchen"))  return {w:Math.max(3.2,Math.min(5.0,r.width)),  h:Math.max(3.0,Math.min(4.5,r.height))};
      if(t.includes("dining"))   return {w:Math.max(3.0,Math.min(5.0,r.width)),  h:Math.max(3.0,Math.min(4.5,r.height))};
      if(t.includes("bedroom"))  return {w:Math.max(3.2,Math.min(5.0,r.width)),  h:Math.max(3.0,Math.min(4.5,r.height))};
      if(t.includes("bathroom")) return {w:Math.max(1.8,Math.min(3.0,r.width)),  h:Math.max(1.8,Math.min(3.0,r.height))};
      if(t.includes("puja"))     return {w:Math.max(2.0,Math.min(3.0,r.width)),  h:Math.max(2.0,Math.min(3.0,r.height))};
      if(t.includes("office"))   return {w:Math.max(3.0,Math.min(4.5,r.width)),  h:Math.max(3.0,Math.min(4.0,r.height))};
      if(t.includes("garage"))   return {w:Math.max(5.0,Math.min(7.5,r.width)),  h:Math.max(4.5,Math.min(6.5,r.height))};
      if(t.includes("utility"))  return {w:Math.max(2.0,Math.min(3.5,r.width)),  h:Math.max(2.0,Math.min(3.5,r.height))};
      return {w:Math.max(2.5,Math.min(4.5,r.width)), h:Math.max(2.5,Math.min(4.0,r.height))};
    };

    // ── Shape-driven row arrangement ──
    // Different shapes use different row splits so the layout actually varies
    let rowDef: number[];  // how many rooms per row
    const n = sorted.length;
    if(shape==="lshape") {
      // L: top row has ~60% of rooms (the long bar), bottom-left has rest
      const topN = Math.ceil(n * 0.58);
      rowDef = [topN, n - topN];
    } else if(shape==="tshape") {
      // T: top row full width, then 2 narrower middle rows
      const topN = Math.min(3, Math.ceil(n*0.35));
      const midN = Math.min(3, Math.ceil(n*0.35));
      rowDef = [topN, midN, n - topN - midN];
    } else if(shape==="irregular") {
      // Irregular: stagger rows unevenly (2, 3, 2, remainder)
      const r0=Math.min(2,n); const r1=Math.min(3,n-r0); const r2=Math.min(2,n-r0-r1);
      rowDef = [r0,r1,r2,n-r0-r1-r2].filter(x=>x>0);
    } else if(shape==="square") {
      // Square: roughly equal rows
      const cols = Math.round(Math.sqrt(n));
      rowDef = Array.from({length:Math.ceil(n/cols)},(_,i)=>Math.min(cols,n-i*cols)).filter(x=>x>0);
    } else {
      // Rectangle (default): public row + private row + service row
      const pubRooms = sorted.filter(r=>["living","kitchen","dining"].some(t=>r.type.toLowerCase().includes(t)));
      const prvRooms = sorted.filter(r=>["bedroom","bathroom","puja"].some(t=>r.type.toLowerCase().includes(t.replace("_",""))));
      const svcRooms = sorted.filter(r=>["office","utility","garage","corridor"].some(t=>r.type.toLowerCase().includes(t)));
      const rows2: Room[][] = [pubRooms,prvRooms,svcRooms].filter(r=>r.length>0);
      // Use row sizes
      const rowData2 = rows2.map(row => {
        const totalW2 = row.reduce((s,r)=>s+normalizeSize(r).w,0);
        const maxH2 = Math.max(...row.map(r=>normalizeSize(r).h));
        return {totalW:totalW2, maxH:maxH2, rooms:row};
      });
      const maxW2 = Math.max(...rowData2.map(r=>r.totalW));
      const laid2: Array<Room & {pw:number;ph:number;px:number;py:number}> = [];
      let curY2=0;
      rowData2.forEach(({totalW:tw,maxH:mh,rooms:row})=>{
        const scale = tw < maxW2 ? maxW2/tw : 1;
        let curX2=0;
        row.forEach(r=>{
          const sz=normalizeSize(r);
          laid2.push({...r,pw:sz.w*scale,ph:sz.h,px:curX2,py:curY2});
          curX2+=sz.w*scale;
        });
        curY2+=mh;
      });
      // Use laid2 directly
      const maxPX2 = Math.max(...laid2.map(r=>r.px+r.pw));
      const maxPY2 = Math.max(...laid2.map(r=>r.py+r.ph));
      const bw2 = maxPX2*SCALE; const bh2 = maxPY2*SCALE;
      const offX2 = (W-bw2)/2; const offY2 = (H-bh2)/2+10;
      renderFloorPlan(ctx, laid2, maxPX2, maxPY2, offX2, offY2, SCALE, OWT, IWT, W, H, t);
      return;
    }

    // Build rows from rowDef
    const rows3: Room[][] = [];
    let ri=0;
    rowDef.forEach(count=>{
      rows3.push(sorted.slice(ri,ri+count));
      ri+=count;
    });

    const rowData3 = rows3.filter(r=>r.length>0).map(row=>{
      const tw=row.reduce((s,r)=>s+normalizeSize(r).w,0);
      const mh=Math.max(...row.map(r=>normalizeSize(r).h));
      return {totalW:tw, maxH:mh, rooms:row};
    });
    const maxW3 = Math.max(...rowData3.map(r=>r.totalW));
    const laid3: Array<Room & {pw:number;ph:number;px:number;py:number}> = [];
    let curY3=0;

    // Shape-specific x offsets to create actual shape variation
    rowData3.forEach(({totalW:tw,maxH:mh,rooms:row},ri2)=>{
      const scale = tw < maxW3 ? maxW3/tw : 1;
      // L-shape: indent second row to the right
      // T-shape: center the narrower rows
      // Irregular: alternate left/center
      let startX = 0;
      if(shape==="lshape" && ri2>=1) startX = maxW3 * 0.5;
      if(shape==="tshape" && ri2>=1) startX = (maxW3 - tw*scale) / 2;
      if(shape==="irregular") startX = [0, maxW3*0.15, 0, maxW3*0.1][ri2] ?? 0;

      let curX3=startX;
      row.forEach(r=>{
        const sz=normalizeSize(r);
        laid3.push({...r,pw:sz.w*scale,ph:sz.h,px:curX3,py:curY3});
        curX3+=sz.w*scale;
      });
      curY3+=mh;
    });

    const maxPX3 = Math.max(...laid3.map(r=>r.px+r.pw));
    const maxPY3 = Math.max(...laid3.map(r=>r.py+r.ph));
    const bw3 = maxPX3*SCALE; const bh3 = maxPY3*SCALE;
    const offX3 = (W-bw3)/2; const offY3 = (H-bh3)/2+10;
    renderFloorPlan(ctx, laid3, maxPX3, maxPY3, offX3, offY3, SCALE, OWT, IWT, W, H, t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, trees, lat, lon, zoom, showSolarPath, showWindFlow, plotShape, plotArea, windDir, layoutRooms, windVec]);

  // ── renderFloorPlan: the actual drawing ────────────────────────────────────
  const renderFloorPlan = useCallback((
    ctx: CanvasRenderingContext2D,
    laid: Array<Room & {pw:number;ph:number;px:number;py:number}>,
    maxPX: number, maxPY: number,
    offX: number, offY: number,
    SCALE: number, OWT: number, IWT: number,
    W: number, H: number, t: number
  ) => {
    if(laid.length===0) return;
    const bw = maxPX*SCALE; const bh = maxPY*SCALE;
    timeRef.current = t / 1000;

    const ROOM_CFG: Record<string,{bg:string;border:string;label:string}> = {
      living:    {bg:"#f0f8f0",border:"#2a8a6a",label:"LIVING ROOM"},
      bedroom:   {bg:"#f0f4ff",border:"#3a6aaa",label:"BEDROOM"},
      kitchen:   {bg:"#f8f4e8",border:"#8a6a2a",label:"KITCHEN"},
      bathroom:  {bg:"#f4f0ff",border:"#7a5a9a",label:"BATHROOM"},
      office:    {bg:"#fffff0",border:"#8a8a2a",label:"STUDY"},
      garage:    {bg:"#f2f2f2",border:"#6a7a7a",label:"GARAGE"},
      utility:   {bg:"#fff8f4",border:"#9a6a3a",label:"UTILITY"},
      dining:    {bg:"#fff4f0",border:"#aa4444",label:"DINING"},
      puja_room: {bg:"#fffce8",border:"#c8900a",label:"PUJA ROOM"},
    };
    const getStyle=(t:string)=>{
      const k=Object.keys(ROOM_CFG).find(k=>t.toLowerCase().includes(k.replace("_","")));
      return k?ROOM_CFG[k]:{bg:"#f8f8f8",border:"#555",label:t.toUpperCase()};
    };

    const windVecLocal = (() => {
      const M: Record<string,[number,number]> = {N:[0,-1],NE:[1,-1],E:[1,0],SE:[1,1],S:[0,1],SW:[-1,1],W:[-1,0],NW:[-1,-1]};
      const key=Object.keys(M).find(k=>windDir.startsWith(k))??"SW";
      const [x,z]=M[key]; const l=Math.sqrt(x*x+z*z)||1;
      return {x:x/l,y:z/l};
    })();

    // ── Solar arc ──
    if(showSolarPath) {
      const now2=new Date(); const h2=now2.getHours()+now2.getMinutes()/60;
      ctx.save();
      ctx.strokeStyle="rgba(200,110,20,0.35)"; ctx.lineWidth=1.5; ctx.setLineDash([5,4]);
      ctx.beginPath();
      for(let i2=0;i2<=30;i2++){
        const a2=(Math.PI*i2)/30;
        const sx2=offX-40+(bw+80)*(i2/30);
        const sy2=offY-55-Math.sin(a2)*42;
        i2===0?ctx.moveTo(sx2,sy2):ctx.lineTo(sx2,sy2);
      }
      ctx.stroke(); ctx.setLineDash([]);
      const sunX2=offX+bw*((h2-6)/12);
      const sunY2=offY-55-Math.max(0,Math.sin(Math.max(0,(h2-6)*Math.PI/12)))*42;
      ctx.fillStyle="#f59e0b"; ctx.beginPath(); ctx.arc(sunX2,sunY2,6,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="rgba(245,158,11,0.5)"; ctx.lineWidth=1.5;
      for(let i3=0;i3<8;i3++){const a3=(i3/8)*Math.PI*2; ctx.beginPath(); ctx.moveTo(sunX2+Math.cos(a3)*8,sunY2+Math.sin(a3)*8); ctx.lineTo(sunX2+Math.cos(a3)*12,sunY2+Math.sin(a3)*12); ctx.stroke();}
      ctx.fillStyle="rgba(245,158,11,0.8)"; ctx.font="8px monospace"; ctx.textAlign="center";
      ctx.fillText(`${now2.getHours().toString().padStart(2,"0")}:${now2.getMinutes().toString().padStart(2,"0")}`,sunX2,sunY2-15);
      ctx.restore();
    }

    // ── Outer boundary fill (plot shape) ──
    const poly=makePlotPolygon(plotShape,plotArea);
    if(poly.length>2){
      const polyMaxX=Math.max(...poly.map(p=>p[0]));
      const polyMaxY=Math.max(...poly.map(p=>p[1]));
      const pSX=bw/polyMaxX; const pSY=bh/polyMaxY;
      ctx.save();
      ctx.beginPath();
      poly.forEach(([px,py],i)=>{
        const sx=offX+px*pSX; const sy=offY+py*pSY;
        i===0?ctx.moveTo(sx,sy):ctx.lineTo(sx,sy);
      });
      ctx.closePath();
      ctx.fillStyle="rgba(180,200,190,0.12)"; ctx.fill();
      ctx.strokeStyle="rgba(100,140,100,0.45)"; ctx.lineWidth=1.5; ctx.setLineDash([8,5]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle="rgba(80,110,90,0.5)"; ctx.font="8px monospace"; ctx.textAlign="left";
      ctx.fillText(`PLOT: ${plotShape.toUpperCase()} — ${plotArea}m²`, offX+2, offY-OWT-12);
      ctx.restore();
    }

    // ── Outer wall — shape-aware clipping mask ──
    // For L/T/Irregular: instead of a plain rectangle, we clip the rooms to the plot shape
    const buildClipPath = (ctx: CanvasRenderingContext2D) => {
      const shapeKey = plotShape.toLowerCase().replace(/[-\s]/g,"");
      if(["lshape","l"].includes(shapeKey)) {
        // L = full top half, bottom-left only
        ctx.beginPath();
        ctx.moveTo(offX, offY);
        ctx.lineTo(offX+bw, offY);
        ctx.lineTo(offX+bw, offY+bh*0.5);
        ctx.lineTo(offX+bw*0.5, offY+bh*0.5);
        ctx.lineTo(offX+bw*0.5, offY+bh);
        ctx.lineTo(offX, offY+bh);
        ctx.closePath();
      } else if(["tshape","t"].includes(shapeKey)) {
        // T = full top bar, central stem
        const stemW = bw * 0.4; const stemX = offX + (bw-stemW)/2;
        ctx.beginPath();
        ctx.moveTo(offX, offY);
        ctx.lineTo(offX+bw, offY);
        ctx.lineTo(offX+bw, offY+bh*0.45);
        ctx.lineTo(stemX+stemW, offY+bh*0.45);
        ctx.lineTo(stemX+stemW, offY+bh);
        ctx.lineTo(stemX, offY+bh);
        ctx.lineTo(stemX, offY+bh*0.45);
        ctx.lineTo(offX, offY+bh*0.45);
        ctx.closePath();
      } else if(["irregular"].includes(shapeKey)) {
        // Irregular = slight offset on corners
        ctx.beginPath();
        ctx.moveTo(offX+bw*0.08, offY);
        ctx.lineTo(offX+bw*0.92, offY);
        ctx.lineTo(offX+bw, offY+bh*0.12);
        ctx.lineTo(offX+bw, offY+bh*0.88);
        ctx.lineTo(offX+bw*0.85, offY+bh);
        ctx.lineTo(offX+bw*0.15, offY+bh);
        ctx.lineTo(offX, offY+bh*0.85);
        ctx.lineTo(offX, offY+bh*0.12);
        ctx.closePath();
      } else {
        // Rectangle / Square
        ctx.beginPath();
        ctx.rect(offX, offY, bw, bh);
      }
    };

    // Draw white outer wall fill (clipped to shape)
    ctx.save();
    buildClipPath(ctx);
    ctx.clip();
    ctx.fillStyle="#ffffff";
    ctx.fillRect(offX-OWT, offY-OWT, bw+OWT*2, bh+OWT*2);
    // Room fills inside clip
    laid.forEach(room=>{
      const rx=offX+room.px*SCALE; const ry=offY+room.py*SCALE;
      const rw=room.pw*SCALE; const rh=room.ph*SCALE;
      const s=getStyle(room.type);
      ctx.fillStyle=s.bg; ctx.fillRect(rx,ry,rw,rh);
    });
    ctx.restore();

    // Outer wall border (shape outline — thick)
    ctx.save();
    buildClipPath(ctx);
    ctx.strokeStyle="#1a2530"; ctx.lineWidth=OWT*0.9; ctx.stroke();
    ctx.restore();

    // ── Interior walls (thin lines) ──
    ctx.strokeStyle="#1a2530"; ctx.lineWidth=IWT*0.8;
    laid.forEach(room=>{
      const rx=offX+room.px*SCALE; const ry=offY+room.py*SCALE;
      const rw=room.pw*SCALE; const rh=room.ph*SCALE;
      if(room.px+room.pw<maxPX-0.01){ ctx.beginPath(); ctx.moveTo(rx+rw,ry); ctx.lineTo(rx+rw,ry+rh); ctx.stroke(); }
      if(room.py+room.ph<maxPY-0.01){ ctx.beginPath(); ctx.moveTo(rx,ry+rh); ctx.lineTo(rx+rw,ry+rh); ctx.stroke(); }
    });

    // ── Doors (swing arcs) ──
    laid.forEach((room,idx)=>{
      const rx=offX+room.px*SCALE; const ry=offY+room.py*SCALE;
      const rw=room.pw*SCALE; const rh=room.ph*SCALE;
      const dw=Math.min(rw*0.38,SCALE*0.85);
      ctx.strokeStyle="#1a2530"; ctx.lineWidth=1.5;
      // Bottom door
      if(room.py+room.ph<maxPY-0.01){
        const dx=rx+(rw-dw)/2; const dy=ry+rh;
        // Gap in wall
        ctx.fillStyle=laid.find(r2=>r2.py===room.py+room.ph && Math.abs(r2.px-room.px)<room.pw)?laid.find(r2=>r2.py===room.py+room.ph && Math.abs(r2.px-room.px)<room.pw)!.type?getStyle(laid.find(r2=>r2.py===room.py+room.ph && Math.abs(r2.px-room.px)<room.pw)!.type).bg:"#fff":"#fff";
        ctx.fillRect(dx, dy-IWT/2, dw, IWT+1);
        ctx.strokeStyle="rgba(26,37,48,0.7)"; ctx.lineWidth=1.2; ctx.setLineDash([2,2]);
        ctx.beginPath(); ctx.arc(dx, dy, dw, 0, Math.PI/2); ctx.stroke();
        ctx.setLineDash([]);
      }
      // Right door (alternating rooms)
      if(room.px+room.pw<maxPX-0.01 && idx%3===1){
        const dh=Math.min(rh*0.38,SCALE*0.75);
        const dy2=ry+(rh-dh)/2; const dx2=rx+rw;
        ctx.fillStyle="#fff"; ctx.fillRect(dx2-IWT/2, dy2, IWT+1, dh);
        ctx.strokeStyle="rgba(26,37,48,0.7)"; ctx.lineWidth=1.2; ctx.setLineDash([2,2]);
        ctx.beginPath(); ctx.arc(dx2, dy2, dh, Math.PI/2, Math.PI); ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // ── Windows (architectural style — blue fills with frame marks in outer walls) ──
    laid.forEach(room=>{
      const rx=offX+room.px*SCALE; const ry=offY+room.py*SCALE;
      const rw=room.pw*SCALE; const rh=room.ph*SCALE;
      const t2=room.type.toLowerCase();
      if(t2.includes("bathroom")||t2.includes("utility")) return;
      const ww=Math.min(rw*0.52,SCALE*1.05);
      // Helper: draw a window slot
      const drawWin = (wx: number, wy: number, wWidth: number, wHeight: number, horiz: boolean) => {
        // Blue glass fill
        ctx.fillStyle="#b8d8f4"; ctx.fillRect(wx, wy, wWidth, wHeight);
        // Frame lines
        ctx.strokeStyle="#1a4a7a"; ctx.lineWidth=1.8;
        ctx.strokeRect(wx, wy, wWidth, wHeight);
        // Centre divider
        if(horiz) {
          ctx.beginPath(); ctx.moveTo(wx+wWidth/2,wy); ctx.lineTo(wx+wWidth/2,wy+wHeight); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(wx,wy+wHeight/2); ctx.lineTo(wx+wWidth,wy+wHeight/2); ctx.stroke();
        }
        // Side tick marks for window reveal
        ctx.strokeStyle="#1a2530"; ctx.lineWidth=1.2;
        if(horiz){
          ctx.beginPath(); ctx.moveTo(wx,wy); ctx.lineTo(wx,wy-2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(wx+wWidth,wy); ctx.lineTo(wx+wWidth,wy-2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(wx,wy+wHeight); ctx.lineTo(wx,wy+wHeight+2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(wx+wWidth,wy+wHeight); ctx.lineTo(wx+wWidth,wy+wHeight+2); ctx.stroke();
        }
      };
      // Top window (north-facing rooms)
      if(room.py<0.01){
        drawWin(rx+(rw-ww)/2, offY-OWT, ww, OWT, true);
      }
      // Bottom window (south-facing)
      if(room.py+room.ph>maxPY-0.01){
        drawWin(rx+(rw-ww)/2, offY+bh, ww, OWT, true);
      }
      // Left window
      if(room.px<0.01){
        const wh2=Math.min(rh*0.5,SCALE*1.0);
        drawWin(offX-OWT, ry+(rh-wh2)/2, OWT, wh2, false);
      }
      // Right window
      if(room.px+room.pw>maxPX-0.01){
        const wh2=Math.min(rh*0.5,SCALE*1.0);
        drawWin(offX+bw, ry+(rh-wh2)/2, OWT, wh2, false);
      }
    });

    // ── Main entrance (bottom center — with proper door swing arc) ──
    const entrW=SCALE*1.0;
    const entrX=offX+bw/2-entrW/2;
    // Clear the wall section
    ctx.fillStyle="#f4f0e8"; ctx.fillRect(entrX, offY+bh, entrW, OWT+2);
    // Frame lines
    ctx.strokeStyle="#1a2530"; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(entrX, offY+bh); ctx.lineTo(entrX, offY+bh+OWT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(entrX+entrW, offY+bh); ctx.lineTo(entrX+entrW, offY+bh+OWT); ctx.stroke();
    // Door leaf (single 90-degree swing shown as dashed quarter circle)
    ctx.strokeStyle="rgba(26,37,48,0.7)"; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.arc(entrX+entrW, offY+bh, entrW, Math.PI, Math.PI*1.5); ctx.stroke();
    ctx.setLineDash([]);
    // Door leaf solid line
    ctx.strokeStyle="#1a2530"; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(entrX+entrW, offY+bh); ctx.lineTo(entrX+entrW, offY+bh-entrW); ctx.stroke();
    // Entry step (double lines below)
    ctx.strokeStyle="rgba(26,37,48,0.35)"; ctx.lineWidth=0.8;
    ctx.strokeRect(entrX-4, offY+bh+OWT+2, entrW+8, 5);
    ctx.strokeRect(entrX-8, offY+bh+OWT+9, entrW+16, 5);
    // Label
    ctx.fillStyle="#1a2530"; ctx.font=`bold ${Math.max(7,SCALE*0.55)}px 'Space Grotesk', monospace`;
    ctx.textAlign="center";
    ctx.fillText("ENTRANCE", offX+bw/2, offY+bh+OWT+22);

    // ── Room labels + dimensions (like the reference image) ──
    laid.forEach(room=>{
      const rx=offX+room.px*SCALE; const ry=offY+room.py*SCALE;
      const rw=room.pw*SCALE; const rh=room.ph*SCALE;
      const s=getStyle(room.type);
      const cx2=rx+rw/2; const cy2=ry+rh/2;
      const fz=Math.max(8,Math.min(12,rw/8));
      // Room name
      ctx.fillStyle=s.border; ctx.font=`bold ${fz}px 'Space Grotesk',sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(s.label, cx2, cy2-fz*0.7);
      // Dimensions below name (e.g. "4.50 x 3.20")
      ctx.fillStyle="#546070"; ctx.font=`${Math.max(6,fz-2)}px monospace`;
      ctx.fillText(`${room.pw.toFixed(2)} x ${room.ph.toFixed(2)}`, cx2, cy2+fz*0.5);
      // Eco orientation badge
      if(room.orientation){
        ctx.fillStyle="rgba(40,100,80,0.55)"; ctx.font=`${Math.max(5,fz-3)}px monospace`;
        ctx.fillText(room.orientation, cx2, cy2+fz*1.5);
      }
    });

    // ── Animated wind particles (if enabled) ──
    if(showWindFlow){
      const T=timeRef.current;
      if(windParticles.current.length<50){
        for(let i=0;i<2;i++){
          const spawnX=windVecLocal.x>0?offX-20:windVecLocal.x<0?offX+bw+20:offX+Math.random()*bw;
          const spawnY=windVecLocal.y>0?offY-20:windVecLocal.y<0?offY+bh+20:offY+Math.random()*bh;
          windParticles.current.push({x:spawnX,y:spawnY,life:0,speed:1.5+Math.random()*1.5,alpha:0});
        }
      }
      windParticles.current=windParticles.current.filter(p=>p.life<120);
      windParticles.current.forEach(p=>{
        p.life++; p.x+=windVecLocal.x*p.speed*1.8; p.y+=windVecLocal.y*p.speed*1.8;
        const fade=Math.sin(p.life/120*Math.PI); p.alpha=fade*0.8;
        const len=p.speed*10; const ex=p.x-windVecLocal.x*len; const ey=p.y-windVecLocal.y*len;
        ctx.save(); ctx.strokeStyle=`rgba(30,120,200,${p.alpha})`; ctx.lineWidth=1.5; ctx.lineCap="round";
        ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(p.x,p.y); ctx.stroke();
        const angle=Math.atan2(windVecLocal.y,windVecLocal.x);
        ctx.fillStyle=`rgba(60,140,220,${p.alpha})`; ctx.beginPath();
        ctx.translate(p.x,p.y); ctx.rotate(angle);
        ctx.moveTo(0,0); ctx.lineTo(-6,-3); ctx.lineTo(-6,3); ctx.closePath(); ctx.fill();
        ctx.restore();
      });
      ctx.fillStyle="rgba(30,100,180,0.7)"; ctx.font="bold 9px monospace"; ctx.textAlign="left";
      ctx.fillText(`WIND: ${windDir}`, offX+4, offY-OWT-2);
    }

    // ── North arrow ──
    const nx=W-38; const ny=H-58;
    ctx.fillStyle="#1a2530"; ctx.font="bold 10px monospace"; ctx.textAlign="center";
    ctx.fillText("N", nx, ny-22);
    ctx.beginPath(); ctx.moveTo(nx,ny-18); ctx.lineTo(nx-6,ny+4); ctx.lineTo(nx,ny+2); ctx.lineTo(nx+6,ny+4); ctx.closePath();
    ctx.fillStyle="#1a2530"; ctx.fill(); ctx.strokeStyle="#1a2530"; ctx.lineWidth=1; ctx.stroke();

    // ── Scale bar ──
    const sbPx=SCALE*5;
    ctx.fillStyle="#1a2530"; ctx.fillRect(20,H-18,sbPx,2);
    ctx.fillRect(20,H-22,2,6); ctx.fillRect(20+sbPx-2,H-22,2,6);
    ctx.font="7px monospace"; ctx.textAlign="left"; ctx.fillStyle="#546070";
    ctx.fillText("0",20,H-5); ctx.fillText("5m",20+sbPx+2,H-5);
    ctx.textAlign="right"; ctx.fillText(`${lat.toFixed(4)}°N  ${lon.toFixed(4)}°E`,W-20,H-18);

    // ── Trees ──
    trees.slice(0,3).forEach((_,i)=>{
      const tx=offX-35-i*20; const ty=offY+bh*0.25+i*24;
      ctx.beginPath(); ctx.arc(tx,ty,11,0,Math.PI*2);
      ctx.fillStyle="rgba(40,160,80,0.22)"; ctx.fill();
      ctx.strokeStyle="#28a050"; ctx.lineWidth=1.5; ctx.stroke();
      ctx.fillStyle="#28a050"; ctx.font="7px monospace"; ctx.textAlign="center";
      ctx.fillText(`T${i+1}`,tx,ty+3);
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

  const { analysis, floorPlan, selectedLat, selectedLon, setFloorPlan, setGeneratingFloorPlan } = useEco3DStore();
  const lat = selectedLat ?? 34.0522;
  const lon = selectedLon ?? -118.2437;
  const rooms = floorPlan?.layout ?? [];
  const trees = analysis?.tree_coordinates?.slice(0,4) ?? [];
  const ecoScore = floorPlan ? Math.round(floorPlan.fitness_score * 100) : (analysis ? Math.round(analysis.buildability_score) : 71);
  const solarPct = floorPlan ? Math.round(floorPlan.sunlight_score * 100) : 88;
  const ventPct = floorPlan ? Math.round(floorPlan.ventilation_score * 100) : 95;
  const treeDist = floorPlan?.tree_preserved_count ?? 0;
  const windDir = analysis?.environmental?.wind_direction ?? "SW";

  // Compute limits based on area
  const area = parseFloat(targetArea) || 240;
  const limits = useMemo(() => computeRoomLimits(area), [area]);

  const addLog = (msg: string) => {
    const n = new Date();
    const t = `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}:${String(n.getSeconds()).padStart(2,"0")}`;
    setLogs(prev => [{ time: t, msg }, ...prev].slice(0, 8));
  };

  const handleRegenerate = async () => {
    setGenerating(true);
    addLog(`Generating ${plotShape} plot floor plan for ${houseType}...`);
    if(maxSun) addLog("Solar optimization: living/bedrooms facing sun.");
    if(natVent) addLog("Wind cross-ventilation path computed.");
    try {
      const fp = await generateFloorPlan({
        plot_id: plotId,
        plot_area_sqm: area,
        num_floors: numFloors,
        preserve_trees: treePres,
        plot_shape: plotShape,
        house_type: houseType,
        room_preferences: {
          bedrooms: numBedrooms,
          bathrooms: numBathrooms,
          puja_room: hasPuja,
          garage: hasGarage,
          office: hasOffice,
          dining: hasDining,
          utility: hasUtility,
        },
        maximize_sunlight: maxSun,
        natural_ventilation: natVent,
        sustainability_priority: sustPrio,
      });
      setFloorPlan(fp); setGeneratingFloorPlan(false);
      addLog(`✓ ${fp.layout.length} rooms optimized — fitness ${(fp.fitness_score*100).toFixed(0)}%`);
      if(treePres) addLog(`Tree preservation: ${fp.tree_preserved_count} protected.`);
      if(maxSun) addLog(`Solar score: ${(fp.sunlight_score*100).toFixed(0)}% — sun-facing rooms aligned.`);
      if(natVent) addLog(`Ventilation: ${(fp.ventilation_score*100).toFixed(0)}% — cross-ventilation axis set.`);
    } catch {
      addLog("Generation failed — check backend.");
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
                    <label className="text-[11px] text-slate-400 mb-1.5 block">Plot Area (m²)</label>
                    <input type="number" value={targetArea} onChange={e => setTargetArea(e.target.value)} className="w-full glm rounded-lg px-3 py-2.5 text-[12px] text-white focus:outline-none" style={{ background: "rgba(13,242,242,0.04)" }} />
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
              <BlueprintCanvas rooms={rooms} trees={trees} lat={lat} lon={lon} zoom={zoom}
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
