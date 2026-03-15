"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEco3DStore } from "@/store/useEco3DStore";

interface Room {
  id?: string;
  type: string;
  width: number;
  height: number;
  x: number;
  y: number;
  floor: number;
  orientation: string;
}

interface Wall {
  id?: string;
  room_id: string;
  type: string;
  orientation: string;
  x: number;
  y: number;
  length: number;
  thickness: number;
  floor: number;
}

interface Door {
  id?: string;
  room_to: string;
  type: string;
  x: number;
  y: number;
  width: number;
  orientation: string;
  floor: number;
}

interface WindowEl {
  id?: string;
  wall: string;
  width: number;
  floor: number;
}

const ROOM_FILL_FP: Record<string, string> = {
  living:"rgba(13,200,200,0.10)", bedroom:"rgba(74,157,232,0.11)", kitchen:"rgba(44,180,110,0.10)",
  bathroom:"rgba(155,114,212,0.11)", office:"rgba(232,195,58,0.11)", garage:"rgba(143,160,160,0.10)",
  utility:"rgba(224,128,80,0.10)", dining:"rgba(232,122,58,0.10)", puja_room:"rgba(200,160,32,0.10)",
};
const ROOM_LABEL_FP: Record<string, string> = {
  living:"LIVING ROOM", bedroom:"BEDROOM", kitchen:"KITCHEN",
  bathroom:"BATHROOM", office:"STUDY / OFFICE", garage:"GARAGE",
  utility:"UTILITY", dining:"DINING ROOM", puja_room:"PUJA ROOM",
};
const getPalette = (type: string) => {
  const fill = getFloorFill(type);
  return { accent: fill.includes("rgba") ? "#0df2f2" : fill };
};
const getFloorFill  = (t:string) => { const k=Object.keys(ROOM_FILL_FP).find(k=>t.toLowerCase().replace("_","").includes(k.replace("_",""))); return k?ROOM_FILL_FP[k]:"#f6f6f6"; };
const getFloorLabel = (t:string) => { const k=Object.keys(ROOM_LABEL_FP).find(k=>t.toLowerCase().replace("_","").includes(k.replace("_",""))); return k?ROOM_LABEL_FP[k]:t.replace(/_/g," ").toUpperCase(); };
const isHatch = (t:string) => ["bathroom","utility","garage"].some(k=>t.toLowerCase().replace("_","").includes(k));

function FloorPlanCanvas({
  rooms, walls, doors, windows, floor,
}: {
  rooms: Room[]; walls: Wall[]; doors: Door[]; windows: WindowEl[]; floor: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const floorRooms = useMemo(() => rooms.filter(r => r.floor === floor), [rooms, floor]);
  const floorWalls = useMemo(() => walls.filter(w => w.floor === floor), [walls, floor]);
  const floorDoors = useMemo(() => doors.filter(d => d.floor === floor), [doors, floor]);
  const floorWindows = useMemo(() => windows.filter(w => w.floor === floor), [windows, floor]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || floorRooms.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    canvas.width = W; canvas.height = H;

    // White paper background
    ctx.fillStyle = "#0b1416"; ctx.fillRect(0,0,W,H);
    // Grid
    ctx.strokeStyle="rgba(13,242,242,0.055)"; ctx.lineWidth=0.4;
    for(let gx=0;gx<W;gx+=20){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H);ctx.stroke();}
    for(let gy=0;gy<H;gy+=20){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke();}
    ctx.strokeStyle="rgba(13,242,242,0.10)"; ctx.lineWidth=0.6;
    for(let gx=0;gx<W;gx+=100){ctx.beginPath();ctx.moveTo(gx,0);ctx.lineTo(gx,H);ctx.stroke();}
    for(let gy=0;gy<H;gy+=100){ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke();}

    const minX=Math.min(...floorRooms.map(r=>r.x));
    const minY=Math.min(...floorRooms.map(r=>r.y));
    const maxX=Math.max(...floorRooms.map(r=>r.x+r.width));
    const maxY=Math.max(...floorRooms.map(r=>r.y+r.height));
    const MX=90, MY=80, MX2=60, MY2=68;
    const scale=Math.min((W-MX-MX2)/Math.max(maxX-minX,0.1),(H-MY-MY2)/Math.max(maxY-minY,0.1));
    const bw=(maxX-minX)*scale; const bh=(maxY-minY)*scale;
    const offX=MX+(W-MX-MX2-bw)/2; const offY=MY+(H-MY-MY2-bh)/2;
    const px=(x:number)=>offX+(x-minX)*scale;
    const py=(y:number)=>offY+(y-minY)*scale;
    const ps=(v:number)=>v*scale;
    const WT=Math.max(7,ps(0.23));
    const IWT=Math.max(3,ps(0.12));

    // PASS 1: Room fills + hatch
    floorRooms.forEach(r=>{
      const rx=px(r.x),ry=py(r.y),rw=ps(r.width),rh=ps(r.height);
      ctx.fillStyle=getFloorFill(r.type); ctx.fillRect(rx,ry,rw,rh);
      if(isHatch(r.type)&&rw>12&&rh>12){
        ctx.save();ctx.beginPath();ctx.rect(rx,ry,rw,rh);ctx.clip();
        ctx.strokeStyle="rgba(100,80,140,0.14)"; ctx.lineWidth=0.6;
        for(let d=-(rw+rh);d<rw+rh;d+=8){ctx.beginPath();ctx.moveTo(rx+d,ry);ctx.lineTo(rx+d+rh,ry+rh);ctx.stroke();}
        ctx.restore();
      }
    });

    // PASS 2: Walls
    if(floorWalls.length>0){
      floorWalls.forEach(wall=>{
        const horiz=wall.orientation==="horizontal";
        const wLen=ps(wall.length); const wThk=Math.max(horiz?4:3.5,ps(wall.thickness));
        const ww=horiz?wLen:wThk; const wh=horiz?wThk:wLen;
        const wx=px(wall.x)-(horiz?wLen/2:wThk/2);
        const wy=py(wall.y)-(horiz?wThk/2:wLen/2);
        const ext=wall.type==="exterior";
        ctx.fillStyle=ext?"#2a3a3a":"#3d4d4d"; ctx.fillRect(wx,wy,ww,wh);
        if(ext&&ww>4&&wh>4){
          ctx.save();ctx.beginPath();ctx.rect(wx,wy,ww,wh);ctx.clip();
          ctx.strokeStyle="rgba(255,255,255,0.14)"; ctx.lineWidth=0.5;
          for(let d=-(ww+wh);d<ww+wh;d+=4){ctx.beginPath();ctx.moveTo(wx+d,wy);ctx.lineTo(wx+d+wh,wy+wh);ctx.stroke();}
          ctx.restore();
        }
        ctx.strokeStyle=ext?"#1a2828":"#2a3838"; ctx.lineWidth=ext?0.7:0.4; ctx.strokeRect(wx,wy,ww,wh);
      });
    } else {
      // Fallback perimeter
      ctx.fillStyle="#1e3232";
      ctx.fillRect(offX-WT,offY-WT,bw+WT*2,WT);
      ctx.fillRect(offX-WT,offY+bh,bw+WT*2,WT);
      ctx.fillRect(offX-WT,offY-WT,WT,bh+WT*2);
      ctx.fillRect(offX+bw,offY-WT,WT,bh+WT*2);
      // Interior walls from adjacency
      const EPS=0.09; const drawn=new Set<string>();
      floorRooms.forEach(a=>{ floorRooms.forEach(b=>{
        if(a===b) return;
        if(Math.abs((a.x+a.width)-b.x)<EPS){const ov=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);if(ov>0.25){const k=`v:${(a.x+a.width).toFixed(2)}:${Math.min(a.y,b.y).toFixed(2)}`;if(!drawn.has(k)){drawn.add(k);ctx.fillStyle="#3d4d4d";ctx.fillRect(px(a.x+a.width)-IWT/2,py(Math.max(a.y,b.y)),IWT,ps(ov));}}}
        if(Math.abs((a.y+a.height)-b.y)<EPS){const ov=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x);if(ov>0.25){const k=`h:${Math.min(a.x,b.x).toFixed(2)}:${(a.y+a.height).toFixed(2)}`;if(!drawn.has(k)){drawn.add(k);ctx.fillStyle="#3d4d4d";ctx.fillRect(px(Math.max(a.x,b.x)),py(a.y+a.height)-IWT/2,ps(ov),IWT);}}}
      });});
    }

    // PASS 3: Doors
    floorDoors.forEach(door=>{
      const span=ps(door.width); const wallT=Math.max(4,ps(0.15));
      ctx.strokeStyle="#1a3030"; ctx.lineWidth=1.2;
      if(door.orientation==="horizontal"){
        const dx=px(door.x)-span/2,dy=py(door.y)-wallT/2;
        ctx.fillStyle="#0b1416"; ctx.fillRect(dx-1,dy-2,span+2,wallT+4);
        ctx.strokeStyle="rgba(13,242,242,0.85)"; ctx.lineWidth=1.3;
        ctx.beginPath();ctx.moveTo(dx,dy+wallT/2);ctx.lineTo(dx+span,dy+wallT/2);ctx.stroke();
        ctx.strokeStyle="rgba(13,242,242,0.4)"; ctx.lineWidth=0.8; ctx.setLineDash([3,3]);
        ctx.beginPath();ctx.arc(dx,dy+wallT/2,span,0,Math.PI/2);ctx.stroke();ctx.setLineDash([]);
      } else {
        const dy=py(door.y)-span/2,dx=px(door.x)-wallT/2;
        ctx.fillStyle="#0b1416"; ctx.fillRect(dx-2,dy-1,wallT+4,span+2);
        ctx.strokeStyle="rgba(13,242,242,0.85)"; ctx.lineWidth=1.3;
        ctx.beginPath();ctx.moveTo(dx+wallT/2,dy);ctx.lineTo(dx+wallT/2,dy+span);ctx.stroke();
        ctx.strokeStyle="rgba(13,242,242,0.4)"; ctx.lineWidth=0.8; ctx.setLineDash([3,3]);
        ctx.beginPath();ctx.arc(dx+wallT/2,dy,span,Math.PI/2,Math.PI);ctx.stroke();ctx.setLineDash([]);
      }
    });

    // PASS 4: Windows (CAD style)
    const drawWin=(wx:number,wy:number,ww:number,wh:number,horiz:boolean)=>{
      ctx.fillStyle="#0b1416"; ctx.fillRect(wx-1,wy-1,ww+2,wh+2);
      ctx.fillStyle="rgba(100,200,255,0.22)"; ctx.fillRect(wx,wy,ww,wh);
      ctx.strokeStyle="rgba(130,210,255,0.85)"; ctx.lineWidth=0.9; ctx.strokeRect(wx,wy,ww,wh);
      ctx.strokeStyle="rgba(130,210,255,0.5)"; ctx.lineWidth=0.5;
      if(horiz){ctx.beginPath();ctx.moveTo(wx,wy+wh/2);ctx.lineTo(wx+ww,wy+wh/2);ctx.stroke();ctx.beginPath();ctx.moveTo(wx+ww/2,wy);ctx.lineTo(wx+ww/2,wy+wh);ctx.stroke();}
      else{ctx.beginPath();ctx.moveTo(wx+ww/2,wy);ctx.lineTo(wx+ww/2,wy+wh);ctx.stroke();ctx.beginPath();ctx.moveTo(wx,wy+wh/2);ctx.lineTo(wx+ww,wy+wh/2);ctx.stroke();}
      ctx.strokeStyle="rgba(130,210,255,0.75)"; ctx.lineWidth=1.1;
      if(horiz){ctx.beginPath();ctx.moveTo(wx,wy-2);ctx.lineTo(wx,wy+wh+2);ctx.stroke();ctx.beginPath();ctx.moveTo(wx+ww,wy-2);ctx.lineTo(wx+ww,wy+wh+2);ctx.stroke();}
      else{ctx.beginPath();ctx.moveTo(wx-2,wy);ctx.lineTo(wx+ww+2,wy);ctx.stroke();ctx.beginPath();ctx.moveTo(wx-2,wy+wh);ctx.lineTo(wx+ww+2,wy+wh);ctx.stroke();}
    };
    floorWindows.forEach(win=>{
      const parts=win.wall.split("_"); const edge=parts[parts.length-1].replace("vent","").trim();
      const roomId=parts.slice(0,-1).join("_");
      const room=floorRooms.find(r=>r.id===roomId); if(!room) return;
      const span=ps(win.width); if(span<6) return;
      if(edge==="top")    drawWin(px(room.x+room.width/2)-span/2,py(room.y)-WT/2,span,WT,true);
      if(edge==="bottom") drawWin(px(room.x+room.width/2)-span/2,py(room.y+room.height)-WT/2,span,WT,true);
      if(edge==="left")   drawWin(px(room.x)-WT/2,py(room.y+room.height/2)-span/2,WT,span,false);
      if(edge==="right")  drawWin(px(room.x+room.width)-WT/2,py(room.y+room.height/2)-span/2,WT,span,false);
    });

    // PASS 5: Labels + dimensions
    floorRooms.forEach(r=>{
      const rx=px(r.x),ry=py(r.y),rw=ps(r.width),rh=ps(r.height);
      const cx=rx+rw/2,cy=ry+rh/2;
      if(rw<20||rh<14) return;
      const fs=Math.max(7,Math.min(11,rw/7.5));
      ctx.fillStyle="#0df2f2"; ctx.font=`bold ${fs}px 'Space Grotesk',sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(getFloorLabel(r.type),cx,cy-fs*0.9);
      ctx.fillStyle="rgba(180,200,220,0.82)"; ctx.font=`${Math.max(6,fs-1.5)}px monospace`;
      ctx.fillText(`${(r.width*r.height).toFixed(1)} m²`,cx,cy+fs*0.1);
      ctx.fillStyle="rgba(130,160,180,0.75)"; ctx.font=`${Math.max(5.5,fs-2)}px monospace`;
      ctx.fillText(`${r.width.toFixed(2)} × ${r.height.toFixed(2)} m`,cx,cy+fs*0.95);
    });

    // PASS 6: Dimension lines
    const DL=18; const DE=5;
    const drawDim=(x1:number,y1:number,x2:number,y2:number,lbl:string,off:number,horiz:boolean)=>{
      ctx.strokeStyle="rgba(13,242,242,0.55)"; ctx.lineWidth=0.6;
      if(horiz){
        ctx.beginPath();ctx.moveTo(x1,y1-DE);ctx.lineTo(x1,y1+off+DE);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x2,y1-DE);ctx.lineTo(x2,y1+off+DE);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x1,y1+off);ctx.lineTo(x2,y1+off);ctx.stroke();
        ctx.fillStyle="rgba(13,242,242,0.65)";
        ctx.beginPath();ctx.moveTo(x1,y1+off);ctx.lineTo(x1+5,y1+off-2.5);ctx.lineTo(x1+5,y1+off+2.5);ctx.closePath();ctx.fill();
        ctx.beginPath();ctx.moveTo(x2,y1+off);ctx.lineTo(x2-5,y1+off-2.5);ctx.lineTo(x2-5,y1+off+2.5);ctx.closePath();ctx.fill();
        ctx.fillStyle="rgba(13,242,242,0.65)"; ctx.font="bold 8px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
        ctx.fillText(lbl,(x1+x2)/2,y1+off-1);
      } else {
        ctx.beginPath();ctx.moveTo(x1-DE,y1);ctx.lineTo(x1+off+DE,y1);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x1-DE,y2);ctx.lineTo(x1+off+DE,y2);ctx.stroke();
        ctx.beginPath();ctx.moveTo(x1+off,y1);ctx.lineTo(x1+off,y2);ctx.stroke();
        ctx.fillStyle="rgba(13,242,242,0.65)";
        ctx.beginPath();ctx.moveTo(x1+off,y1);ctx.lineTo(x1+off-2.5,y1+5);ctx.lineTo(x1+off+2.5,y1+5);ctx.closePath();ctx.fill();
        ctx.beginPath();ctx.moveTo(x1+off,y2);ctx.lineTo(x1+off-2.5,y2-5);ctx.lineTo(x1+off+2.5,y2-5);ctx.closePath();ctx.fill();
        ctx.save();ctx.translate(x1+off+12,(y1+y2)/2);ctx.rotate(-Math.PI/2);
        ctx.fillStyle="rgba(13,242,242,0.65)"; ctx.font="bold 8px monospace"; ctx.textAlign="center"; ctx.textBaseline="bottom";
        ctx.fillText(lbl,0,0); ctx.restore();
      }
    };
    drawDim(offX,offY,offX+bw,offY,`${(maxX-minX).toFixed(2)} m`,-DL,true);
    drawDim(offX,offY,offX,offY+bh,`${(maxY-minY).toFixed(2)} m`,-DL,false);

    // PASS 7: Title block
    const TB=38; const TBY=H-TB;
    ctx.fillStyle="rgba(8,14,14,0.96)"; ctx.fillRect(0,TBY,W,TB);
    ctx.strokeStyle="rgba(13,242,242,0.25)"; ctx.lineWidth=0.8;
    ctx.beginPath();ctx.moveTo(0,TBY);ctx.lineTo(W,TBY);ctx.stroke();
    const cols2=[W*0.25,W*0.5,W*0.75];
    cols2.forEach(cx2=>{ctx.strokeStyle="rgba(13,242,242,0.12)";ctx.beginPath();ctx.moveTo(cx2,TBY);ctx.lineTo(cx2,H);ctx.stroke();});
    const today=new Date();
    const dd=`${today.getDate().toString().padStart(2,"0")}/${(today.getMonth()+1).toString().padStart(2,"0")}/${today.getFullYear()}`;
    [{l:"FLOOR",v:`FLOOR ${floor}`},{l:"ROOMS",v:`${floorRooms.length} rooms`},{l:"AREA",v:`${floorRooms.reduce((s,r)=>s+r.width*r.height,0).toFixed(0)} m²`},{l:"DATE",v:dd}].forEach((it,i)=>{
      const tx=i===0?10:cols2[i-1]+8;
      ctx.fillStyle="rgba(13,242,242,0.4)"; ctx.font="bold 7px monospace"; ctx.textAlign="left"; ctx.textBaseline="top";
      ctx.fillText(it.l,tx,TBY+5);
      ctx.fillStyle="rgba(255,255,255,0.85)"; ctx.font="bold 9.5px 'Space Grotesk',monospace";
      ctx.fillText(it.v,tx,TBY+16);
    });

    // PASS 8: North arrow
    const NAX=W-48, NAY=offY-14;
    ctx.fillStyle="rgba(8,20,22,0.92)"; ctx.strokeStyle="rgba(13,242,242,0.55)"; ctx.lineWidth=0.7;
    ctx.beginPath();ctx.arc(NAX,NAY,16,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.fillStyle="rgba(13,242,242,0.9)";
    ctx.beginPath();ctx.moveTo(NAX,NAY-12);ctx.lineTo(NAX-4,NAY+2);ctx.lineTo(NAX,NAY+4);ctx.lineTo(NAX+4,NAY+2);ctx.closePath();ctx.fill();
    ctx.fillStyle="#0df2f2"; ctx.font="bold 8px monospace"; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("N",NAX,NAY-5);

    // PASS 9: Scale bar
    const sbM=5; const sbPx2=scale*sbM; const sbX2=offX; const sbY2=H-TB-12;
    ctx.fillStyle="rgba(13,242,242,0.7)"; ctx.fillRect(sbX2,sbY2,sbPx2,2.5);
    ctx.fillRect(sbX2,sbY2-3,1.5,7.5); ctx.fillRect(sbX2+sbPx2-1.5,sbY2-3,1.5,7.5);
    ctx.font="7.5px monospace"; ctx.textAlign="left"; ctx.fillStyle="rgba(13,242,242,0.55)";
    ctx.fillText("0",sbX2,sbY2-4); ctx.fillText(`${sbM}m`,sbX2+sbPx2+3,sbY2-4);
  }, [floorRooms, floorWalls, floorDoors, floorWindows, floor]);

  useEffect(()=>{
    redraw();
    const ro=new ResizeObserver(redraw);
    if(containerRef.current) ro.observe(containerRef.current);
    return ()=>ro.disconnect();
  }, [redraw]);

  if (floorRooms.length === 0) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center" style={{background:"#ffffff"}}>
        <p style={{color:"rgba(13,242,242,0.5)",fontSize:14}}>No rooms on floor {floor}</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full" style={{background:"#0b1416"}}>
      <canvas ref={canvasRef} style={{ width:"100%", height:"100%", display:"block" }} />
    </div>
  );
}

function ScoreCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-2 rounded-lg" style={{background:"rgba(13,242,242,0.04)",border:"1px solid rgba(13,242,242,0.08)"}}>
      <span className="material-symbols-outlined text-primary text-base">{icon}</span>
      <span className="text-[9px] text-slate-400 uppercase tracking-widest">{label}</span>
      <span className="text-[13px] font-bold text-white">{value}</span>
    </div>
  );
}


export default function FloorPlanPage() {
  const params = useParams();
  const plotId = params.id as string;
  const { floorPlan, floorPlanVariants, activeVariantIndex, setActiveVariantIndex } = useEco3DStore();
  const [activeFloor, setActiveFloor] = useState(1);

  const activeVariant = floorPlanVariants[activeVariantIndex] ?? null;
  const rooms = activeVariant?.layout ?? floorPlan?.layout ?? [];
  const walls = activeVariant?.walls ?? floorPlan?.walls ?? [];
  const doors = activeVariant?.doors ?? floorPlan?.doors ?? [];
  const windows = activeVariant?.windows ?? floorPlan?.windows ?? [];
  const totalArea = activeVariant?.total_area ?? floorPlan?.total_area ?? 0;

  const floors = useMemo(
    () => rooms.length > 0 ? Array.from(new Set(rooms.map(room => room.floor))).sort() : [1],
    [rooms]
  );

  useEffect(() => {
    setActiveFloor(floors[0] ?? 1);
  }, [floors]);

  return (
    <div className="min-h-screen w-full" style={{ background: "#080e0e", fontFamily: "'Space Grotesk',sans-serif" }}>
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
        <div className="mb-8">
          <h1 className="text-4xl font-black text-white uppercase tracking-tight mb-1">Floor Plan</h1>
          <p className="text-slate-500 text-sm font-mono">{plotId} · {rooms.length} rooms · {totalArea.toFixed(0)} m²</p>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-8">
          <ScoreCard icon="star" label="Eco Score" value={activeVariant ? `${Math.round(activeVariant.eco_score * 100)}%` : floorPlan ? `${Math.round(floorPlan.eco_score * 100)}%` : "—"} />
          <ScoreCard icon="wb_sunny" label="Sunlight" value={activeVariant ? `${Math.round(activeVariant.solar_score * 100)}%` : floorPlan ? `${Math.round(floorPlan.sunlight_score * 100)}%` : "—"} />
          <ScoreCard icon="air" label="Ventilation" value={activeVariant ? `${Math.round(activeVariant.ventilation_score * 100)}%` : floorPlan ? `${Math.round(floorPlan.ventilation_score * 100)}%` : "—"} />
          <ScoreCard icon="forest" label="Trees Saved" value={floorPlan ? String(floorPlan.tree_preserved_count) : "—"} />
        </div>

        {floorPlanVariants.length > 0 && (
          <div className="flex items-center gap-3 mb-5">
            <button onClick={() => setActiveVariantIndex(Math.max(0, activeVariantIndex - 1))} disabled={activeVariantIndex === 0} className="w-9 h-9 rounded-lg border border-primary/20 text-primary disabled:text-slate-700 disabled:border-white/10">
              <span className="material-symbols-outlined text-[18px]">chevron_left</span>
            </button>
            <div className="flex-1 overflow-x-auto flex gap-2">
              {floorPlanVariants.map((variant, i) => (
                <button
                  key={variant.id}
                  onClick={() => setActiveVariantIndex(i)}
                  className="px-4 py-2 rounded-xl text-left min-w-[150px]"
                  style={{
                    background: i === activeVariantIndex ? "rgba(13,242,242,0.12)" : "rgba(13,242,242,0.04)",
                    border: `1px solid ${i === activeVariantIndex ? "#0df2f2" : "rgba(255,255,255,0.08)"}`,
                  }}
                >
                  <div className="text-[10px] uppercase tracking-widest font-bold" style={{ color: i === activeVariantIndex ? "#0df2f2" : "#64748b" }}>{variant.style}</div>
                  <div className="text-[11px] font-mono mt-1" style={{ color: i === activeVariantIndex ? "#d8ffff" : "#94a3b8" }}>
                    Eco {Math.round(variant.eco_score * 100)}% · {variant.total_area.toFixed(0)}m²
                  </div>
                </button>
              ))}
            </div>
            <button onClick={() => setActiveVariantIndex(Math.min(floorPlanVariants.length - 1, activeVariantIndex + 1))} disabled={activeVariantIndex === floorPlanVariants.length - 1} className="w-9 h-9 rounded-lg border border-primary/20 text-primary disabled:text-slate-700 disabled:border-white/10">
              <span className="material-symbols-outlined text-[18px]">chevron_right</span>
            </button>
          </div>
        )}

        <div className="flex items-center gap-6 mb-4 px-1">
          {[
            { label: "Exterior Wall", color: "#0df2f2", solid: true },
            { label: "Interior Wall", color: "rgba(13,242,242,0.35)", solid: true },
            { label: "Door", color: "#0df2f2", solid: false },
            { label: "Window", color: "rgba(160,240,240,0.9)", solid: false },
          ].map(({ label, color, solid }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="inline-block w-5 h-3 rounded-sm" style={{ background: solid ? color : "transparent", border: `1.5px solid ${color}` }} />
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
            </div>
          ))}
        </div>

        <div className="rounded-2xl overflow-hidden mb-6" style={{ background: "rgba(10,26,26,0.6)", border: "1px solid rgba(13,242,242,0.08)" }}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
            {floors.map(floor => (
              <button
                key={floor}
                onClick={() => setActiveFloor(floor)}
                className="px-5 py-1.5 rounded font-bold text-[12px] uppercase tracking-widest transition-all"
                style={{
                  background: activeFloor === floor ? "#0df2f2" : "transparent",
                  color: activeFloor === floor ? "#080e0e" : "#64748b",
                  border: `1px solid ${activeFloor === floor ? "#0df2f2" : "rgba(255,255,255,0.08)"}`,
                }}
              >
                Floor {floor}
              </button>
            ))}
            <div className="ml-auto text-[10px] font-mono text-slate-600">{rooms.filter(room => room.floor === activeFloor).length} rooms on this floor</div>
          </div>
          <div style={{ height: "540px", background: "#0b1515" }}>
            {rooms.length > 0 ? (
              <FloorPlanCanvas rooms={rooms} walls={walls as Wall[]} doors={doors as Door[]} windows={windows as WindowEl[]} floor={activeFloor} />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                <span className="material-symbols-outlined text-primary/30 text-5xl">architecture</span>
                <p className="text-slate-500 text-sm">Select a plot on the map to generate a floor plan</p>
                <Link href="/map" className="text-[11px] text-primary underline">Go to Map →</Link>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(10,26,26,0.6)", border: "1px solid rgba(13,242,242,0.08)" }}>
          <div className="px-6 py-4 border-b border-white/5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-primary">Room Schedule</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  {["Type", "Floor", "Width", "Height", "Area", "Orientation"].map(header => (
                    <th key={header} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-slate-500">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rooms.map((room, i) => {
                  const accent = getPalette(room.type).accent;
                  return (
                    <tr key={`${room.id ?? room.type}-${i}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
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
  );
}
