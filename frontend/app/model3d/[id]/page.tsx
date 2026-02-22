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
function Lighting({ dir, sunOn }: { dir: string; sunOn: boolean }) {
  const P: Record<string,[number,number,number]> = {
    N:[0,15,-14],NE:[10,15,-10],E:[15,15,0],SE:[10,15,10],
    S:[0,15,14],SW:[-10,15,10],W:[-15,15,0],NW:[-10,15,-10],
  };
  const pos = P[dir.slice(0,2)] ?? P["SE"];
  return (
    <>
      <ambientLight intensity={sunOn ? 0.6 : 1.0} color="#e8f4ff" />
      <hemisphereLight args={["#c8e4ff","#182020", 0.4]} />
      {sunOn
        ? <directionalLight position={pos} intensity={2.8} castShadow color="#fff5d0"
            shadow-mapSize-width={2048} shadow-mapSize-height={2048}
            shadow-camera-near={0.5} shadow-camera-far={120}
            shadow-camera-left={-35} shadow-camera-right={35}
            shadow-camera-top={35} shadow-camera-bottom={-35} />
        : <>
            <pointLight position={[0,14,0]} intensity={2.2} color="#ffffff" />
            <pointLight position={[-10,8,-10]} intensity={0.7} color="#c8d8ff" />
            <pointLight position={[10,8,10]} intensity={0.7} color="#ffd8c8" />
          </>
      }
    </>
  );
}

// ── Sun sphere ────────────────────────────────────────────────────────────────
function SunSphere({ dir }: { dir: string }) {
  const P: Record<string,[number,number,number]> = {
    N:[0,15,-14],NE:[10,15,-10],E:[15,15,0],SE:[10,15,10],
    S:[0,15,14],SW:[-10,15,10],W:[-15,15,0],NW:[-10,15,-10],
  };
  const pos = P[dir.slice(0,2)] ?? P["SE"];
  const ringRef = useRef<THREE.Mesh>(null);
  useFrame((s) => { if (ringRef.current) ringRef.current.rotation.z = s.clock.elapsedTime * 0.6; });
  return (
    <group position={pos}>
      <mesh><sphereGeometry args={[0.55,16,16]} /><meshStandardMaterial color="#fcd34d" emissive="#f59e0b" emissiveIntensity={1.5} /></mesh>
      <mesh ref={ringRef}><torusGeometry args={[0.85, 0.05, 8, 32]} /><meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={1.2} /></mesh>
      <pointLight intensity={3.5} color="#fcd34d" distance={50} />
    </group>
  );
}

// ── Wind arrows ───────────────────────────────────────────────────────────────
function WindArrows({ dir, cx, cz }: { dir: string; cx: number; cz: number }) {
  const ref = useRef<THREE.Group>(null);
  const t = useRef(0);
  const v = useMemo(() => {
    const M: Record<string,[number,number]> = { N:[0,1],NE:[-1,1],E:[-1,0],SE:[-1,-1],S:[0,-1],SW:[1,-1],W:[1,0],NW:[1,1] };
    const k = Object.keys(M).find(k => dir.startsWith(k)) ?? "NW";
    const [x,z] = M[k]; const l = Math.sqrt(x*x+z*z);
    return { x:x/l, z:z/l };
  }, [dir]);

  useFrame((_, dt) => {
    t.current = (t.current + dt * 0.9) % 3;
    ref.current?.children.forEach((c, i) => {
      const off = (t.current + i * 0.55) % 3 - 1.5;
      c.position.set(cx + v.x * off * 6 + (i % 3 - 1) * 1.8, 0.5, cz + v.z * off * 6 + (Math.floor(i / 3) - 1) * 1.8);
      const fade = 1 - Math.abs(off) / 1.5;
      ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = Math.max(0, fade * 0.65);
    });
  });
  const angle = Math.atan2(v.z, v.x) + Math.PI/2;
  return (
    <group ref={ref}>
      {Array.from({length:9}).map((_,i) => (
        <mesh key={i} position={[cx,0.5,cz]} rotation={[0, angle, 0]}>
          <coneGeometry args={[0.12,0.45,6]} />
          <meshStandardMaterial color="#3b82f6" transparent opacity={0.5} />
        </mesh>
      ))}
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
function UnifiedHouse({ rooms, showWind, showSun, windDir }: {
  rooms: any[]; showWind: boolean; showSun: boolean; windDir: string;
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
  const wallMat    = useMemo(() => new THREE.MeshStandardMaterial({color:"#d8e2e8",roughness:0.82}),[]);
  const intWallMat = useMemo(() => new THREE.MeshStandardMaterial({color:"#c8d4da",roughness:0.85}),[]);
  const foundMat   = useMemo(() => new THREE.MeshStandardMaterial({color:"#3a4a4a",roughness:0.9}),[]);

  return (
    <group>
      {/* ── FOUNDATION SLAB ─────────────────────────────────────────────── */}
      <mesh position={[cx, -0.12, cz]} receiveShadow>
        <boxGeometry args={[totalW + OWT*2 + 0.4, 0.22, totalD + OWT*2 + 0.4]} />
        <primitive object={foundMat} />
      </mesh>

      {/* ── OUTER PERIMETER WALLS (4 sides, full FH) ─────────────────────── */}
      {/* North wall */}
      <mesh position={[cx, FH/2, offZ - OWT/2]} castShadow receiveShadow>
        <boxGeometry args={[totalW + OWT*2, FH, OWT]} />
        <primitive object={wallMat} />
      </mesh>
      {/* South wall */}
      <mesh position={[cx, FH/2, offZ + totalD + OWT/2]} castShadow receiveShadow>
        <boxGeometry args={[totalW + OWT*2, FH, OWT]} />
        <primitive object={wallMat} />
      </mesh>
      {/* West wall */}
      <mesh position={[offX - OWT/2, FH/2, cz]} castShadow receiveShadow>
        <boxGeometry args={[OWT, FH, totalD + OWT*2]} />
        <primitive object={wallMat} />
      </mesh>
      {/* East wall */}
      <mesh position={[offX + totalW + OWT/2, FH/2, cz]} castShadow receiveShadow>
        <boxGeometry args={[OWT, FH, totalD + OWT*2]} />
        <primitive object={wallMat} />
      </mesh>

      {/* ── WINDOWS on outer walls ──────────────────────────────────────── */}
      {laid.map(({ room, px, py, pw, ph }, idx) => {
        const t = room.type?.toLowerCase() ?? "";
        if (t.includes("bathroom")||t.includes("utility")) return null;
        const rx = offX + px + pw/2; const rz = offZ + py + ph/2;
        const ww = Math.min(pw*0.42, 1.4); const wh = FH*0.36;
        const isTopRow = py < 0.1;
        const isBotRow = py + ph > totalD - 0.1;
        const isLeftCol = px < 0.1;
        const isRightCol = px + pw > totalW - 0.1;
        return (
          <group key={`win-${idx}`}>
            {isTopRow && (
              <group position={[rx, FH*0.55, offZ]}>
                <mesh><boxGeometry args={[ww, wh, OWT+0.02]}/><meshStandardMaterial color="#88ccee" transparent opacity={0.45} metalness={0.9} roughness={0}/></mesh>
                <mesh><boxGeometry args={[ww+0.06, wh+0.06, OWT-0.02]}/><meshStandardMaterial color="#b8ccd8" metalness={0.3} roughness={0.4}/></mesh>
              </group>
            )}
            {isBotRow && (
              <group position={[rx, FH*0.55, offZ+totalD]}>
                <mesh><boxGeometry args={[ww, wh, OWT+0.02]}/><meshStandardMaterial color="#88ccee" transparent opacity={0.45} metalness={0.9} roughness={0}/></mesh>
                <mesh><boxGeometry args={[ww+0.06, wh+0.06, OWT-0.02]}/><meshStandardMaterial color="#b8ccd8" metalness={0.3} roughness={0.4}/></mesh>
              </group>
            )}
            {isLeftCol && (
              <group position={[offX, FH*0.55, rz]}>
                <mesh><boxGeometry args={[OWT+0.02, wh, Math.min(ph*0.38,1.2)]}/><meshStandardMaterial color="#88ccee" transparent opacity={0.45} metalness={0.9} roughness={0}/></mesh>
                <mesh><boxGeometry args={[OWT-0.02, wh+0.06, Math.min(ph*0.38,1.2)+0.06]}/><meshStandardMaterial color="#b8ccd8" metalness={0.3} roughness={0.4}/></mesh>
              </group>
            )}
            {isRightCol && (
              <group position={[offX+totalW, FH*0.55, rz]}>
                <mesh><boxGeometry args={[OWT+0.02, wh, Math.min(ph*0.38,1.2)]}/><meshStandardMaterial color="#88ccee" transparent opacity={0.45} metalness={0.9} roughness={0}/></mesh>
                <mesh><boxGeometry args={[OWT-0.02, wh+0.06, Math.min(ph*0.38,1.2)+0.06]}/><meshStandardMaterial color="#b8ccd8" metalness={0.3} roughness={0.4}/></mesh>
              </group>
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
            {/* Floor */}
            <mesh position={[0, 0.06, 0]} receiveShadow>
              <boxGeometry args={[pw - IWT, 0.12, ph - IWT]} />
              <meshStandardMaterial color={floorColor} roughness={0.9} />
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

      {/* ── WALL TOP CAP (crown, shows house boundary clearly) ───────────── */}
      <mesh position={[cx, FH + 0.08, cz]}>
        <boxGeometry args={[totalW + OWT*2 + 0.1, 0.15, totalD + OWT*2 + 0.1]} />
        <meshStandardMaterial color="#0bc8c8" emissive="#0bc8c8" emissiveIntensity={0.06} roughness={0.7} />
      </mesh>

      {/* ── OVERLAYS ────────────────────────────────────────────────────── */}
      {showSun && <SunSphere dir={windDir} />}
      {showWind && <WindArrows dir={windDir} cx={cx} cz={cz} />}
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
  const [camMode,  setCamMode]  = useState<"iso"|"top"|"interior">("iso");
  const [fps, setFps] = useState(0);

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
          <div style={{display:"flex",gap:10}}>
            <button style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:"rgba(13,242,242,0.06)",border:"1px solid rgba(13,242,242,0.15)",borderRadius:8,color:"#0df2f2",fontSize:11,fontWeight:700,cursor:"pointer"}}>
              <span className="material-symbols-outlined" style={{fontSize:14}}>upload</span>IMPORT BIM
            </button>
            <button style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:"#0df2f2",borderRadius:8,color:"#060e0e",fontSize:11,fontWeight:700,cursor:"pointer",border:"none"}}>
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
                shadows
                camera={{position:cam.pos, fov:cam.fov, near:0.1, far:250}}
                style={{background:"linear-gradient(160deg,#0c1e1e 0%,#060e0e 100%)"}}
                gl={{antialias:true,alpha:false}}
                key={camMode}
              >
                <Suspense fallback={null}>
                  <Lighting dir={windDir} sunOn={showSun} />
                  <Ground showGrid={showGrid} />
                  <UnifiedHouse rooms={rooms} showWind={showWind} showSun={showSun} windDir={windDir} />
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
                {l:"WIND", i:"air",      active:showWind, fn:()=>setShowWind(!showWind)},
                {l:"SUN",  i:"wb_sunny", active:showSun,  fn:()=>setShowSun(!showSun)},
                {l:"GRID", i:"grid_on",  active:showGrid, fn:()=>setShowGrid(!showGrid)},
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
                  <span style={{fontSize:10,color:"#fbbf24",fontFamily:"monospace"}}>SUN: {windDir} · {sunHours.toFixed(1)}h/day</span>
                </div>
              )}
              {showWind&&(
                <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"rgba(59,130,246,0.12)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:8}}>
                  <span className="material-symbols-outlined" style={{fontSize:14,color:"#60a5fa"}}>air</span>
                  <span style={{fontSize:10,color:"#93c5fd",fontFamily:"monospace"}}>WIND: Prevailing {windDir}</span>
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

            <RoomLegend rooms={rooms} />
          </div>
        </div>
      </div>
    </>
  );
}
