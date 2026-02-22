"use client";

import { useRef, useMemo, Suspense, useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Environment, Text, Grid, useHelper } from "@react-three/drei";
import * as THREE from "three";
import { useEco3DStore } from "@/store/useEco3DStore";

// ─── Room color palette ───────────────────────────────────────────────────────
const ROOM_COLORS: Record<string, string> = {
  living: "#0df2f2", kitchen: "#2ecc71", bedroom: "#3498db",
  bathroom: "#9b59b6", office: "#f1c40f", garage: "#7f8c8d",
};

const getRoomColor = (type: string) => {
  const key = Object.keys(ROOM_COLORS).find(k => type.toLowerCase().includes(k));
  return key ? ROOM_COLORS[key] : "#0df2f2";
};

// ─── Building geometry ────────────────────────────────────────────────────────
function Building({ rooms, walls, doors }: { rooms: any[], walls?: any[], doors?: any[] }) {
  const groupRef = useRef<THREE.Group>(null);
  const floorH = 3.2;

  // Render explicitly generated walls/doors if available (CAD mode)
  if (walls && walls.length > 0) {
    return (
      <group ref={groupRef}>
        {/* 1. Floor Slabs & Labels */}
        {rooms.map((room, idx) => {
          const color = getRoomColor(room.type);
          const x = room.x + room.width / 2 - 8;
          const z = room.y + room.height / 2 - 8;
          const y = (room.floor - 1) * floorH;

          return (
            <group key={`floor-${idx}`}>
              <mesh position={[x, y, z]} receiveShadow>
                <boxGeometry args={[room.width - 0.1, 0.1, room.height - 0.1]} />
                <meshStandardMaterial color={color} transparent opacity={0.4} roughness={0.8} />
              </mesh>
              <Text position={[x, y + 0.06, z]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.35}
                color="#ffffff" anchorX="center" anchorY="middle" fillOpacity={0.6} font="https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZJhjp-Ek-_EeA.woff">
                {room.type.replace(/_/g, " ").toUpperCase()}
              </Text>
            </group>
          );
        })}

        {/* 2. Walls */}
        {walls.map((wall, idx) => {
          const w = wall.orientation === "horizontal" ? wall.length : wall.thickness;
          const d = wall.orientation === "horizontal" ? wall.thickness : wall.length;
          const h = floorH * 0.95;
          const px = wall.x - 8;
          const pz = wall.y - 8;
          const py = h / 2;
          const isExterior = wall.type === "exterior";

          return (
            <mesh key={`wall-${idx}`} position={[px, py, pz]} castShadow receiveShadow>
              <boxGeometry args={[w, h, d]} />
              <meshStandardMaterial color={isExterior ? "#e2e8f0" : "#cbd5e1"} roughness={0.85} />
            </mesh>
          );
        })}

        {/* 3. Doors */}
        {doors && doors.map((door, idx) => {
          const isHoriz = door.orientation === "horizontal";
          const w = isHoriz ? door.width : 0.28;
          const d = isHoriz ? 0.28 : door.width;
          const h = 2.1;
          const px = door.x - 8;
          const pz = door.y - 8;
          const py = h / 2;
          const color = door.type === "entry" ? "#e74c3c" : "#34495e";

          return (
            <mesh key={`door-${idx}`} position={[px, py, pz]} castShadow>
              <boxGeometry args={[w, h, d]} />
              <meshStandardMaterial color={color} roughness={0.4} metalness={0.1} transparent opacity={0.8} />
            </mesh>
          );
        })}

        {/* 4. Roof / Glass Top Cap */}
        {rooms.map((room, idx) => {
          const color = getRoomColor(room.type);
          const x = room.x + room.width / 2 - 8;
          const z = room.y + room.height / 2 - 8;
          const y = (room.floor - 1) * floorH + floorH * 0.95;
          return (
            <mesh key={`roof-${idx}`} position={[x, y, z]}>
              <boxGeometry args={[room.width, 0.05, room.height]} />
              <meshStandardMaterial color={color} transparent opacity={0.15} roughness={0.1} metalness={0.5} />
            </mesh>
          );
        })}

        {/* Ground */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
          <planeGeometry args={[40, 40]} />
          <meshStandardMaterial color="#061414" roughness={0.95} />
        </mesh>
      </group>
    );
  }

  // Fallback: volumetric blocks
  return (
    <group ref={groupRef}>
      {rooms.map((room, idx) => {
        const color = getRoomColor(room.type);
        const x = room.x + room.width / 2 - 8;
        const z = room.y + room.height / 2 - 8;
        const y = (room.floor - 1) * floorH + floorH / 2;
        const w = room.width;
        const h = room.height;

        return (
          <group key={idx}>
            <mesh position={[x, y, z]} castShadow receiveShadow>
              <boxGeometry args={[w, floorH * 0.94, h]} />
              <meshStandardMaterial color={color} transparent opacity={0.72}
                roughness={0.25} metalness={0.15} emissive={color} emissiveIntensity={0.06} />
            </mesh>
            <mesh position={[x, y + floorH * 0.47, z]}>
              <boxGeometry args={[w, 0.05, h]} />
              <meshStandardMaterial color={color} transparent opacity={0.3} roughness={0} metalness={0.8} />
            </mesh>
            <Text position={[x, y + floorH * 0.5 + 0.25, z]} fontSize={0.28}
              color={color} anchorX="center" anchorY="bottom" outlineWidth={0.02} outlineColor="#000">
              {room.type.replace(/_/g, " ").toUpperCase()}
            </Text>
            <mesh position={[x, (room.floor - 1) * floorH, z]} receiveShadow>
              <boxGeometry args={[w + 0.05, 0.08, h + 0.05]} />
              <meshStandardMaterial color="#0a2020" roughness={0.9} />
            </mesh>
          </group>
        );
      })}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#061414" roughness={0.95} />
      </mesh>
    </group>
  );
}

// ─── Default placeholder building ─────────────────────────────────────────────
function DefaultBuilding() {
  const configs: [number, number, number, number, number][] = [
    [-3, 0, -3, 2.8, 5], [0, 0, -3, 2.8, 6.5], [3, 0, -3, 2.8, 4.2],
    [-1.5, 0, 0, 2.8, 5.8], [1.5, 0, 0, 2.8, 4.8],
  ];
  return (
    <group>
      {configs.map(([x, , z, w, h], i) => (
        <group key={i}>
          <mesh position={[x, h / 2, z]} castShadow>
            <boxGeometry args={[w, h, w]} />
            <meshStandardMaterial color="#0df2f2" transparent opacity={0.5} roughness={0.3} emissive="#0df2f2" emissiveIntensity={0.05} />
          </mesh>
          <mesh position={[x, h + 0.05, z]}>
            <boxGeometry args={[w + 0.1, 0.1, w + 0.1]} />
            <meshStandardMaterial color="#0df2f2" transparent opacity={0.3} />
          </mesh>
        </group>
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[24, 24]} />
        <meshStandardMaterial color="#061414" roughness={0.9} />
      </mesh>
    </group>
  );
}

// ─── Sunlight ─────────────────────────────────────────────────────────────────
function SunLight({ direction }: { direction: string }) {
  const posMap: Record<string, [number, number, number]> = {
    N: [0, 10, -8], NE: [7, 10, -7], E: [10, 10, 0], SE: [7, 10, 7], S: [0, 10, 8], SW: [-7, 10, 7], W: [-10, 10, 0], NW: [-7, 10, -7],
  };
  const pos = posMap[direction] ?? [8, 12, 8];
  return (
    <>
      <directionalLight position={pos} intensity={1.8} castShadow color="#fff5e0"
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-near={0.1} shadow-camera-far={50}
        shadow-camera-left={-20} shadow-camera-right={20}
        shadow-camera-top={20} shadow-camera-bottom={-20} />
      {/* Lens flare placeholder */}
      <mesh position={pos}>
        <sphereGeometry args={[0.3, 8, 8]} />
        <meshBasicMaterial color="#fff5e0" transparent opacity={0.8} />
      </mesh>
    </>
  );
}

// ─── Wind particles ───────────────────────────────────────────────────────────
function WindParticles({ count = 250 }) {
  const meshRef = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 32;
      arr[i * 3 + 1] = Math.random() * 16;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 32;
    }
    return arr;
  }, [count]);

  useFrame((_, dt) => {
    if (!meshRef.current) return;
    const pos = meshRef.current.geometry.attributes.position;
    for (let i = 0; i < count; i++) {
      const nx = pos.getX(i) + dt * 2.5;
      pos.setX(i, nx > 16 ? -16 : nx);
    }
    pos.needsUpdate = true;
  });

  return (
    <points ref={meshRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={count} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color="#0df2f2" size={0.07} transparent opacity={0.35} sizeAttenuation />
    </points>
  );
}

// ─── Ambient particles (atmosphere) ──────────────────────────────────────────
function AmbientDust({ count = 150 }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 40;
      arr[i * 3 + 1] = Math.random() * 20;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 40;
    }
    return arr;
  }, [count]);
  useFrame((state) => {
    if (!ref.current) return;
    ref.current.rotation.y = state.clock.elapsedTime * 0.02;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={count} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color="#1a5a5a" size={0.04} transparent opacity={0.4} sizeAttenuation />
    </points>
  );
}

// ─── BIM Import helper ────────────────────────────────────────────────────────
function parseBIMFile(content: string): any[] | null {
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data.rooms)) return data.rooms;
    if (Array.isArray(data.layout)) return data.layout;
    if (Array.isArray(data)) return data;
  } catch { }
  return null;
}

// ─── Main 3D page ─────────────────────────────────────────────────────────────
export default function Model3DPage() {
  const params = useParams();
  const id = params.id as string;
  const { floorPlanData, environmentalData } = useEco3DStore();

  const [imported, setImported] = useState<any[] | null>(null);
  const [importError, setImportError] = useState("");
  const [showWind, setShowWind] = useState(true);
  const [showSun, setShowSun] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showDust, setShowDust] = useState(true);
  const [fps, setFps] = useState(60);
  const [exportMsg, setExportMsg] = useState("");

  const windDir = (environmentalData?.wind_direction) ?? "SW";
  const sunDir = "S";
  const rooms = imported ?? floorPlanData?.layout ?? [];
  const walls = imported ? [] : floorPlanData?.walls ?? [];
  const doors = imported ? [] : floorPlanData?.doors ?? [];

  // FPS counter
  useEffect(() => {
    let frames = 0; let last = performance.now();
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) { setFps(frames); frames = 0; last = now; }
      requestAnimationFrame(tick);
    };
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  // BIM import
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImportError("");
    const reader = new FileReader();
    reader.onload = ev => {
      const content = ev.target?.result as string;
      const parsed = parseBIMFile(content);
      if (parsed) { setImported(parsed); }
      else { setImportError("Invalid BIM file. Expected JSON with rooms/layout array."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // BIM export
  const handleExport = () => {
    const payload = {
      version: "ECO3D-BIM-1.0", plotId: id, rooms, exportedAt: new Date().toISOString(),
      metadata: { totalRooms: rooms.length, totalArea: rooms.reduce((a: number, r: any) => a + r.width * r.height, 0).toFixed(1), windDirection: windDir }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `eco3d-bim-${id}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    setExportMsg("BIM exported!"); setTimeout(() => setExportMsg(""), 2000);
  };

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>{`body{background:#060e0e;margin:0} .gl{background:rgba(8,20,20,0.75);backdrop-filter:blur(12px);border:1px solid rgba(13,242,242,0.1)} .glm{background:rgba(13,242,242,0.04);border:1px solid rgba(13,242,242,0.12)} @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}} .fi{animation:fadeIn 0.4s ease forwards}`}</style>

      <div className="w-screen h-screen flex flex-col overflow-hidden" style={{ background: "#060e0e", fontFamily: "'Space Grotesk',sans-serif" }}>

        {/* ── Header ── */}
        <header className="flex-shrink-0 absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-3.5 border-b border-white/5" style={{ background: "rgba(6,14,14,0.85)", backdropFilter: "blur(16px)" }}>
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-primary text-2xl">deployed_code</span>
              <div>
                <span className="text-white font-bold text-lg tracking-tight">ECO-3D</span>
                <span className="text-primary/60 font-light text-base ml-1.5">Studio</span>
              </div>
            </Link>
            <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ background: "rgba(13,242,242,0.08)", border: "1px solid rgba(13,242,242,0.15)" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">WebGL Active</span>
            </div>
          </div>

          <nav className="hidden md:flex items-center gap-1">
            {[{ l: "Analysis", h: `/analysis/${id}` }, { l: "Floor Plan", h: `/floorplan/${id}` }, { l: "3D Model", h: `/model3d/${id}`, a: true }, { l: "Report", h: `/report/${id}` }].map(item => (
              <Link key={item.l} href={item.h} className={`px-4 py-2 text-[12px] font-medium rounded transition-all ${item.a ? "text-primary border-b-2 border-primary" : "text-slate-400 hover:text-white"}`}>{item.l}</Link>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {/* Import BIM */}
            <label className="flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer text-[11px] font-bold uppercase tracking-widest transition-all hover:brightness-110 gl hover:border-primary/40"
              style={{ color: "#0df2f2" }}>
              <span className="material-symbols-outlined text-sm">upload_file</span>
              Import BIM
              <input type="file" accept=".json,.bim" onChange={handleImport} className="hidden" />
            </label>
            {/* Export BIM */}
            <button onClick={handleExport} className="flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-all hover:brightness-110"
              style={{ background: "#0df2f2", color: "#060e0e", boxShadow: "0 0 16px rgba(13,242,242,0.3)" }}>
              <span className="material-symbols-outlined text-sm">download</span>
              {exportMsg || "Export BIM"}
            </button>
          </div>
        </header>

        {/* ── 3D Canvas ── */}
        <div className="flex-1 relative" style={{ background: "radial-gradient(ellipse at 50% 30%, #0d2020 0%, #060e0e 70%)" }}>
          <Canvas camera={{ position: [16, 13, 16], fov: 48 }} shadows gl={{ antialias: true, alpha: false }}>
            <color attach="background" args={["#060e0e"]} />
            <fog attach="fog" args={["#060e0e", 30, 80]} />
            <ambientLight intensity={0.25} color="#80ffff" />
            {showSun && <SunLight direction={sunDir} />}
            <pointLight position={[0, 8, 0]} intensity={0.6} color="#0df2f2" distance={25} />
            {showWind && <WindParticles count={250} />}
            {showDust && <AmbientDust count={120} />}
            {showGrid && <gridHelper args={[40, 40, "rgba(13,242,242,0.15)", "rgba(13,242,242,0.04)"]} position={[0, 0, 0]} />}
            <Suspense fallback={null}>
              {rooms.length > 0 ? <Building rooms={rooms} walls={walls} doors={doors} /> : <DefaultBuilding />}
              <Environment preset="night" />
            </Suspense>
            <OrbitControls enableDamping dampingFactor={0.06} minPolarAngle={0.05} maxPolarAngle={Math.PI / 2.1} minDistance={4} maxDistance={50} />
          </Canvas>

          {/* Import error */}
          {importError && (
            <div className="absolute top-20 left-1/2 -translate-x-1/2 gl px-4 py-2 rounded-lg text-[11px] text-red-400 fi">
              {importError}
            </div>
          )}

          {/* Left HUD */}
          <div className="absolute top-20 left-4 flex flex-col gap-2.5 pointer-events-none fi">
            <div className="gl p-3 rounded-xl border-l-2 border-l-primary min-w-[180px]">
              <div className="text-[9px] uppercase font-bold text-primary/50 tracking-widest mb-1">Sunlight Direction</div>
              <div className="text-sm font-bold text-white">{windDir} — {environmentalData?.sun_exposure_hours?.toFixed(1) ?? "6.2"}h/day</div>
            </div>
            <div className="gl p-3 rounded-xl border-l-2 border-l-blue-400 min-w-[180px]">
              <div className="text-[9px] uppercase font-bold text-blue-400/50 tracking-widest mb-1">Wind Direction</div>
              <div className="text-sm font-bold text-white">Prevailing {environmentalData?.wind_direction ?? "SW"}</div>
            </div>
            {rooms.length > 0 && (
              <div className="gl p-3 rounded-xl border-l-2 border-l-green-400 min-w-[180px]">
                <div className="text-[9px] uppercase font-bold text-green-400/50 tracking-widest mb-1">Floor Plan</div>
                <div className="text-sm font-bold text-white">
                  {rooms.length} Rooms · {rooms.reduce((a: number, r: any) => a + r.width * r.height, 0).toFixed(0)}m²
                </div>
              </div>
            )}
            {imported && (
              <div className="gl p-3 rounded-xl border-l-2 border-l-yellow-400 min-w-[180px]">
                <div className="text-[9px] uppercase font-bold text-yellow-400/50 tracking-widest mb-1">BIM Imported</div>
                <div className="text-sm font-bold text-yellow-300">{imported.length} elements loaded</div>
              </div>
            )}
          </div>

          {/* Compass */}
          <div className="absolute top-20 right-4 pointer-events-none fi">
            <div className="gl w-14 h-14 rounded-full flex items-center justify-center relative" style={{ border: "2px solid rgba(13,242,242,0.2)" }}>
              <span className="material-symbols-outlined text-primary text-2xl" style={{ transform: "rotate(45deg)" }}>navigation</span>
              <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[8px] font-black text-primary">N</span>
              <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 text-[8px] text-slate-500">S</span>
              <span className="absolute top-1/2 -translate-y-1/2 -right-2 text-[8px] text-slate-500">E</span>
              <span className="absolute top-1/2 -translate-y-1/2 -left-2 text-[8px] text-slate-500">W</span>
            </div>
          </div>

          {/* Scene toggles */}
          <div className="absolute top-20 right-4 mt-20 flex flex-col gap-1.5 pointer-events-auto">
            {[{ l: "Wind", on: showWind, s: setShowWind, icon: "air", c: "#0df2f2" }, { l: "Sun", on: showSun, s: setShowSun, icon: "wb_sunny", c: "#f59e0b" }, { l: "Grid", on: showGrid, s: setShowGrid, icon: "grid_on", c: "#64748b" }, { l: "Dust", on: showDust, s: setShowDust, icon: "blur_on", c: "#2ecc71" }].map(({ l, on, s, icon, c }) => (
              <button key={l} onClick={() => s(!on)} className="w-12 h-10 gl rounded-lg flex flex-col items-center justify-center transition-all hover:border-white/20" style={{ borderColor: on ? `${c}50` : "rgba(255,255,255,0.06)" }}>
                <span className="material-symbols-outlined text-base" style={{ color: on ? c : "#475569" }}>{icon}</span>
                <span className="text-[8px] uppercase" style={{ color: on ? c : "#475569" }}>{l}</span>
              </button>
            ))}
          </div>

          {/* Bottom left — engine info */}
          <div className="absolute bottom-4 left-4 gl px-4 py-2.5 rounded-xl pointer-events-none fi">
            <div className="text-[9px] font-bold text-primary/40 uppercase tracking-widest mb-1">Rendering Engine</div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white tracking-tight italic">Three.js WebGL</span>
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="text-[10px] font-mono text-primary/60">{fps} FPS</span>
            </div>
            <div className="text-[9px] text-slate-600 mt-0.5">{rooms.length > 0 ? `${rooms.length} rooms · ${rooms.reduce((a: number, r: any) => a + r.width * r.height, 0).toFixed(0)}m²` : "Default preview model"}</div>
          </div>

          {/* Bottom right — controls hint */}
          <div className="absolute bottom-4 right-4 gl px-4 py-2.5 rounded-xl text-[10px] text-primary/40 pointer-events-none fi">
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-sm">mouse</span>
              <span>Drag to orbit · Scroll to zoom</span>
            </div>
            <div className="text-primary/30">Right-drag to pan · R to reset</div>
          </div>

          {/* Room legend */}
          {rooms.length > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 gl px-4 py-2.5 rounded-xl pointer-events-none fi">
              <div className="text-[9px] font-bold text-primary/40 uppercase tracking-widest mb-1.5">Room Legend</div>
              <div className="flex items-center gap-3 flex-wrap">
                {Object.entries(ROOM_COLORS).map(([k, c]) => (
                  <div key={k} className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm" style={{ background: c, opacity: 0.7 }} />
                    <span className="text-[10px] text-slate-400 capitalize">{k}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
