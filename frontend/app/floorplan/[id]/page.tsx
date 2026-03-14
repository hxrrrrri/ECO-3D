"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

const PALETTE: Record<string, { fill: string; accent: string; hatch?: boolean }> = {
  living: { fill: "rgba(13,200,200,0.07)", accent: "#0bc8c8" },
  bedroom: { fill: "rgba(52,130,210,0.07)", accent: "#3482d2" },
  kitchen: { fill: "rgba(46,180,100,0.07)", accent: "#2eb464" },
  bathroom: { fill: "rgba(140,80,170,0.07)", accent: "#8c50aa", hatch: true },
  office: { fill: "rgba(220,170,10,0.07)", accent: "#dcaa0a" },
  garage: { fill: "rgba(110,125,125,0.07)", accent: "#6e7d7d" },
  utility: { fill: "rgba(210,110,20,0.07)", accent: "#d26e14", hatch: true },
  dining: { fill: "rgba(220,90,90,0.07)", accent: "#df7070" },
  puja_room: { fill: "rgba(205,185,80,0.07)", accent: "#d4bf5e" },
};

const getPalette = (type: string) => {
  const key = Object.keys(PALETTE).find(k => type.toLowerCase().includes(k));
  return key ? PALETTE[key] : { fill: "rgba(80,80,100,0.06)", accent: "#505064" };
};

function FloorPlanCanvas({
  rooms,
  walls,
  doors,
  windows,
  floor,
}: {
  rooms: Room[];
  walls: Wall[];
  doors: Door[];
  windows: WindowEl[];
  floor: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const floorRooms = useMemo(() => rooms.filter(r => r.floor === floor), [rooms, floor]);
  const floorWalls = useMemo(() => walls.filter(w => w.floor === floor), [walls, floor]);
  const floorDoors = useMemo(() => doors.filter(d => d.floor === floor), [doors, floor]);
  const floorWindows = useMemo(() => windows.filter(w => w.floor === floor), [windows, floor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || floorRooms.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const redraw = () => {
      const W = container.clientWidth;
      const H = container.clientHeight;
      canvas.width = W;
      canvas.height = H;

      ctx.fillStyle = "#0b1515";
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(13,242,242,0.025)";
      ctx.lineWidth = 0.5;
      for (let x = 0; x < W; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      const minX = Math.min(...floorRooms.map(r => r.x));
      const minY = Math.min(...floorRooms.map(r => r.y));
      const maxX = Math.max(...floorRooms.map(r => r.x + r.width));
      const maxY = Math.max(...floorRooms.map(r => r.y + r.height));
      const scale = Math.min((W * 0.80) / Math.max(maxX - minX, 1), (H * 0.76) / Math.max(maxY - minY, 1));
      const offX = (W - (maxX - minX) * scale) / 2 - minX * scale;
      const offY = (H - (maxY - minY) * scale) / 2 - minY * scale;
      const px = (x: number) => offX + x * scale;
      const py = (y: number) => offY + y * scale;
      const ps = (s: number) => s * scale;
      const WT = Math.max(6, ps(0.24));

      floorRooms.forEach(room => {
        const p = getPalette(room.type);
        const rx = px(room.x) + WT / 2;
        const ry = py(room.y) + WT / 2;
        const rw = ps(room.width) - WT;
        const rh = ps(room.height) - WT;
        ctx.fillStyle = p.fill;
        ctx.fillRect(rx, ry, rw, rh);
        if (p.hatch) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          ctx.clip();
          ctx.strokeStyle = p.accent + "28";
          for (let d = -(rw + rh); d < rw + rh; d += 11) {
            ctx.beginPath();
            ctx.moveTo(rx + d, ry);
            ctx.lineTo(rx + d + rh, ry + rh);
            ctx.stroke();
          }
          ctx.restore();
        }
      });

      floorWalls.forEach(wall => {
        const horiz = wall.orientation === "horizontal";
        const ww = horiz ? ps(wall.length) : Math.max(3, ps(wall.thickness));
        const wh = horiz ? Math.max(3, ps(wall.thickness)) : ps(wall.length);
        const wx = px(wall.x) - ww / 2;
        const wy = py(wall.y) - wh / 2;
        const exterior = wall.type === "exterior";
        ctx.fillStyle = exterior ? "#1e3838" : "#162e2e";
        ctx.fillRect(wx, wy, ww, wh);
        if (exterior) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(wx, wy, ww, wh);
          ctx.clip();
          ctx.strokeStyle = "rgba(13,242,242,0.18)";
          for (let d = -(ww + wh); d < ww + wh; d += 5) {
            ctx.beginPath();
            ctx.moveTo(wx + d, wy);
            ctx.lineTo(wx + d + wh, wy + wh);
            ctx.stroke();
          }
          ctx.restore();
        }
        ctx.strokeStyle = exterior ? "rgba(13,242,242,0.7)" : "rgba(13,242,242,0.28)";
        ctx.lineWidth = exterior ? 1.2 : 0.7;
        ctx.strokeRect(wx, wy, ww, wh);
      });

      const drawDoor = (door: Door) => {
        const sw = ps(door.width);
        ctx.strokeStyle = "rgba(13,242,242,0.85)";
        ctx.lineWidth = 1;
        if (door.orientation === "horizontal") {
          const dx = px(door.x) - sw / 2;
          const dy = py(door.y) - WT / 2;
          ctx.fillStyle = "#0b1515";
          ctx.fillRect(dx, dy - 1, sw, WT + 2);
          ctx.beginPath(); ctx.moveTo(dx, dy + WT / 2); ctx.lineTo(dx + sw, dy + WT / 2); ctx.stroke();
          ctx.beginPath(); ctx.arc(dx, dy + WT / 2, sw, -Math.PI / 2, 0); ctx.stroke();
        } else {
          const dy = py(door.y) - sw / 2;
          const dx = px(door.x) - WT / 2;
          ctx.fillStyle = "#0b1515";
          ctx.fillRect(dx - 1, dy, WT + 2, sw);
          ctx.beginPath(); ctx.moveTo(dx + WT / 2, dy); ctx.lineTo(dx + WT / 2, dy + sw); ctx.stroke();
          ctx.beginPath(); ctx.arc(dx + WT / 2, dy, sw, Math.PI, 3 * Math.PI / 2); ctx.stroke();
        }
      };
      floorDoors.forEach(drawDoor);

      const drawWindow = (x: number, y: number, w: number, h: number, horiz: boolean) => {
        ctx.fillStyle = "rgba(13,242,242,0.10)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(160,240,240,0.9)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, w, h);
        for (let i = 1; i < 3; i++) {
          ctx.beginPath();
          if (horiz) {
            const xx = x + (w * i) / 3;
            ctx.moveTo(xx, y); ctx.lineTo(xx, y + h);
          } else {
            const yy = y + (h * i) / 3;
            ctx.moveTo(x, yy); ctx.lineTo(x + w, yy);
          }
          ctx.stroke();
        }
      };

      floorWindows.forEach(win => {
        const parts = win.wall.split("_");
        const edge = parts[parts.length - 1];
        const roomId = parts.slice(0, -1).join("_");
        const room = floorRooms.find(r => r.id === roomId);
        if (!room) return;
        const ww = ps(win.width);
        if (edge === "top") drawWindow(px(room.x + room.width / 2) - ww / 2, py(room.y), ww, WT, true);
        if (edge === "bottom") drawWindow(px(room.x + room.width / 2) - ww / 2, py(room.y + room.height) - WT, ww, WT, true);
        if (edge === "left") drawWindow(px(room.x), py(room.y + room.height / 2) - ww / 2, WT, ww, false);
        if (edge === "right") drawWindow(px(room.x + room.width) - WT, py(room.y + room.height / 2) - ww / 2, WT, ww, false);
      });

      floorRooms.forEach(room => {
        const rx = px(room.x);
        const ry = py(room.y);
        const rw = ps(room.width);
        const rh = ps(room.height);
        const cx = rx + rw / 2;
        const cy = ry + rh / 2;
        const fs = Math.max(8, Math.min(13, (rw - WT * 2) * 0.11));
        ctx.fillStyle = getPalette(room.type).accent;
        ctx.font = `700 ${fs}px 'Space Grotesk', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(room.type.replace(/_/g, " ").toUpperCase(), cx, cy - fs * 0.65);
        ctx.fillStyle = "rgba(255,255,255,0.32)";
        ctx.font = `${Math.max(7, fs - 2)}px monospace`;
        ctx.fillText(`${(room.width * room.height).toFixed(1)} m²`, cx, cy + fs * 0.65);
      });

      ctx.setLineDash([2, 3]);
      floorRooms.forEach(room => {
        const rx = px(room.x), ry = py(room.y), rw = ps(room.width), rh = ps(room.height);
        if (rw > 55) {
          const yd = ry - 16;
          ctx.strokeStyle = "rgba(13,242,242,0.38)";
          ctx.beginPath();
          ctx.moveTo(rx, ry); ctx.lineTo(rx, yd);
          ctx.moveTo(rx + rw, ry); ctx.lineTo(rx + rw, yd);
          ctx.moveTo(rx, yd); ctx.lineTo(rx + rw, yd);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(180,240,240,0.55)";
          ctx.font = "8px monospace";
          ctx.fillText(`${room.width.toFixed(1)}m`, rx + rw / 2, yd - 2);
          ctx.setLineDash([2, 3]);
        }
        if (rh > 55) {
          const xd = rx + rw + 16;
          ctx.strokeStyle = "rgba(13,242,242,0.38)";
          ctx.beginPath();
          ctx.moveTo(rx + rw, ry); ctx.lineTo(xd, ry);
          ctx.moveTo(rx + rw, ry + rh); ctx.lineTo(xd, ry + rh);
          ctx.moveTo(xd, ry); ctx.lineTo(xd, ry + rh);
          ctx.stroke();
        }
      });
      ctx.setLineDash([]);

      const today = new Date();
      const dateStr = `${today.getDate().toString().padStart(2, "0")}/${(today.getMonth() + 1).toString().padStart(2, "0")}/${today.getFullYear()}`;
      const totalFloorArea = floorRooms.reduce((sum, room) => sum + room.width * room.height, 0);
      const TB_H = 42;
      const TB_Y = H - TB_H;
      ctx.fillStyle = "rgba(8,16,16,0.92)";
      ctx.fillRect(0, TB_Y, W, TB_H);
      ctx.strokeStyle = "rgba(13,242,242,0.35)";
      ctx.beginPath(); ctx.moveTo(0, TB_Y); ctx.lineTo(W, TB_Y); ctx.stroke();
      [W * 0.25, W * 0.50, W * 0.75].forEach(v => {
        ctx.beginPath(); ctx.moveTo(v, TB_Y); ctx.lineTo(v, H); ctx.stroke();
      });
      [
        { label: "PROJECT", value: "ECO-3D STUDIO" },
        { label: "FLOOR", value: `FLOOR ${floor} — ${floorRooms.length} ROOMS` },
        { label: "AREA", value: `${totalFloorArea.toFixed(1)} m²` },
        { label: "DATE", value: dateStr },
      ].forEach((item, i) => {
        const x = i === 0 ? 14 : (W * i) / 4 + 10;
        ctx.fillStyle = "rgba(13,242,242,0.45)";
        ctx.font = "bold 7px monospace";
        ctx.textAlign = "left";
        ctx.fillText(item.label, x, TB_Y + 12);
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.font = "bold 10px 'Space Grotesk', monospace";
        ctx.fillText(item.value, x, TB_Y + 26);
      });
    };

    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [floorRooms, floorWalls, floorDoors, floorWindows, floor]);

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
