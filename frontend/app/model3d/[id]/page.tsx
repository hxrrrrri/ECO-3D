"use client";

import { useRef, useMemo, Suspense, useState, useEffect, Component } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { useEco3DStore } from "@/store/useEco3DStore";

// ── Error boundary ────────────────────────────────────────────────────────────
class ThreeErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) return (
      <div style={{ width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"#060e0e" }}>
        <div style={{ textAlign:"center",color:"#0df2f2",fontFamily:"monospace" }}>
          <div style={{ fontSize:28,marginBottom:8 }}>⬡</div>
          <div style={{ fontSize:12,marginBottom:4 }}>3D Engine error</div>
          <div style={{ fontSize:10,color:"#475569" }}>{this.state.error}</div>
        </div>
      </div>
    );
    return this.props.children;
  }
}

// ── Room accent colours (matching floor plan) ─────────────────────────────────
const ACCENTS: Record<string,string> = {
  living:"#0bc8c8", bedroom:"#4a9de8", kitchen:"#2cb46e",
  bathroom:"#9b72d4", office:"#e8c33a", garage:"#8fa0a0", utility:"#e08050",
};
const getAccent = (t: string) => Object.entries(ACCENTS).find(([k]) => t.toLowerCase().includes(k))?.[1] ?? "#0df2f2";

// ── Lighting ──────────────────────────────────────────────────────────────────
function Lighting({ dir, sunOn, nightLightOn }: { dir: string; sunOn: boolean; nightLightOn: boolean }) {
  const now = new Date();
  const h = now.getHours() + now.getMinutes()/60;
  const hourAngle = ((h - 12) / 12) * Math.PI;
  const elev = Math.max(0.1, Math.cos(hourAngle) * 0.85);
  const azimX = Math.sin(hourAngle) * 14;
  const azimZ = Math.cos(hourAngle) * 8;
  const posY = Math.max(3, elev * 16 + 4);
  const isActuallyDaytime = h >= 6 && h <= 19;

  // nightLightOn = ONLY activates when user manually presses the LIGHT button
  // At night without studio: model uses fallback fill light (never pitch black)
  // studioMode is PURELY manual — never auto-activates
  const sunMode = sunOn && isActuallyDaytime && !nightLightOn;
  const studioMode = nightLightOn; // manual toggle only, no auto

  return (
    <>
      {/* Base ambient — always present, brighter in studio mode */}
      <ambientLight
        intensity={studioMode ? 1.6 : (sunMode ? 0.45 : 1.2)}
        color={studioMode ? "#ffffff" : "#e8f4ff"}
      />
      <hemisphereLight
        args={studioMode ? ["#ffffff","#aabbaa",1.0] : (isActuallyDaytime ? ["#c8e4ff","#1a2820",0.5] : ["#8899cc","#223322",0.7])}
      />

      {/* Sun directional light (daytime, no studio override) */}
      {sunMode && (
        <directionalLight
          position={[azimX, posY, azimZ]}
          intensity={2.6}
          castShadow
          color="#fff5d0"
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-near={0.5}
          shadow-camera-far={120}
          shadow-camera-left={-35}
          shadow-camera-right={35}
          shadow-camera-top={35}
          shadow-camera-bottom={-35}
        />
      )}

      {/* Studio 3-point rig — activates when LIGHT is on OR it's nighttime */}
      {studioMode && <>
        <directionalLight
          position={[14, 20, 10]}
          intensity={2.2}
          color="#ffffff"
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-left={-32}
          shadow-camera-right={32}
          shadow-camera-top={32}
          shadow-camera-bottom={-32}
          shadow-camera-near={0.5}
          shadow-camera-far={100}
        />
        <directionalLight position={[-12, 15, -8]}  intensity={1.2} color="#d8eeff" />
        <directionalLight position={[0,   10, -16]}  intensity={0.8} color="#ffeedd" />
        <pointLight position={[0, 6, 0]} intensity={1.0} color="#ffe8cc" distance={40} decay={1.2} />
      </>}

      {/* Fallback fill light so model is NEVER completely dark (sun off, no studio) */}
      {!sunMode && !studioMode && (
        <directionalLight position={[8, 12, 6]} intensity={1.6} color="#d0e8ff" />
      )}
    </>
  );
}

// ── Sun sphere with real-time position ───────────────────────────────────────
function SunSphere({ dir, lat }: { dir: string; lat?: number }) {
  const sunRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  // Real-time sun position based on hour angle
  const getSunPos = (): [number, number, number] => {
    const now = new Date();
    const h = now.getHours() + now.getMinutes()/60;
    // Hour angle: -90° at sunrise(6am), 0° at noon, +90° at sunset(18am)
    const hourAngle = ((h - 12) / 12) * Math.PI;
    const elev = Math.cos(hourAngle) * 0.8; // elevation factor
    const azim = hourAngle; // simplified azimuth

    // Cardinal direction bias from wind_dir
    const D: Record<string,[number,number]> = {
      N:[0,-1],NE:[0.7,-0.7],E:[1,0],SE:[0.7,0.7],
      S:[0,1],SW:[-0.7,0.7],W:[-1,0],NW:[-0.7,-0.7],
    };
    const k = Object.keys(D).find(k => dir.startsWith(k)) ?? "S";
    const [dx, dz] = D[k];
    const radius = 18;
    const x = Math.sin(azim) * radius * 0.8 + dx * 4;
    const y = Math.max(2, elev * 16 + 6);
    const z = Math.cos(azim) * radius * 0.4 + dz * 4;
    return [x, y, z];
  };

  const pos = getSunPos();

  useFrame((s) => {
    if (ringRef.current) ringRef.current.rotation.z = s.clock.elapsedTime * 0.6;
    // Slowly update sun position in real time
    if (sunRef.current) {
      const np = getSunPos();
      sunRef.current.position.lerp(new THREE.Vector3(...np), 0.002);
    }
  });

  const isDaytime = () => {
    const h = new Date().getHours();
    return h >= 6 && h <= 18;
  };

  if (!isDaytime()) return null; // Hide sun at night

  return (
    <group ref={sunRef} position={pos}>
      <mesh><sphereGeometry args={[0.65,20,20]} /><meshStandardMaterial color="#fcd34d" emissive="#f59e0b" emissiveIntensity={2.0} /></mesh>
      <mesh ref={ringRef}><torusGeometry args={[1.0, 0.06, 8, 32]} /><meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={1.5} /></mesh>
      {/* Corona rays */}
      {Array.from({length:8}).map((_,i) => {
        const a = (i/8)*Math.PI*2;
        return <mesh key={i} position={[Math.cos(a)*1.3,Math.sin(a)*1.3,0]} rotation={[0,0,a]}>
          <boxGeometry args={[0.5,0.04,0.04]} />
          <meshStandardMaterial color="#fcd34d" emissive="#fbbf24" emissiveIntensity={1.5} />
        </mesh>;
      })}
      <pointLight intensity={4.0} color="#fcd34d" distance={60} decay={1.5} />
    </group>
  );
}

// ── Wind Effect — clean curved streaks + ground compass arrow ─────────────────
// Flowing cyan arc-lines that sweep past the building at low altitude, with a
// flat glowing arrow on the ground clearly showing wind direction.
function WindSwirl({ dir, cx, cz, modelW, modelD }: {
  dir: string; cx: number; cz: number; modelW: number; modelD: number;
}) {
  const v = useMemo(() => {
    const M: Record<string,[number,number]> = {
      N:[0,-1], NNE:[0.38,-0.92], NE:[0.71,-0.71], ENE:[0.92,-0.38],
      E:[1,0],  ESE:[0.92,0.38],  SE:[0.71,0.71],  SSE:[0.38,0.92],
      S:[0,1],  SSW:[-0.38,0.92], SW:[-0.71,0.71], WSW:[-0.92,0.38],
      W:[-1,0], WNW:[-0.92,-0.38],NW:[-0.71,-0.71],NNW:[-0.38,-0.92],
    };
    const k = Object.keys(M).find(k => dir.startsWith(k)) ?? "SW";
    const [x,z] = M[k]; const l = Math.sqrt(x*x+z*z)||1;
    return { x:x/l, z:z/l };
  }, [dir]);
  const perp = useMemo(() => ({ x: -v.z, z: v.x }), [v]);

  // ── 280-particle spray system (original look) ──────────────────────────────
  const COUNT  = 280;
  const spread  = Math.max(modelW, modelD) * 1.4;
  const travelD = Math.max(modelW, modelD) * 2.2;

  const { posArr, colArr, particles } = useMemo(() => {
    const posArr = new Float32Array(COUNT * 3);
    const colArr = new Float32Array(COUNT * 3);
    const particles = Array.from({ length: COUNT }, (_, i) => ({
      lane:    (i / COUNT - 0.5) * spread,
      baseY:   0.3 + (i % 14) * 0.28,
      phase:   (i / COUNT) * Math.PI * 2,
      speed:   0.18 + (i % 13) * 0.02,
      wobble:  0.4 + (i % 7) * 0.13,
      wfreq:   0.8 + (i % 5) * 0.27,
    }));
    return { posArr, colArr, particles };
  }, [spread]);

  const geoRef = useRef<THREE.BufferGeometry>(null!);
  const ptsRef = useRef<THREE.Points>(null!);

  useFrame(({ clock }) => {
    const T = clock.elapsedTime;
    particles.forEach((p, i) => {
      const t = ((T * p.speed + p.phase) % (Math.PI * 2)) / (Math.PI * 2);
      const wb = Math.sin(t * Math.PI * p.wfreq * 4 + p.phase) * p.wobble;
      posArr[i*3+0] = cx - v.x * travelD * 0.5 + v.x * travelD * t + perp.x * (p.lane + wb);
      posArr[i*3+1] = p.baseY + t * 0.8 + Math.sin(t * Math.PI * 3 + p.phase) * 0.18;
      posArr[i*3+2] = cz - v.z * travelD * 0.5 + v.z * travelD * t + perp.z * (p.lane + wb);
      // Cyan → white gradient by altitude, faded by bell curve
      const fade = Math.sin(t * Math.PI);
      const alt  = Math.min(1, posArr[i*3+1] / 4);
      colArr[i*3+0] = (0.2 + alt * 0.5) * fade;
      colArr[i*3+1] = (0.85 + alt * 0.15) * fade;
      colArr[i*3+2] = 1.0 * fade;
    });
    if (geoRef.current) {
      (geoRef.current.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geoRef.current.attributes.color    as THREE.BufferAttribute).needsUpdate = true;
      geoRef.current.computeBoundingSphere();
    }
  });

  // Floating compass arrow above model — bobbing gently
  const arrowAngle = Math.atan2(v.x, v.z);
  const arrowRef   = useRef<THREE.Group>(null!);
  useFrame(({ clock }) => {
    if (arrowRef.current) arrowRef.current.position.y = 6 + Math.sin(clock.elapsedTime * 1.2) * 0.25;
  });

  return (
    <group>
      {/* Particle cloud */}
      <points ref={ptsRef}>
        <bufferGeometry ref={geoRef}>
          <bufferAttribute attach="attributes-position" args={[posArr, 3]} />
          <bufferAttribute attach="attributes-color"    args={[colArr, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.22} vertexColors transparent opacity={0.9} sizeAttenuation depthWrite={false} />
      </points>

      {/* Floating 3D compass arrow */}
      <group ref={arrowRef} position={[cx, 6, cz]} rotation={[0, arrowAngle, 0]}>
        {/* Shaft */}
        <mesh position={[0, 0, -1.2]}>
          <cylinderGeometry args={[0.09, 0.09, 2.4, 8]} />
          <meshStandardMaterial color="#38bdf8" emissive="#0ea5e9" emissiveIntensity={1.8} transparent opacity={0.9} />
        </mesh>
        {/* Head (cone) */}
        <mesh position={[0, 0, 0.4]} rotation={[Math.PI/2, 0, 0]}>
          <coneGeometry args={[0.32, 0.9, 8]} />
          <meshStandardMaterial color="#7dd3fc" emissive="#38bdf8" emissiveIntensity={2.5} transparent opacity={0.95} />
        </mesh>
        {/* Tail feathers */}
        <mesh position={[0, 0, -2.5]}>
          <boxGeometry args={[0.06, 0.7, 0.5]} />
          <meshStandardMaterial color="#0ea5e9" emissive="#0284c7" emissiveIntensity={1.5} transparent opacity={0.8} />
        </mesh>
        <mesh position={[0, 0, -2.5]} rotation={[0, Math.PI/2, 0]}>
          <boxGeometry args={[0.06, 0.7, 0.5]} />
          <meshStandardMaterial color="#0ea5e9" emissive="#0284c7" emissiveIntensity={1.5} transparent opacity={0.8} />
        </mesh>
      </group>

      {/* Compass ring at base of arrow */}
      <mesh position={[cx, 5.8, cz]} rotation={[Math.PI/2, 0, 0]}>
        <torusGeometry args={[1.1, 0.05, 8, 32]} />
        <meshStandardMaterial color="#38bdf8" emissive="#0ea5e9" emissiveIntensity={1.0} transparent opacity={0.4} />
      </mesh>
    </group>
  );
}
// ── Furniture (2D top-down view approach for open-top house) ──────────────────
function Furniture({ type, w, d }: { type: string; w: number; d: number }) {
  const t = type.toLowerCase();
  const Y = 0.16; // slightly above floor
  const wood  = useMemo(() => new THREE.MeshStandardMaterial({color:"#7c5a38",roughness:0.8}),[]);
  const soft  = useMemo(() => new THREE.MeshStandardMaterial({color:"#3a5a70",roughness:0.95}),[]);
  const white = useMemo(() => new THREE.MeshStandardMaterial({color:"#e8e4de",roughness:0.7}),[]);
  const dark  = useMemo(() => new THREE.MeshStandardMaterial({color:"#252832",roughness:0.5}),[]);
  const metal = useMemo(() => new THREE.MeshStandardMaterial({color:"#9aacb4",metalness:0.7,roughness:0.3}),[]);
  const glassMat = useMemo(() => new THREE.MeshStandardMaterial({color:"#88bbdd",transparent:true,opacity:0.5}),[]);
  const green = useMemo(() => new THREE.MeshStandardMaterial({color:"#2a7a2a",roughness:0.9}),[]);

  if (t.includes("living")) return (
    <group>
      {/* Sofa */}
      <mesh position={[0, Y+0.2, d*0.28]} material={soft} castShadow><boxGeometry args={[Math.min(w-0.9,2.8),0.42,0.85]}/></mesh>
      <mesh position={[0, Y+0.45, d*0.28-0.36]} material={soft}><boxGeometry args={[Math.min(w-0.9,2.8),0.56,0.18]}/></mesh>
      {/* Armchairs */}
      <mesh position={[-(Math.min(w-0.9,2.8)/2+0.35), Y+0.2, d*0.05]} material={soft} castShadow><boxGeometry args={[0.6,0.42,0.6]}/></mesh>
      <mesh position={[(Math.min(w-0.9,2.8)/2+0.35), Y+0.2, d*0.05]} material={soft} castShadow><boxGeometry args={[0.6,0.42,0.6]}/></mesh>
      {/* Coffee table */}
      <mesh position={[0, Y+0.18, d*0.06]} material={glassMat} castShadow><boxGeometry args={[1.0,0.04,0.55]}/></mesh>
      {/* TV unit */}
      <mesh position={[0, Y+0.16, -d*0.3]} material={dark} castShadow><boxGeometry args={[Math.min(w-1,2.2),0.36,0.28]}/></mesh>
      <mesh position={[0, Y+0.35, -d*0.3]} material={dark}><boxGeometry args={[Math.min(w-1.4,1.8),0.26,0.04]}/></mesh>
      {/* Rug */}
      <mesh position={[0, Y+0.01, d*0.1]} rotation={[-Math.PI/2,0,0]}><planeGeometry args={[Math.min(w-1,2.5),1.8]}/><meshStandardMaterial color="#2a3a4a" roughness={1}/></mesh>
      {/* Plant */}
      <mesh position={[w*0.38, Y+0.42, -d*0.3]} material={metal} castShadow><cylinderGeometry args={[0.09,0.11,0.28,8]}/></mesh>
      <mesh position={[w*0.38, Y+0.7, -d*0.3]} material={green} castShadow><sphereGeometry args={[0.2,8,8]}/></mesh>
    </group>
  );

  if (t.includes("bedroom")) return (
    <group>
      <mesh position={[0, Y+0.22, 0.15]} material={wood} castShadow><boxGeometry args={[Math.min(w-0.8,2.0),0.28,Math.min(d-1,2.0)]}/></mesh>
      <mesh position={[0, Y+0.46, 0.15]} material={white} castShadow><boxGeometry args={[Math.min(w-1,1.8),0.2,Math.min(d-1.4,1.8)]}/></mesh>
      {[-0.36,0.36].map((px,i)=><mesh key={i} position={[px,Y+0.6,-0.35]} material={white} castShadow><boxGeometry args={[0.5,0.1,0.35]}/></mesh>)}
      <mesh position={[0, Y+0.68, -0.58]} material={wood} castShadow><boxGeometry args={[Math.min(w-0.8,2.0),0.85,0.1]}/></mesh>
      {[-1.1,1.1].filter(px=>Math.abs(px)<w/2-0.3).map((px,i)=>(
        <group key={i}>
          <mesh position={[px,Y+0.26,0.15]} material={wood} castShadow><boxGeometry args={[0.44,0.44,0.42]}/></mesh>
          <mesh position={[px,Y+0.5,0.15]} material={metal}><cylinderGeometry args={[0.05,0.05,0.06,8]}/></mesh>
        </group>
      ))}
      <mesh position={[-w*0.32, Y+1.0, d*0.28]} material={white} castShadow><boxGeometry args={[0.62,2.0,0.52]}/></mesh>
    </group>
  );

  if (t.includes("kitchen")) return (
    <group>
      <mesh position={[0, Y+0.44, -d/2+0.3]} material={white} castShadow><boxGeometry args={[w-0.3,0.88,0.58]}/></mesh>
      <mesh position={[0, Y+0.89, -d/2+0.3]} material={metal}><boxGeometry args={[w-0.3,0.04,0.58]}/></mesh>
      <mesh position={[-0.5, Y+0.93, -d/2+0.28]} material={dark}><boxGeometry args={[0.62,0.03,0.52]}/></mesh>
      {[-0.65,-0.35].map((px,i)=><mesh key={i} position={[-0.5+px*0.18,Y+0.96,-d/2+0.26]} castShadow><cylinderGeometry args={[0.07,0.07,0.02,10]}/><meshStandardMaterial color="#cc3300" emissive="#cc2200" emissiveIntensity={0.5}/></mesh>)}
      <mesh position={[w/2-0.48, Y+0.93, -d/2+0.28]} material={metal}><boxGeometry args={[0.5,0.05,0.44]}/></mesh>
      <mesh position={[0, Y+1.68, -d/2+0.15]} material={white}><boxGeometry args={[w-0.4,0.62,0.28]}/></mesh>
      {d>3.5&&<mesh position={[0,Y+0.88,0.55]} material={white} castShadow><boxGeometry args={[1.2,0.94,0.58]}/></mesh>}
    </group>
  );

  if (t.includes("bathroom")) return (
    <group>
      <mesh position={[-w/2+0.52, Y+0.28, -d/2+0.68]} material={white} castShadow><boxGeometry args={[0.76,0.52,1.45]}/></mesh>
      <mesh position={[w/2-0.36, Y+0.27, d/2-0.52]} material={white} castShadow><boxGeometry args={[0.38,0.5,0.55]}/></mesh>
      <mesh position={[w/2-0.36, Y+0.54, d/2-0.82]} material={white}><boxGeometry args={[0.38,0.11,0.18]}/></mesh>
      <mesh position={[-w/2+0.38, Y+0.4, d/2-0.38]} material={white} castShadow><boxGeometry args={[0.62,0.8,0.44]}/></mesh>
      <mesh position={[-w/2+0.38, Y+0.82, d/2-0.38]} material={metal}><boxGeometry args={[0.55,0.04,0.38]}/></mesh>
    </group>
  );

  if (t.includes("office")) return (
    <group>
      <mesh position={[0, Y+0.36, -d/2+0.44]} material={wood} castShadow><boxGeometry args={[Math.min(w-0.6,1.6),0.04,0.68]}/></mesh>
      <mesh position={[0, Y+0.08, -d/2+0.44]} material={wood}><boxGeometry args={[1.55,0.18,0.64]}/></mesh>
      <mesh position={[0, Y+0.2, 0.25]} material={dark} castShadow><cylinderGeometry args={[0.2,0.2,0.42,8]}/></mesh>
      <mesh position={[0, Y+0.48, 0.2]} material={dark}><boxGeometry args={[0.42,0.48,0.07]}/></mesh>
      <mesh position={[w*0.32, Y+0.88, -d/2+0.15]} material={white}><boxGeometry args={[0.55,1.75,0.2]}/></mesh>
    </group>
  );

  if (t.includes("garage")) return (
    <group>
      {/* Car silhouette */}
      <mesh position={[0, Y+0.28, 0]} material={metal} castShadow><boxGeometry args={[Math.min(w-1,2.0),0.5,Math.min(d-1.2,4.2)]}/></mesh>
      <mesh position={[0, Y+0.58, -0.4]} castShadow><boxGeometry args={[Math.min(w-1.4,1.6),0.4,Math.min(d-2,2.0)]}/><meshStandardMaterial color="#4a5a6a" roughness={0.4}/></mesh>
    </group>
  );

  return null;
}

// ── The core: one unified house, open-top ─────────────────────────────────────
//
// Instead of separate room boxes, we:
//   1. Lay out all rooms in a unified grid (same logic as floor plan)
//   2. Render a single outer perimeter wall around the whole house
//   3. Render interior walls (thin dividers) between rooms
//   4. Put floor + furniture inside each room
//   5. NO ceiling / NO roof → open top view exactly matching the floor plan
function UnifiedHouse({ rooms, showWind, showSun, windDir, editMode, selectedId, colorOverrides, onSelect }: {
  rooms: any[]; showWind: boolean; showSun: boolean; windDir: string;
  editMode?: boolean; selectedId?: string; colorOverrides?: Record<string,string>; onSelect?: (info:any)=>void;
}) {
  const floor1 = rooms.filter(r => (r.floor ?? 1) === 1);
  if (floor1.length === 0) return null;

  const FH = 3.2;         // floor height
  const OWT = 0.28;       // outer wall thickness
  const IWT = 0.14;       // inner wall thickness (dividers)

  // ── Same layout algorithm as the floor plan canvas ─────────────────────────
  const ORDER = ["living","kitchen","dining","bedroom","bedroom","bathroom","office","utility","garage"];
  const sorted = [...floor1].sort((a,b) => {
    const ai = ORDER.findIndex(o => a.type.toLowerCase().includes(o));
    const bi = ORDER.findIndex(o => b.type.toLowerCase().includes(o));
    return (ai<0?99:ai)-(bi<0?99:bi);
  });
  const pubT  = ["living","kitchen","dining"];
  const prvT  = ["bedroom","bathroom"];
  const svcT  = ["office","utility","garage","corridor"];
  const rows: any[][] = [
    sorted.filter(r => pubT.some(t => r.type.toLowerCase().includes(t))),
    sorted.filter(r => prvT.some(t => r.type.toLowerCase().includes(t))),
    sorted.filter(r => svcT.some(t => r.type.toLowerCase().includes(t))),
  ].filter(row => row.length > 0);

  const normSz = (r: any) => {
    const t = r.type.toLowerCase();
    if (t.includes("living"))   return {w:Math.max(4.5,Math.min(7,r.width)),  h:Math.max(4,Math.min(6,r.height))};
    if (t.includes("kitchen"))  return {w:Math.max(3.5,Math.min(5.5,r.width)),h:Math.max(3,Math.min(5,r.height))};
    if (t.includes("dining"))   return {w:Math.max(3,Math.min(5,r.width)),    h:Math.max(3,Math.min(4.5,r.height))};
    if (t.includes("bedroom"))  return {w:Math.max(3.2,Math.min(5,r.width)),  h:Math.max(3,Math.min(4.5,r.height))};
    if (t.includes("bathroom")) return {w:Math.max(2,Math.min(3.5,r.width)),  h:Math.max(2,Math.min(3.2,r.height))};
    if (t.includes("office"))   return {w:Math.max(3,Math.min(4.5,r.width)),  h:Math.max(3,Math.min(4,r.height))};
    if (t.includes("garage"))   return {w:Math.max(4.5,Math.min(7,r.width)),  h:Math.max(4,Math.min(6,r.height))};
    return {w:Math.max(2.5,Math.min(4,r.width)), h:Math.max(2,Math.min(3.5,r.height))};
  };

  const rowData = rows.map(row => ({
    totalW: row.reduce((s,r)=>s+normSz(r).w,0),
    maxH: Math.max(...row.map(r=>normSz(r).h)),
    rooms: row,
  }));
  const maxW = Math.max(...rowData.map(r=>r.totalW));

  type LayoutRoom = { room:any; px:number; py:number; pw:number; ph:number; };
  const laid: LayoutRoom[] = [];
  let curY = 0;
  rowData.forEach(({ totalW, maxH, rooms: row }) => {
    const scale = totalW < maxW ? maxW / totalW : 1;
    let curX = 0;
    row.forEach(r => {
      const sz = normSz(r); const rw = sz.w * scale; const rh = sz.h;
      laid.push({ room:r, px:curX, py:curY, pw:rw, ph:rh });
      curX += rw;
    });
    curY += maxH;
  });

  const totalW = maxW;
  const totalD = rowData.reduce((s,r)=>s+r.maxH,0);
  // Center on origin
  const offX = -totalW / 2;
  const offZ = -totalD / 2;

  // Sun position center of house
  const cx = 0; const cz = 0;

  // ── Wall material ───────────────────────────────────────────────────────────
  const wallMat    = useMemo(() => new THREE.MeshStandardMaterial({color:"#dde8ee",roughness:0.65,metalness:0.05,envMapIntensity:0.8}),[]);
  const intWallMat = useMemo(() => new THREE.MeshStandardMaterial({color:"#c8d4da",roughness:0.7,metalness:0.0}),[]);
  const foundMat   = useMemo(() => new THREE.MeshStandardMaterial({color:"#3a4a4a",roughness:0.95,metalness:0.05}),[]);

  return (
    <group>

      {/* ── FOUNDATION SLAB ─────────────────────────────────────────────── */}
      <mesh position={[cx, -0.12, cz]} receiveShadow>
        <boxGeometry args={[totalW + OWT*2 + 0.4, 0.22, totalD + OWT*2 + 0.4]} />
        <primitive object={foundMat} />
      </mesh>

      {/* ── OUTER PERIMETER WALLS (4 sides, full FH) ─────────────────────── */}
      {/* North wall */}
      <mesh position={[cx, FH/2, offZ - OWT/2]} castShadow receiveShadow
        onClick={(e:any)=>{e.stopPropagation();onSelect?.({id:"wall-N",label:"North Wall",type:"wall",color:colorOverrides?.["wall-N"]??"#dde8ee"});}}
        onPointerOver={(e:any)=>{e.stopPropagation();document.body.style.cursor=editMode?"pointer":"auto";}}
        onPointerOut={(e:any)=>{e.stopPropagation();document.body.style.cursor="auto";}}>
        <boxGeometry args={[totalW + OWT*2, FH, OWT]} />
        <meshStandardMaterial color={colorOverrides?.["wall-N"]??"#dde8ee"} roughness={0.65} metalness={0.05}
          emissive={selectedId==="wall-N"?"#0044aa":"#000000"} emissiveIntensity={selectedId==="wall-N"?0.3:0}/>
      </mesh>
      {/* ── MAIN ENTRANCE — south wall split precisely around door ──────── */}
      {/* Door opening = 1.1m centered at cx. Half-width of each panel = (totalW - 1.1) / 2  */}
      {(() => {
        const doorW = 1.1;
        const panelW = (totalW - doorW) / 2;
        const southZ = offZ + totalD + OWT / 2;
        const doorH  = FH * 0.76;
        return (
          <>
            {/* Left panel — goes from west edge to left door jamb */}
            <mesh position={[offX + panelW/2, FH/2, southZ]} castShadow receiveShadow>
              <boxGeometry args={[panelW, FH, OWT]} />
              <primitive object={wallMat} />
            </mesh>
            {/* Right panel — goes from right door jamb to east edge */}
            <mesh position={[offX + totalW - panelW/2, FH/2, southZ]} castShadow receiveShadow>
              <boxGeometry args={[panelW, FH, OWT]} />
              <primitive object={wallMat} />
            </mesh>
            {/* Transom — fills wall above door up to full height */}
            <mesh position={[cx, FH - (FH - doorH)/2, southZ]} castShadow>
              <boxGeometry args={[doorW, FH - doorH, OWT + 0.01]} />
              <primitive object={wallMat} />
            </mesh>
          </>
        );
      })()}

      {/* Main door — dark wood, double panel */}
      {/* Left leaf */}
      <mesh position={[cx - 0.28, FH*0.37, offZ + totalD + OWT/2 + 0.01]}>
        <boxGeometry args={[0.52, FH*0.74, 0.055]} />
        <meshStandardMaterial color="#5a3015" roughness={0.75} metalness={0.05} />
      </mesh>
      {/* Left panel detail */}
      <mesh position={[cx - 0.28, FH*0.42, offZ + totalD + OWT/2 + 0.04]}>
        <boxGeometry args={[0.34, FH*0.28, 0.02]} />
        <meshStandardMaterial color="#4a2510" roughness={0.8} />
      </mesh>
      {/* Right leaf */}
      <mesh position={[cx + 0.28, FH*0.37, offZ + totalD + OWT/2 + 0.01]}>
        <boxGeometry args={[0.52, FH*0.74, 0.055]} />
        <meshStandardMaterial color="#5a3015" roughness={0.75} metalness={0.05} />
      </mesh>
      <mesh position={[cx + 0.28, FH*0.42, offZ + totalD + OWT/2 + 0.04]}>
        <boxGeometry args={[0.34, FH*0.28, 0.02]} />
        <meshStandardMaterial color="#4a2510" roughness={0.8} />
      </mesh>
      {/* Door handles (gold) */}
      <mesh position={[cx + 0.52, FH*0.42, offZ + totalD + OWT/2 + 0.08]}>
        <boxGeometry args={[0.06, 0.22, 0.05]} />
        <meshStandardMaterial color="#c8a020" metalness={0.85} roughness={0.15} />
      </mesh>
      <mesh position={[cx - 0.52, FH*0.42, offZ + totalD + OWT/2 + 0.08]}>
        <boxGeometry args={[0.06, 0.22, 0.05]} />
        <meshStandardMaterial color="#c8a020" metalness={0.85} roughness={0.15} />
      </mesh>

      {/* Porch canopy above door */}
      <mesh position={[cx, FH*0.93, offZ + totalD + OWT + 0.6]} castShadow>
        <boxGeometry args={[2.4, 0.12, 1.2]} />
        <meshStandardMaterial color="#e8eef0" roughness={0.5} metalness={0.1} />
      </mesh>
      {/* Canopy support columns */}
      {[-0.9, 0.9].map((ox, i) => (
        <mesh key={`col-${i}`} position={[cx + ox, FH*0.5, offZ + totalD + OWT + 1.1]} castShadow>
          <boxGeometry args={[0.14, FH*0.93, 0.14]} />
          <meshStandardMaterial color="#e8eef0" roughness={0.55} />
        </mesh>
      ))}
      {/* Porch floor */}
      <mesh position={[cx, 0.07, offZ + totalD + OWT + 0.65]} receiveShadow>
        <boxGeometry args={[2.4, 0.13, 1.2]} />
        <meshStandardMaterial color="#4a5555" roughness={0.9} />
      </mesh>
      {/* Entry path to door */}
      <mesh position={[cx, 0.03, offZ + totalD + OWT + 2.2]} receiveShadow rotation={[-Math.PI/2,0,0]}>
        <planeGeometry args={[1.4, 2.6]} />
        <meshStandardMaterial color="#3a4a4a" roughness={0.95} />
      </mesh>
      {/* West wall */}
      <mesh position={[offX - OWT/2, FH/2, cz]} castShadow receiveShadow
        onClick={(e:any)=>{e.stopPropagation();onSelect?.({id:"wall-W",label:"West Wall",type:"wall",color:colorOverrides?.["wall-W"]??"#dde8ee"});}}
        onPointerOver={(e:any)=>{e.stopPropagation();document.body.style.cursor=editMode?"pointer":"auto";}}
        onPointerOut={(e:any)=>{e.stopPropagation();document.body.style.cursor="auto";}}>
        <boxGeometry args={[OWT, FH, totalD + OWT*2]} />
        <meshStandardMaterial color={colorOverrides?.["wall-W"]??"#dde8ee"} roughness={0.65} metalness={0.05}
          emissive={selectedId==="wall-W"?"#0044aa":"#000000"} emissiveIntensity={selectedId==="wall-W"?0.3:0}/>
      </mesh>
      {/* East wall */}
      <mesh position={[offX + totalW + OWT/2, FH/2, cz]} castShadow receiveShadow
        onClick={(e:any)=>{e.stopPropagation();onSelect?.({id:"wall-E",label:"East Wall",type:"wall",color:colorOverrides?.["wall-E"]??"#dde8ee"});}}
        onPointerOver={(e:any)=>{e.stopPropagation();document.body.style.cursor=editMode?"pointer":"auto";}}
        onPointerOut={(e:any)=>{e.stopPropagation();document.body.style.cursor="auto";}}>
        <boxGeometry args={[OWT, FH, totalD + OWT*2]} />
        <meshStandardMaterial color={colorOverrides?.["wall-E"]??"#dde8ee"} roughness={0.65} metalness={0.05}
          emissive={selectedId==="wall-E"?"#0044aa":"#000000"} emissiveIntensity={selectedId==="wall-E"?0.3:0}/>
      </mesh>

      {/* ── WINDOWS on outer walls — clearly visible from outside ──────── */}
      {laid.map(({ room, px, py, pw, ph }, idx) => {
        const t = room.type?.toLowerCase() ?? "";
        if (t.includes("bathroom")||t.includes("utility")||t.includes("garage")) return null;
        const rx = offX + px + pw/2; const rz = offZ + py + ph/2;
        const ww = Math.min(pw*0.44, 1.5); const wh = FH*0.38;
        const winY = FH*0.54;   // window centre height
        const isTopRow   = py < 0.1;
        const isBotRow   = py + ph > totalD - 0.1;
        const isLeftCol  = px < 0.1;
        const isRightCol = px + pw > totalW - 0.1;
        // Windows sit proud of wall outer face — positive offset pushes them OUT of the wall
        // North wall outer face = offZ.  Window group pos z = offZ - wallFace (negative = outward)
        // South wall outer face = offZ+totalD.  Window group pos z = offZ+totalD + wallFace
        const wallFace = OWT / 2 + 0.01;  // just proud of the outer wall surface

        const WindowUnit = ({ pos, rot, wide, tall }: { pos:[number,number,number]; rot:[number,number,number]; wide:number; tall:number }) => (
          <group position={pos} rotation={rot}>
            {/* Wall cutout filler — same colour as wall, sits BEHIND the frame to kill z-fighting */}
            <mesh position={[0, 0, -OWT/2 + 0.001]}>
              <boxGeometry args={[wide + 0.22, tall + 0.22, OWT]}/>
              <meshStandardMaterial color="#dde8ee" roughness={0.65}/>
            </mesh>
            {/* Outer white PVC frame — flush with outer wall face (z≈0) */}
            <mesh position={[0, 0, 0.026]}>
              <boxGeometry args={[wide + 0.18, tall + 0.18, 0.05]}/>
              <meshStandardMaterial color="#f0f4f4" roughness={0.25} metalness={0.05}/>
            </mesh>
            {/* Blue reflective glass — recessed 3cm behind frame */}
            <mesh position={[0, 0, 0.01]}>
              <boxGeometry args={[wide - 0.02, tall - 0.02, 0.05]}/>
              <meshStandardMaterial
                color="#40b8f0"
                transparent opacity={0.65}
                metalness={0.92} roughness={0.02}
                emissive="#0a4a88" emissiveIntensity={0.4}
              />
            </mesh>
            {/* Vertical glazing bar */}
            <mesh position={[0, 0, 0.04]}>
              <boxGeometry args={[0.04, tall - 0.04, 0.025]}/>
              <meshStandardMaterial color="#d0e4ee" roughness={0.2} metalness={0.2}/>
            </mesh>
            {/* Horizontal glazing bar */}
            <mesh position={[0, 0, 0.04]}>
              <boxGeometry args={[wide - 0.04, 0.04, 0.025]}/>
              <meshStandardMaterial color="#d0e4ee" roughness={0.2} metalness={0.2}/>
            </mesh>
            {/* Stone sill — protruding below */}
            <mesh position={[0, -(tall/2 + 0.08), 0.12]}>
              <boxGeometry args={[wide + 0.36, 0.12, 0.26]}/>
              <meshStandardMaterial color="#b8c8c4" roughness={0.75}/>
            </mesh>
            {/* Lintel above */}
            <mesh position={[0, (tall/2 + 0.07), 0.08]}>
              <boxGeometry args={[wide + 0.26, 0.10, 0.20]}/>
              <meshStandardMaterial color="#b8c8c4" roughness={0.75}/>
            </mesh>
          </group>
        );

        return (
          <group key={`win-${idx}`}>
            {isTopRow && (
              <WindowUnit
                pos={[rx, winY, offZ - wallFace]}
                rot={[0, Math.PI, 0]}
                wide={ww} tall={wh}
              />
            )}
            {isBotRow && (
              <WindowUnit
                pos={[rx, winY, offZ + totalD + wallFace]}
                rot={[0, 0, 0]}
                wide={ww} tall={wh}
              />
            )}
            {isLeftCol && (
              <WindowUnit
                pos={[offX - wallFace, winY, rz]}
                rot={[0, Math.PI/2, 0]}
                wide={Math.min(ph*0.40, 1.2)} tall={wh}
              />
            )}
            {isRightCol && (
              <WindowUnit
                pos={[offX + totalW + wallFace, winY, rz]}
                rot={[0, -Math.PI/2, 0]}
                wide={Math.min(ph*0.40, 1.2)} tall={wh}
              />
            )}
          </group>
        );
      })}

      {/* ── INTERIOR WALL DIVIDERS ──────────────────────────────────────── */}
      {laid.map(({ px, py, pw, ph }, idx) => {
        const roomRight = px + pw < totalW - 0.01;
        const roomBottom = py + ph < totalD - 0.01;
        const rx = offX + px + pw; const rz = offZ + py + ph;
        return (
          <group key={`iw-${idx}`}>
            {/* Vertical divider (right edge of room) */}
            {roomRight && (
              <mesh position={[rx, FH/2, offZ + py + ph/2]} castShadow>
                <boxGeometry args={[IWT, FH, ph]} />
                <primitive object={intWallMat} />
              </mesh>
            )}
            {/* Horizontal divider (bottom edge of room) */}
            {roomBottom && (
              <mesh position={[offX + px + pw/2, FH/2, rz]} castShadow>
                <boxGeometry args={[pw, FH, IWT]} />
                <primitive object={intWallMat} />
              </mesh>
            )}
          </group>
        );
      })}

      {/* ── DOOR OPENINGS cut in interior walls ─────────────────────────── */}
      {/* We approximate door openings by placing a slightly recessed dark panel in the wall */}
      {laid.map(({ px, py, pw, ph }, idx) => {
        const roomBottom = py + ph < totalD - 0.01;
        const roomRight  = px + pw < totalW - 0.01 && idx % 3 === 1;
        const rz = offZ + py + ph; const rx = offX + px + pw;
        const dw = Math.min(pw * 0.35, 0.85); const dh = FH * 0.72;
        const dw2 = Math.min(ph * 0.32, 0.8);
        return (
          <group key={`door-${idx}`}>
            {roomBottom && (
              <mesh position={[offX + px + pw/2, dh/2, rz]}>
                <boxGeometry args={[dw, dh, IWT + 0.04]} />
                <meshStandardMaterial color="#1a2530" roughness={0.9} />
              </mesh>
            )}
            {roomRight && (
              <mesh position={[rx, dh/2, offZ + py + ph/2]}>
                <boxGeometry args={[IWT + 0.04, dh, dw2]} />
                <meshStandardMaterial color="#1a2530" roughness={0.9} />
              </mesh>
            )}
          </group>
        );
      })}

      {/* ── FLOORS + FURNITURE + LABELS ─────────────────────────────────── */}
      {laid.map(({ room, px, py, pw, ph }, idx) => {
        const t = room.type?.toLowerCase() ?? "";
        const accent = getAccent(t);
        const floorColor = t.includes("bathroom") ? "#2a3a3a" : t.includes("kitchen") ? "#1e2e2e" : "#1a2828";
        const rx = offX + px + pw/2; const rz = offZ + py + ph/2;
        return (
          <group key={`room-${idx}`} position={[rx, 0, rz]}>
            {/* Floor — selectable */}
            <mesh position={[0, 0.06, 0]} receiveShadow
              onClick={(e:any)=>{e.stopPropagation();onSelect?.({id:`floor-${idx}`,label:`${t.toUpperCase()} Floor`,type:"floor",color:colorOverrides?.[`floor-${idx}`]??floorColor});}}
              onPointerOver={(e:any)=>{e.stopPropagation();document.body.style.cursor=editMode?"pointer":"auto";}}
              onPointerOut={(e:any)=>{e.stopPropagation();document.body.style.cursor="auto";}}>
              <boxGeometry args={[pw - IWT, 0.12, ph - IWT]} />
              <meshStandardMaterial color={colorOverrides?.[`floor-${idx}`]??floorColor} roughness={0.9}
                emissive={selectedId===`floor-${idx}`?"#002244":"#000000"} emissiveIntensity={selectedId===`floor-${idx}`?0.4:0}/>
            </mesh>
            {/* Tint overlay */}
            <mesh position={[0, 0.14, 0]} rotation={[-Math.PI/2,0,0]}>
              <planeGeometry args={[pw - IWT - 0.2, ph - IWT - 0.2]} />
              <meshStandardMaterial color={accent} transparent opacity={0.06} roughness={1} />
            </mesh>
            {/* Room label */}
            <Text position={[0, 1.2, 0]} color={accent}
              fontSize={Math.min(0.28, pw * 0.07)} anchorX="center" anchorY="middle">
              {t.toUpperCase().replace(/_/g," ").replace(/[0-9]/g,"").trim() || "ROOM"}
            </Text>
            {/* Furniture */}
            <Furniture type={t} w={pw - IWT*2} d={ph - IWT*2} />
          </group>
        );
      })}


      {/* ── OVERLAYS ────────────────────────────────────────────────────── */}
      {showSun && <SunSphere dir={windDir} lat={0} />}
      {showWind && <WindSwirl dir={windDir} cx={cx} cz={cz} modelW={totalW} modelD={totalD} />}
    </group>
  );
}

// ── Ground + lawn ─────────────────────────────────────────────────────────────
function Ground({ showGrid }: { showGrid: boolean }) {
  return (
    <>
      <mesh rotation={[-Math.PI/2,0,0]} position={[0,-0.23,0]} receiveShadow>
        <planeGeometry args={[100,100]} />
        <meshStandardMaterial color="#141e14" roughness={0.97} />
      </mesh>
      <mesh rotation={[-Math.PI/2,0,0]} position={[0,-0.22,0]} receiveShadow>
        <planeGeometry args={[30,30]} />
        <meshStandardMaterial color="#1a2a18" roughness={0.96} />
      </mesh>
      {showGrid && <gridHelper args={[100,100,"#0a2020","#091a19"]} position={[0,-0.21,0]} />}
    </>
  );
}

// ── Room legend ───────────────────────────────────────────────────────────────
function RoomLegend({ rooms }: { rooms: any[] }) {
  const counts: Record<string,number> = {};
  rooms.forEach(r => { const k=(r.type??"room").toLowerCase(); counts[k]=(counts[k]??0)+1; });
  return (
    <div style={{position:"absolute",bottom:16,left:"50%",transform:"translateX(-50%)",display:"flex",gap:8,padding:"8px 16px",background:"rgba(6,14,14,0.93)",borderRadius:8,border:"1px solid rgba(13,242,242,0.1)",flexWrap:"wrap",justifyContent:"center",maxWidth:"90vw"}}>
      <div style={{color:"rgba(13,242,242,0.4)",fontSize:9,fontFamily:"monospace",textTransform:"uppercase",letterSpacing:"0.12em",alignSelf:"center",marginRight:4,flexShrink:0}}>LEGEND</div>
      {Object.entries(counts).map(([type, count]) => (
        <div key={type} style={{display:"flex",alignItems:"center",gap:4}}>
          <span style={{width:10,height:10,borderRadius:2,background:ACCENTS[type]??ACCENTS.living,display:"inline-block",flexShrink:0}}/>
          <span style={{color:"#94a3b8",fontSize:10,fontFamily:"monospace",whiteSpace:"nowrap"}}>
            {type.charAt(0).toUpperCase()+type.slice(1)}{count>1?` ×${count}`:""}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function Model3DPage() {
  const params = useParams();
  const plotId = params.id as string;
  const { floorPlan, analysis } = useEco3DStore();
  const rooms = floorPlan?.layout ?? [];
  const windDir = analysis?.environmental?.wind_direction ?? "NW";
  const sunHours = analysis?.environmental?.sun_exposure_hours ?? 8.2;
  const totalArea = floorPlan?.total_area ?? rooms.reduce((s,r)=>s+(r.width??4)*(r.height??4),0);

  const [showWind, setShowWind] = useState(false);
  const [showSun,  setShowSun]  = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [nightLight, setNightLight] = useState(false);
  const autoNight = (() => { const h = new Date().getHours(); return h < 6 || h > 19; })();
  const [camMode,  setCamMode]  = useState<"iso"|"top"|"interior">("iso");
  // Edit mode
  const [editMode, setEditMode] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [colorOverrides, setColorOverrides] = useState<Record<string,string>>({});
  const [selectedInfo, setSelectedInfo] = useState<{id:string;label:string;color:string;type:string}|null>(null);
  // Client-only time — prevents SSR hydration mismatch
  const [timeStr, setTimeStr] = useState("");
  useEffect(() => {
    const update = () => setTimeStr(new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}));
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, []);
  const [fps, setFps] = useState(0);

  const handleExportBIM = () => {
    const bimData = {
      meta: { version: "1.0", platform: "ECO-3D", exported: new Date().toISOString(), plot_id: plotId },
      building: {
        total_area_m2: totalArea,
        floors: [...new Set(rooms.map(r => r.floor ?? 1))].length,
        eco_scores: {
          fitness: floorPlan?.fitness_score ?? 0,
          sunlight: floorPlan?.sunlight_score ?? 0,
          ventilation: floorPlan?.ventilation_score ?? 0,
          trees_preserved: floorPlan?.tree_preserved_count ?? 0,
        },
        environmental: { wind_direction: windDir, sun_hours: sunHours },
      },
      rooms: rooms.map(r => ({
        id: r.type, type: r.type,
        dimensions_m: { width: r.width, depth: r.height },
        position_m: { x: r.x, y: r.y },
        floor: r.floor, orientation: r.orientation,
        area_m2: parseFloat((r.width * r.height).toFixed(2)),
      })),
    };
    const blob = new Blob([JSON.stringify(bimData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ECO3D_BIM_${plotId}_${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const handleExportGLTF = () => {
    // Export as a simple OBJ-like text for room geometry
    let obj = `# ECO-3D Floor Plan Export\n# Plot: ${plotId}\n# Rooms: ${rooms.length}\n\n`;
    rooms.forEach((r, i) => {
      obj += `# Room ${i+1}: ${r.type}\n`;
      obj += `# Dimensions: ${r.width}m x ${r.height}m\n`;
      obj += `# Position: (${r.x}, ${r.y})\n`;
      obj += `# Floor: ${r.floor}, Orientation: ${r.orientation}\n\n`;
    });
    const blob = new Blob([obj], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ECO3D_${plotId}.obj`;
    a.click(); URL.revokeObjectURL(url);
  };

  useEffect(()=>{
    let frames=0; let last=performance.now();
    const id=setInterval(()=>{
      const now=performance.now(); frames++;
      if(now-last>1000){setFps(Math.round(frames*1000/(now-last)));frames=0;last=now;}
    },120);
    return()=>clearInterval(id);
  },[]);

  const camConfigs = {
    iso:      { pos:[18,15,18] as [number,number,number], fov:46 },
    top:      { pos:[0,28,0]   as [number,number,number], fov:52 },
    interior: { pos:[2,2.4,2]  as [number,number,number], fov:70 },
  };
  const cam = camConfigs[camMode];

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet"/>
      <div style={{width:"100vw",height:"100vh",background:"#060e0e",display:"flex",flexDirection:"column",fontFamily:"'Space Grotesk',sans-serif",overflow:"hidden"}}>

        {/* Nav */}
        <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 24px",background:"rgba(6,12,12,0.98)",borderBottom:"1px solid rgba(255,255,255,0.05)",flexShrink:0}}>
          <Link href="/" style={{display:"flex",alignItems:"center",gap:10,textDecoration:"none"}}>
            <span className="material-symbols-outlined" style={{color:"#0df2f2",fontSize:22}}>deployed_code</span>
            <div>
              <div style={{color:"white",fontWeight:700,fontSize:15}}>ECO-3D <span style={{color:"rgba(13,242,242,0.5)",fontWeight:300}}>Studio</span></div>
              <div style={{fontSize:9,color:"#475569",textTransform:"uppercase",letterSpacing:"0.15em"}}>AI GENERATIVE ARCHITECTURE</div>
            </div>
          </Link>
          <nav style={{display:"flex",gap:4}}>
            {[
              {l:"Blueprint Generator", h:`/analysis/${plotId}`},
              {l:"Environmental Data",  h:`/environment/${plotId}`},
              {l:"3D Model",            h:`/model3d/${plotId}`, a:true},
              {l:"Export",              h:`/report/${plotId}`},
            ].map(item=>(
              <Link key={item.l} href={item.h} style={{padding:"8px 16px",fontSize:12,fontWeight:500,textDecoration:"none",color:(item as any).a?"#0df2f2":"#64748b",borderBottom:(item as any).a?"2px solid #0df2f2":"2px solid transparent"}}>
                {item.l}
              </Link>
            ))}
          </nav>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setEditMode((p:boolean)=>!p)}
              style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:editMode?"rgba(13,242,242,0.15)":"rgba(13,242,242,0.06)",border:`1px solid ${editMode?"rgba(13,242,242,0.5)":"rgba(13,242,242,0.15)"}`,borderRadius:8,color:editMode?"#0df2f2":"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>
              <span className="material-symbols-outlined" style={{fontSize:14}}>edit</span>
              {editMode ? "EDITING" : "EDIT MODE"}
            </button>
            <button onClick={handleExportGLTF} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:"rgba(13,242,242,0.06)",border:"1px solid rgba(13,242,242,0.15)",borderRadius:8,color:"#0df2f2",fontSize:11,fontWeight:700,cursor:"pointer"}}>
              <span className="material-symbols-outlined" style={{fontSize:14}}>upload</span>IMPORT BIM
            </button>
            <button onClick={handleExportBIM} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:"#0df2f2",borderRadius:8,color:"#060e0e",fontSize:11,fontWeight:700,cursor:"pointer",border:"none"}}>
              <span className="material-symbols-outlined" style={{fontSize:14}}>download</span>EXPORT BIM
            </button>
          </div>
        </header>

        <div style={{display:"flex",flex:1,overflow:"hidden"}}>
          {/* Left panel */}
          <div style={{width:148,flexShrink:0,background:"rgba(6,10,10,0.98)",padding:"14px 12px",display:"flex",flexDirection:"column",gap:10,borderRight:"1px solid rgba(255,255,255,0.05)",overflowY:"auto"}}>
            {[
              {l:"Sunlight Direction", v:`${windDir} — ${sunHours.toFixed(1)}h/day`},
              {l:"Wind Direction",     v:`Prevailing ${windDir}`},
              {l:"Floor Plan",         v:`${rooms.filter(r=>(r.floor??1)===1).length} Rooms · ${totalArea.toFixed(0)}m²`},
            ].map(({l,v})=>(
              <div key={l} style={{background:"rgba(13,242,242,0.04)",border:"1px solid rgba(13,242,242,0.1)",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:9,color:"rgba(13,242,242,0.45)",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:4}}>{l}</div>
                <div style={{fontSize:11,color:"white",fontWeight:600,lineHeight:1.5}}>{v}</div>
              </div>
            ))}

            {/* Camera modes */}
            <div style={{background:"rgba(13,242,242,0.04)",border:"1px solid rgba(13,242,242,0.1)",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:9,color:"rgba(13,242,242,0.45)",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:8}}>Camera View</div>
              {([["iso","Isometric"],["top","Top-Down"],["interior","Interior"]] as const).map(([v,l])=>(
                <button key={v} onClick={()=>setCamMode(v)} style={{display:"block",width:"100%",padding:"5px 8px",marginBottom:4,background:camMode===v?"rgba(13,242,242,0.15)":"transparent",border:`1px solid ${camMode===v?"rgba(13,242,242,0.3)":"rgba(255,255,255,0.06)"}`,borderRadius:5,color:camMode===v?"#0df2f2":"#64748b",fontSize:10,cursor:"pointer",textAlign:"left",fontFamily:"'Space Grotesk',sans-serif"}}>
                  {l}
                </button>
              ))}
            </div>

            <div style={{marginTop:"auto",background:"rgba(13,242,242,0.04)",border:"1px solid rgba(13,242,242,0.1)",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:9,color:"rgba(13,242,242,0.45)",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:6}}>Rendering</div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:"#0df2f2",flexShrink:0}}/>
                <span style={{fontSize:11,color:"white",fontWeight:600}}>Three.js WebGL</span>
              </div>
              <div style={{fontSize:10,color:"#64748b"}}>{fps} FPS · {rooms.length} rooms</div>
            </div>
          </div>

          {/* 3D Viewport */}
          <div style={{flex:1,position:"relative"}}>
            <ThreeErrorBoundary>
              <Canvas
                shadows={{ type: THREE.PCFSoftShadowMap, enabled: true }}
                camera={{position:cam.pos, fov:cam.fov, near:0.1, far:250}}
                style={{background:"linear-gradient(160deg,#0c1e1e 0%,#060e0e 100%)"}}
                gl={{antialias:true, alpha:false, powerPreference:"high-performance", toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2}}
                dpr={[1, 2]}
                key={camMode}
              >
                <Suspense fallback={null}>
                  <Lighting dir={windDir} sunOn={showSun} nightLightOn={nightLight} />
                  <Ground showGrid={showGrid} />
                  <UnifiedHouse rooms={rooms} showWind={showWind} showSun={showSun} windDir={windDir} editMode={editMode} selectedId={selectedId} colorOverrides={colorOverrides} onSelect={(info:any)=>{if(editMode){setSelectedId(info.id);setSelectedInfo(info);}}} />
                  <OrbitControls
                    enablePan enableZoom enableRotate
                    target={[0,1.5,0]}
                    minPolarAngle={0.05} maxPolarAngle={Math.PI/2.05}
                    minDistance={3} maxDistance={90}
                  />
                </Suspense>
              </Canvas>
            </ThreeErrorBoundary>

            {/* Right toolbar */}
            <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",display:"flex",flexDirection:"column",gap:6}}>
              {[
                {l:"WIND",  i:"air",        active:showWind,             fn:()=>setShowWind(!showWind)},
                {l:"SUN",   i:"wb_sunny",   active:showSun,              fn:()=>setShowSun(!showSun)},
                {l:"LIGHT", i:"lightbulb",  active:nightLight, fn:()=>setNightLight(p=>!p)},
                {l:"GRID",  i:"grid_on",    active:showGrid,             fn:()=>setShowGrid(!showGrid)},
              ].map(({l,i,active,fn})=>(
                <button key={l} onClick={fn} style={{width:44,height:44,background:active?"rgba(13,242,242,0.15)":"rgba(6,14,14,0.92)",border:`1px solid ${active?"rgba(13,242,242,0.4)":"rgba(255,255,255,0.06)"}`,borderRadius:8,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,cursor:"pointer",transition:"all 0.2s"}}>
                  <span className="material-symbols-outlined" style={{fontSize:16,color:active?"#0df2f2":"#475569"}}>{i}</span>
                  <span style={{fontSize:6,color:active?"#0df2f2":"#334155",fontFamily:"monospace",letterSpacing:"0.06em"}}>{l}</span>
                </button>
              ))}
            </div>

            {/* Active overlays HUD */}
            <div style={{position:"absolute",top:12,left:12,display:"flex",flexDirection:"column",gap:6}}>
              {showSun&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"rgba(245,158,11,0.12)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:8}}>
                  <span className="material-symbols-outlined" style={{fontSize:14,color:"#f59e0b"}}>wb_sunny</span>
                  <span style={{fontSize:10,color:"#fbbf24",fontFamily:"monospace"}}>SUN: {windDir} · {sunHours.toFixed(1)}h/day · {timeStr}</span>
                </div>
              )}
              {showWind&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:8}}>
                  <span className="material-symbols-outlined" style={{fontSize:14,color:"#60a5fa"}}>air</span>
                  <span style={{fontSize:10,color:"#93c5fd",fontFamily:"monospace"}}>WIND: Prevailing {windDir}</span>
                </div>
              )}
              {nightLight&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"rgba(250,230,50,0.10)",border:"1px solid rgba(250,230,50,0.25)",borderRadius:8}}>
                  <span className="material-symbols-outlined" style={{fontSize:14,color:"#fde047"}}>lightbulb</span>
                  <span style={{fontSize:10,color:"#fef08a",fontFamily:"monospace"}}>Studio Lighting ON</span>
                </div>
              )}
              {!nightLight&&autoNight&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"rgba(80,100,200,0.10)",border:"1px solid rgba(80,100,200,0.25)",borderRadius:8}}>
                  <span className="material-symbols-outlined" style={{fontSize:14,color:"#818cf8"}}>nights_stay</span>
                  <span style={{fontSize:10,color:"#a5b4fc",fontFamily:"monospace"}}>Night Mode — press LIGHT for studio</span>
                </div>
              )}
            </div>

            {/* Compass */}
            <div style={{position:"absolute",top:12,right:66,width:34,height:34}}>
              <svg width="34" height="34">
                <circle cx="17" cy="17" r="15" fill="rgba(6,14,14,0.9)" stroke="rgba(13,242,242,0.2)" strokeWidth="1"/>
                <polygon points="17,4 21,17 17,15 13,17" fill="#0df2f2"/>
                <polygon points="17,30 13,17 17,19 21,17" fill="#334155"/>
                <text x="17" y="11" textAnchor="middle" fill="#0df2f2" fontSize="6" fontFamily="monospace" fontWeight="bold">N</text>
              </svg>
            </div>

            {/* Hint */}
            <div style={{position:"absolute",bottom:48,right:66,fontSize:10,fontFamily:"monospace",color:"#334155",textAlign:"right",lineHeight:1.6}}>
              Drag to orbit<br/>Scroll to zoom<br/>Right-drag to pan
            </div>

            {/* Colour editor panel — shows when editMode is on and something is selected */}
            {editMode && selectedInfo && (
              <div style={{position:"absolute",bottom:60,right:60,width:210,background:"rgba(6,12,16,0.97)",border:"1px solid rgba(13,242,242,0.3)",borderRadius:12,padding:16,fontFamily:"'Space Grotesk',sans-serif",boxShadow:"0 8px 32px rgba(0,0,0,0.7)",zIndex:200}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{color:"#0df2f2",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em"}}>{selectedInfo.label}</div>
                  <button onClick={()=>{setSelectedId("");setSelectedInfo(null);}} style={{background:"none",border:"none",color:"#475569",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
                </div>
                <div style={{fontSize:9,color:"rgba(13,242,242,0.5)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Wall / Surface Colour</div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <input type="color" value={(colorOverrides[selectedInfo.id]??selectedInfo.color)?.replace(/[^#0-9a-fA-F]/g,"")||"#dde8ee"}
                    onChange={e=>{const c=e.target.value;setColorOverrides((p:any)=>({...p,[selectedInfo.id]:c}));}}
                    style={{width:44,height:32,border:"none",borderRadius:6,cursor:"pointer",background:"none"}}/>
                  <span style={{color:"#94a3b8",fontSize:11,fontFamily:"monospace"}}>{colorOverrides[selectedInfo.id]??selectedInfo.color}</span>
                </div>
                <div style={{fontSize:9,color:"rgba(13,242,242,0.5)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Preset Colours</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:12}}>
                  {["#dde8ee","#f5f0e8","#e8d4c0","#c8dde8","#e0e8d0","#f0e4d0","#d8d0e8","#2a3a4a","#e8c07a","#c0d8c0"].map(c=>(
                    <button key={c} onClick={()=>setColorOverrides((p:any)=>({...p,[selectedInfo.id]:c}))}
                      style={{width:22,height:22,background:c,border:(colorOverrides[selectedInfo.id]??selectedInfo.color)===c?"2px solid #0df2f2":"2px solid transparent",borderRadius:4,cursor:"pointer"}}/>
                  ))}
                </div>
                <div style={{fontSize:9,color:"rgba(13,242,242,0.5)",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6}}>Material</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:10}}>
                  {["Standard","Metallic","Matte","Concrete"].map(m=>(
                    <button key={m} style={{padding:"4px 6px",fontSize:9,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:5,color:"#64748b",cursor:"pointer",fontFamily:"monospace"}} onClick={()=>{}}>{m}</button>
                  ))}
                </div>
                <button onClick={()=>setColorOverrides((p:any)=>{const n={...p};delete n[selectedInfo.id];return n;})}
                  style={{width:"100%",padding:"5px",background:"rgba(255,80,80,0.1)",border:"1px solid rgba(255,80,80,0.2)",borderRadius:6,color:"#ff8080",fontSize:9,cursor:"pointer",fontFamily:"monospace",textTransform:"uppercase"}}>
                  Reset to Default
                </button>
              </div>
            )}

            {/* Edit mode tip in left corner */}
            {editMode && !selectedInfo && (
              <div style={{position:"absolute",bottom:60,left:160,padding:"8px 14px",background:"rgba(13,242,242,0.08)",border:"1px solid rgba(13,242,242,0.2)",borderRadius:8,fontSize:10,color:"#0df2f2",fontFamily:"monospace"}}>
                ✏ Click any wall, window, or floor to change its colour
              </div>
            )}

            <RoomLegend rooms={rooms} />
          </div>
        </div>
      </div>
    </>
  );
}
