"use client";

import { useRef, useMemo, Suspense, useState, useEffect, Component } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { useEco3DStore } from "@/store/useEco3DStore";

// ─── Error boundary for Three.js ──────────────────────────────────────────────
class ThreeErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#060e0e" }}>
          <div style={{ textAlign: "center", color: "#0df2f2", fontFamily: "monospace" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⬡</div>
            <div style={{ fontSize: 14, marginBottom: 6 }}>3D Engine initializing...</div>
            <div style={{ fontSize: 11, color: "#475569" }}>{this.state.error}</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Room color palette ───────────────────────────────────────────────────────
const ROOM_COLORS: Record<string, string> = {
  living: "#0df2f2", kitchen: "#2ecc71", bedroom: "#3498db",
  bathroom: "#9b59b6", office: "#f1c40f", garage: "#7f8c8d", utility: "#e67e22",
};

const getRoomColor = (type: string) => {
  const key = Object.keys(ROOM_COLORS).find(k => type.toLowerCase().includes(k));
  return key ? ROOM_COLORS[key] : "#0df2f2";
};

// ─── Scene lighting ───────────────────────────────────────────────────────────
function SceneLighting({ direction }: { direction: string }) {
  const posMap: Record<string, [number, number, number]> = {
    N: [0, 12, -10], NE: [8, 12, -8], E: [12, 12, 0], SE: [8, 12, 8],
    S: [0, 12, 10], SW: [-8, 12, 8], W: [-12, 12, 0], NW: [-8, 12, -8],
  };
  const pos = posMap[direction] ?? [8, 12, 8];
  return (
    <>
      <ambientLight intensity={0.4} color="#c0f0ff" />
      <hemisphereLight args={["#1a4040", "#000000", 0.3]} />
      <directionalLight
        position={pos} intensity={2.0} castShadow color="#fff8e0"
        shadow-mapSize-width={1024} shadow-mapSize-height={1024}
        shadow-camera-near={0.5} shadow-camera-far={60}
        shadow-camera-left={-20} shadow-camera-right={20}
        shadow-camera-top={20} shadow-camera-bottom={-20}
      />
      <pointLight position={[-10, 8, -10]} intensity={0.5} color="#0df2f2" distance={30} />
      <pointLight position={[10, 6, 10]} intensity={0.3} color="#0a9a9a" distance={25} />
    </>
  );
}

// ─── Building geometry ────────────────────────────────────────────────────────
function Building({ rooms, walls, doors }: { rooms: any[]; walls?: any[]; doors?: any[] }) {
  const groupRef = useRef<THREE.Group>(null);
  const floorH = 3.2;

  if (walls && walls.length > 0) {
    return (
      <group ref={groupRef}>
        {rooms.map((room, idx) => {
          const color = getRoomColor(room.type);
          const x = (room.x ?? 0) + (room.width ?? 4) / 2 - 8;
          const z = (room.y ?? 0) + (room.height ?? 4) / 2 - 8;
          const y = ((room.floor ?? 1) - 1) * floorH;
          return (
            <group key={`fs-${idx}`}>
              <mesh position={[x, y + 0.05, z]} receiveShadow>
                <boxGeometry args={[(room.width ?? 4) - 0.1, 0.1, (room.height ?? 4) - 0.1]} />
                <meshStandardMaterial color={color} transparent opacity={0.45} roughness={0.8} />
              </mesh>
            </group>
          );
        })}
        {walls.map((wall, idx) => {
          const w = wall.orientation === "horizontal" ? (wall.length ?? 4) : (wall.thickness ?? 0.2);
          const d = wall.orientation === "horizontal" ? (wall.thickness ?? 0.2) : (wall.length ?? 4);
          const h = floorH * 0.95;
          return (
            <mesh key={`w-${idx}`} position={[(wall.x ?? 0) - 8, h / 2, (wall.y ?? 0) - 8]} castShadow receiveShadow>
              <boxGeometry args={[w, h, d]} />
              <meshStandardMaterial color={wall.type === "exterior" ? "#dde6f0" : "#c0ccd8"} roughness={0.85} />
            </mesh>
          );
        })}
        {(doors ?? []).map((door, idx) => {
          const isH = door.orientation === "horizontal";
          const w = isH ? (door.width ?? 1) : 0.28;
          const d = isH ? 0.28 : (door.width ?? 1);
          return (
            <mesh key={`d-${idx}`} position={[(door.x ?? 0) - 8, 1.05, (door.y ?? 0) - 8]} castShadow>
              <boxGeometry args={[w, 2.1, d]} />
              <meshStandardMaterial color={door.type === "entry" ? "#c0392b" : "#2c3e50"} roughness={0.4} transparent opacity={0.85} />
            </mesh>
          );
        })}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
          <planeGeometry args={[48, 48]} />
          <meshStandardMaterial color="#061414" roughness={0.92} />
        </mesh>
      </group>
    );
  }

  // Volumetric block fallback
  return (
    <group ref={groupRef}>
      {rooms.map((room, idx) => {
        const color = getRoomColor(room.type ?? "living");
        const x = (room.x ?? 0) + (room.width ?? 4) / 2 - 8;
        const z = (room.y ?? 0) + (room.height ?? 4) / 2 - 8;
        const y = ((room.floor ?? 1) - 1) * floorH + floorH / 2;
        return (
          <group key={idx}>
            <mesh position={[x, y, z]} castShadow receiveShadow>
              <boxGeometry args={[room.width ?? 4, floorH * 0.94, room.height ?? 4]} />
              <meshStandardMaterial
                color={color} transparent opacity={0.75}
                roughness={0.2} metalness={0.1}
                emissive={color} emissiveIntensity={0.05}
              />
            </mesh>
            {/* Glass top cap */}
            <mesh position={[x, y + floorH * 0.47, z]}>
              <boxGeometry args={[(room.width ?? 4), 0.06, (room.height ?? 4)]} />
              <meshStandardMaterial color={color} transparent opacity={0.25} roughness={0} metalness={0.9} />
            </mesh>
            {/* Floor slab */}
            <mesh position={[x, ((room.floor ?? 1) - 1) * floorH, z]} receiveShadow>
              <boxGeometry args={[(room.width ?? 4) + 0.06, 0.08, (room.height ?? 4) + 0.06]} />
              <meshStandardMaterial color="#0a2020" roughness={0.9} />
            </mesh>
            <Text
              position={[x, y + floorH * 0.5 + 0.3, z]}
              fontSize={0.28} color={color}
              anchorX="center" anchorY="bottom"
              outlineWidth={0.02} outlineColor="#000"
            >
              {(room.type ?? "room").replace(/_/g, " ").toUpperCase()}
            </Text>
          </group>
        );
      })}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[48, 48]} />
        <meshStandardMaterial color="#061414" roughness={0.92} />
      </mesh>
    </group>
  );
}

// ─── Default placeholder building ─────────────────────────────────────────────
function DefaultBuilding() {
  const configs: [number, number, number, number][] = [
    [-4, -3, 3.0, 5.0], [0, -3, 3.0, 6.5], [4, -3, 3.0, 4.2],
    [-2, 1, 3.0, 5.8], [2, 1, 3.0, 4.8],
  ];
  return (
    <group>
      {configs.map(([x, z, w, h], i) => (
        <group key={i}>
          <mesh position={[x, h / 2, z]} castShadow>
            <boxGeometry args={[w, h, w]} />
            <meshStandardMaterial color="#0df2f2" transparent opacity={0.55} roughness={0.25} emissive="#0df2f2" emissiveIntensity={0.06} />
          </mesh>
          <mesh position={[x, h + 0.06, z]}>
            <boxGeometry args={[w + 0.12, 0.12, w + 0.12]} />
            <meshStandardMaterial color="#0df2f2" transparent opacity={0.28} />
          </mesh>
        </group>
      ))}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[28, 28]} />
        <meshStandardMaterial color="#061414" roughness={0.9} />
      </mesh>
      {/* "No plot selected" label */}
      <Text position={[0, 8, 0]} fontSize={0.6} color="#0df2f2" anchorX="center" anchorY="middle" fillOpacity={0.5}>
        PREVIEW MODEL
      </Text>
    </group>
  );
}

// ─── Wind particles ───────────────────────────────────────────────────────────
function WindParticles({ count = 200 }: { count?: number }) {
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
      <pointsMaterial color="#0df2f2" size={0.07} transparent opacity={0.3} sizeAttenuation />
    </points>
  );
}

// ─── Ambient dust ─────────────────────────────────────────────────────────────
function AmbientDust({ count = 120 }: { count?: number }) {
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
    if (ref.current) ref.current.rotation.y = state.clock.elapsedTime * 0.02;
  });
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" array={positions} count={count} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color="#1a5a5a" size={0.04} transparent opacity={0.35} sizeAttenuation />
    </points>
  );
}

// ─── BIM import helper ────────────────────────────────────────────────────────
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
  const [canvasReady, setCanvasReady] = useState(false);

  const windDir = environmentalData?.wind_direction ?? "SW";
  const rooms = imported ?? floorPlanData?.layout ?? [];
  const walls = imported ? [] : (floorPlanData?.walls ?? []);
  const doors = imported ? [] : (floorPlanData?.doors ?? []);

  // Delay Canvas mount slightly so DOM is fully ready
  useEffect(() => {
    const t = setTimeout(() => setCanvasReady(true), 100);
    return () => clearTimeout(t);
  }, []);

  // FPS counter
  useEffect(() => {
    let frames = 0; let last = performance.now(); let rafId = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) { setFps(frames); frames = 0; last = now; }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImportError("");
    const reader = new FileReader();
    reader.onload = ev => {
      const content = ev.target?.result as string;
      const parsed = parseBIMFile(content);
      if (parsed) setImported(parsed);
      else setImportError("Invalid BIM file — expected JSON with rooms/layout array.");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleExport = () => {
    const payload = {
      version: "ECO3D-BIM-1.0", plotId: id, rooms,
      exportedAt: new Date().toISOString(),
      metadata: {
        totalRooms: rooms.length,
        totalArea: rooms.reduce((a: number, r: any) => a + (r.width ?? 0) * (r.height ?? 0), 0).toFixed(1),
        windDirection: windDir,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `eco3d-bim-${id}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    setExportMsg("BIM exported!"); setTimeout(() => setExportMsg(""), 2000);
  };

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <style>{`
        body { background: #060e0e; margin: 0; }
        .gl { background: rgba(8,20,20,0.75); backdrop-filter: blur(12px); border: 1px solid rgba(13,242,242,0.1); }
        .glm { background: rgba(13,242,242,0.04); border: 1px solid rgba(13,242,242,0.12); }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .fi { animation: fadeIn 0.4s ease forwards; }
      `}</style>

      {/* Full-screen container with explicit height */}
      <div style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "#060e0e", fontFamily: "'Space Grotesk', sans-serif" }}>

        {/* ── Header ── */}
        <header className="flex-shrink-0" style={{ position: "relative", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(6,14,14,0.92)", backdropFilter: "blur(16px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
              <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 24 }}>deployed_code</span>
              <div>
                <span style={{ color: "white", fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>ECO-3D</span>
                <span style={{ color: "rgba(13,242,242,0.6)", fontWeight: 300, fontSize: 16, marginLeft: 6 }}>Studio</span>
              </div>
            </Link>
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, background: "rgba(13,242,242,0.08)", border: "1px solid rgba(13,242,242,0.15)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0df2f2", animation: "hud-pulse 2s infinite", display: "inline-block" }} />
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "#0df2f2" }}>WebGL Active</span>
            </div>
          </div>

          <nav style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {[
              { l: "Blueprint Generator", h: `/analysis/${id}` },
              { l: "Environmental Data", h: `/environment/${id}` },
              { l: "3D Model", h: `/model3d/${id}`, a: true },
              { l: "Export", h: `/report/${id}` },
            ].map(item => (
              <Link key={item.l} href={item.h} style={{
                padding: "8px 16px", fontSize: 12, fontWeight: 500, borderRadius: 4,
                textDecoration: "none", transition: "all 0.2s",
                color: item.a ? "#0df2f2" : "#94a3b8",
                borderBottom: item.a ? "2px solid #0df2f2" : "none",
              }}>{item.l}</Link>
            ))}
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label className="gl" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", color: "#0df2f2" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload_file</span>
              Import BIM
              <input type="file" accept=".json,.bim" onChange={handleImport} style={{ display: "none" }} />
            </label>
            <button onClick={handleExport} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 8, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", background: "#0df2f2", color: "#060e0e", border: "none", cursor: "pointer", boxShadow: "0 0 16px rgba(13,242,242,0.3)" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
              {exportMsg || "Export BIM"}
            </button>
          </div>
        </header>

        {/* ── 3D Canvas area — explicit flex-1 with overflow hidden ── */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden", background: "radial-gradient(ellipse at 50% 30%, #0d2020 0%, #060e0e 70%)" }}>

          {/* Canvas — only mount after DOM ready */}
          {canvasReady && (
            <ThreeErrorBoundary>
              <Canvas
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                camera={{ position: [16, 13, 16], fov: 48 }}
                shadows
                gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
                onCreated={({ gl }) => {
                  gl.setClearColor("#060e0e");
                  gl.shadowMap.enabled = true;
                  gl.shadowMap.type = THREE.PCFSoftShadowMap;
                }}
              >
                <color attach="background" args={["#060e0e"]} />
                <fog attach="fog" args={["#060e0e", 35, 90]} />

                <SceneLighting direction={showSun ? windDir : "S"} />

                {showGrid && (
                  <gridHelper
                    args={[40, 40, new THREE.Color(0.05, 0.55, 0.55), new THREE.Color(0.02, 0.22, 0.22)]}
                    position={[0, 0, 0]}
                  />
                )}

                {showWind && <WindParticles count={200} />}
                {showDust && <AmbientDust count={100} />}

                <Suspense fallback={null}>
                  {rooms.length > 0
                    ? <Building rooms={rooms} walls={walls} doors={doors} />
                    : <DefaultBuilding />
                  }
                </Suspense>

                <OrbitControls
                  enableDamping
                  dampingFactor={0.06}
                  minPolarAngle={0.05}
                  maxPolarAngle={Math.PI / 2.05}
                  minDistance={4}
                  maxDistance={55}
                />
              </Canvas>
            </ThreeErrorBoundary>
          )}

          {/* Loading state before canvas mounts */}
          {!canvasReady && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ textAlign: "center", color: "#0df2f2" }}>
                <div style={{ width: 40, height: 40, border: "2px solid rgba(13,242,242,0.2)", borderTop: "2px solid #0df2f2", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px" }} />
                <div style={{ fontSize: 12, letterSpacing: "0.15em", textTransform: "uppercase" }}>Loading 3D Engine...</div>
              </div>
            </div>
          )}

          {importError && (
            <div className="gl fi" style={{ position: "absolute", top: 80, left: "50%", transform: "translateX(-50%)", padding: "8px 16px", borderRadius: 8, fontSize: 11, color: "#f87171" }}>
              {importError}
            </div>
          )}

          {/* Left HUD */}
          <div className="fi" style={{ position: "absolute", top: 16, left: 16, display: "flex", flexDirection: "column", gap: 10, pointerEvents: "none" }}>
            <div className="gl" style={{ padding: 12, borderRadius: 12, borderLeft: "2px solid #0df2f2", minWidth: 180 }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", color: "rgba(13,242,242,0.5)", marginBottom: 4 }}>Sunlight Direction</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "white" }}>{windDir} — {environmentalData?.sun_exposure_hours?.toFixed(1) ?? "8.0"}h/day</div>
            </div>
            <div className="gl" style={{ padding: 12, borderRadius: 12, borderLeft: "2px solid #3b82f6", minWidth: 180 }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", color: "rgba(59,130,246,0.5)", marginBottom: 4 }}>Wind Direction</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "white" }}>Prevailing {windDir}</div>
            </div>
            {rooms.length > 0 && (
              <div className="gl" style={{ padding: 12, borderRadius: 12, borderLeft: "2px solid #2ecc71", minWidth: 180 }}>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.15em", color: "rgba(46,204,113,0.5)", marginBottom: 4 }}>Floor Plan</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "white" }}>
                  {rooms.length} Rooms · {rooms.reduce((a: number, r: any) => a + (r.width ?? 0) * (r.height ?? 0), 0).toFixed(0)}m²
                </div>
              </div>
            )}
          </div>

          {/* Compass */}
          <div className="fi" style={{ position: "absolute", top: 16, right: 16, pointerEvents: "none" }}>
            <div className="gl" style={{ width: 56, height: 56, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", position: "relative", border: "2px solid rgba(13,242,242,0.2)" }}>
              <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 24, transform: "rotate(45deg)" }}>navigation</span>
              <span style={{ position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)", fontSize: 8, fontWeight: 900, color: "#0df2f2" }}>N</span>
              <span style={{ position: "absolute", bottom: -8, left: "50%", transform: "translateX(-50%)", fontSize: 8, color: "#475569" }}>S</span>
              <span style={{ position: "absolute", right: -8, top: "50%", transform: "translateY(-50%)", fontSize: 8, color: "#475569" }}>E</span>
              <span style={{ position: "absolute", left: -8, top: "50%", transform: "translateY(-50%)", fontSize: 8, color: "#475569" }}>W</span>
            </div>
          </div>

          {/* Scene toggles */}
          <div style={{ position: "absolute", top: 86, right: 16, display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { l: "Wind", on: showWind, s: setShowWind, icon: "air", c: "#0df2f2" },
              { l: "Sun", on: showSun, s: setShowSun, icon: "wb_sunny", c: "#f59e0b" },
              { l: "Grid", on: showGrid, s: setShowGrid, icon: "grid_on", c: "#64748b" },
              { l: "Dust", on: showDust, s: setShowDust, icon: "blur_on", c: "#2ecc71" },
            ].map(({ l, on, s, icon, c }) => (
              <button key={l} onClick={() => s(!on)} className="gl" style={{ width: 48, height: 40, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", border: on ? `1px solid ${c}50` : "1px solid rgba(255,255,255,0.06)" }}>
                <span className="material-symbols-outlined" style={{ color: on ? c : "#475569", fontSize: 16 }}>{icon}</span>
                <span style={{ fontSize: 8, textTransform: "uppercase", color: on ? c : "#475569" }}>{l}</span>
              </button>
            ))}
          </div>

          {/* Bottom left */}
          <div className="gl fi" style={{ position: "absolute", bottom: 16, left: 16, padding: "10px 16px", borderRadius: 12, pointerEvents: "none" }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "rgba(13,242,242,0.4)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 4 }}>Rendering Engine</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "white", fontStyle: "italic" }}>Three.js WebGL</span>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0df2f2", animation: "hud-pulse 2s infinite", display: "inline-block" }} />
              <span style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(13,242,242,0.6)" }}>{fps} FPS</span>
            </div>
            <div style={{ fontSize: 9, color: "#475569", marginTop: 2 }}>
              {rooms.length > 0 ? `${rooms.length} rooms · ${rooms.reduce((a: number, r: any) => a + (r.width ?? 0) * (r.height ?? 0), 0).toFixed(0)}m²` : "Preview model"}
            </div>
          </div>

          {/* Bottom right hint */}
          <div className="gl fi" style={{ position: "absolute", bottom: 16, right: 16, padding: "10px 16px", borderRadius: 12, fontSize: 10, color: "rgba(13,242,242,0.4)", pointerEvents: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>mouse</span>
              Drag to orbit · Scroll to zoom
            </div>
            <div style={{ color: "rgba(13,242,242,0.25)" }}>Right-drag to pan</div>
          </div>

          {/* Room legend */}
          {rooms.length > 0 && (
            <div className="gl fi" style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", padding: "10px 16px", borderRadius: 12, pointerEvents: "none" }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: "rgba(13,242,242,0.4)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 6 }}>Room Legend</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                {Object.entries(ROOM_COLORS).map(([k, c]) => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 2, background: c, opacity: 0.75, display: "inline-block" }} />
                    <span style={{ fontSize: 10, color: "#94a3b8", textTransform: "capitalize" }}>{k}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes hud-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
