"use client";
import { useRef, useMemo, Suspense, useState, useEffect, useLayoutEffect, useCallback, Component } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";

import * as THREE from "three";
import { useEco3DStore } from "@/store/useEco3DStore";

// ─── Constants ────────────────────────────────────────────────────────────────
const NOOP_RAYCAST = () => {};
// Capture ONCE at module level — never null, survives hot-reload
const REAL_RAYCAST = THREE.Mesh.prototype.raycast;
const SNAP = 0.25;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

type TexType = "none" | "brick" | "concrete" | "wood" | "plaster" | "marble" | "tile";
type ObjKind = "object" | "wall" | "room";
type SceneObj = {
  id: string; kind: ObjKind; type: string;
  x: number; y: number; z: number; rotY: number;
  w: number; h: number; d: number;
  color: string; tex?: TexType;
};

// ─── Error Boundary ───────────────────────────────────────────────────────────
class ThreeErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  constructor(p: any) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) return (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#060e0e" }}>
        <div style={{ textAlign: "center", color: "#0df2f2", fontFamily: "monospace" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⬡</div>
          <div style={{ fontSize: 12, marginBottom: 4 }}>3D Error — reloading…</div>
          <div style={{ fontSize: 10, color: "#475569" }}>{this.state.error}</div>
        </div>
      </div>
    );
    return this.props.children;
  }
}

// ─── Texture factory ──────────────────────────────────────────────────────────
function makeTexture(type: TexType, color: string): THREE.CanvasTexture {
  const sz = 256, cv = document.createElement("canvas"); cv.width = sz; cv.height = sz;
  const ctx = cv.getContext("2d")!;
  const c = new THREE.Color(color);
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(0, 0, sz, sz);
  if (type === "brick") {
    const bw = 48, bh = 20, gap = 3;
    for (let row = 0; row * (bh + gap) < sz; row++) {
      const off = row % 2 === 0 ? 0 : bw / 2;
      for (let col = -1; col * (bw + gap) < sz + bw; col++) {
        ctx.fillStyle = `rgba(0,0,0,0.22)`;
        ctx.fillRect(col * (bw + gap) + off + gap, row * (bh + gap) + gap, bw - gap, bh - gap);
      }
    }
  } else if (type === "concrete") {
    for (let i = 0; i < 2000; i++) { const x = Math.random() * sz, y = Math.random() * sz, v = (Math.random() - 0.5) * 30; ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 180})`; ctx.fillRect(x, y, 2, 2); }
  } else if (type === "wood") {
    const grad = ctx.createLinearGradient(0, 0, sz, 0);
    for (let i = 0; i <= 12; i++) { const d = (i % 2 === 0 ? -1 : 1) * 18; grad.addColorStop(i / 12, `rgb(${Math.max(0, Math.min(255, r + d))},${Math.max(0, Math.min(255, g + d))},${Math.max(0, Math.min(255, b + d))})`); }
    ctx.fillStyle = grad; ctx.fillRect(0, 0, sz, sz);
  } else if (type === "marble") {
    for (let i = 0; i < 6; i++) { ctx.strokeStyle = `rgba(255,255,255,0.15)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(Math.random() * sz, 0); ctx.bezierCurveTo(Math.random() * sz, Math.random() * sz, Math.random() * sz, Math.random() * sz, Math.random() * sz, sz); ctx.stroke(); }
  } else if (type === "tile") {
    const ts = 32; ctx.strokeStyle = `rgba(0,0,0,0.3)`; ctx.lineWidth = 2;
    for (let i = 0; i <= sz; i += ts) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, sz); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(sz, i); ctx.stroke(); }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(3, 3);
  return tex;
}

function makeMat(color: string, tex?: TexType, roughness = 0.78) {
  if (!tex || tex === "none") return new THREE.MeshPhysicalMaterial({
    color, roughness, metalness: 0.04,
    clearcoat: 0.08, clearcoatRoughness: 0.4, reflectivity: 0.12,
  });
  const map = makeTexture(tex, color);
  const r = tex === "marble" ? 0.15 : tex === "tile" ? 0.25 : roughness;
  const cc = tex === "marble" ? 0.35 : tex === "tile" ? 0.2 : 0.08;
  return new THREE.MeshPhysicalMaterial({
    color, map, roughness: r, metalness: tex === "marble" ? 0.08 : 0,
    clearcoat: cc, clearcoatRoughness: 1.0 - cc, reflectivity: tex === "marble" ? 0.5 : 0.12,
  });
}

// ─── Lighting ─────────────────────────────────────────────────────────────────
function Lighting({ dir, sunOn, nightLightOn }: { dir: string; sunOn: boolean; nightLightOn: boolean }) {
  const P: Record<string, [number, number, number]> = { N: [0, 15, -14], NE: [10, 15, -10], E: [15, 15, 0], SE: [10, 15, 10], S: [0, 15, 14], SW: [-10, 15, 10], W: [-15, 15, 0], NW: [-10, 15, -10] };
  const pos = P[dir.slice(0, 2)] ?? P["SE"];
  const studioMode = nightLightOn;
  return <>
    <ambientLight intensity={studioMode ? 1.6 : (sunOn ? 0.55 : 0.95)} color={studioMode ? "#ffffff" : "#e8f4ff"} />
    <hemisphereLight args={studioMode ? ["#ffffff","#aabbaa",1.0] : ["#c8e4ff", "#182020", 0.4]} />
    {studioMode && <>
      <directionalLight position={[14, 20, 10]} intensity={2.2} color="#ffffff" castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-camera-left={-32} shadow-camera-right={32} shadow-camera-top={32} shadow-camera-bottom={-32} shadow-camera-near={0.5} shadow-camera-far={100} />
      <directionalLight position={[-12, 15, -8]} intensity={1.2} color="#d8eeff" />
      <directionalLight position={[0, 10, -16]} intensity={0.8} color="#ffeedd" />
      <pointLight position={[0, 6, 0]} intensity={1.0} color="#ffe8cc" distance={40} decay={1.2} />
    </>}
    {!studioMode && sunOn && <directionalLight position={pos} intensity={2.6} castShadow color="#fff5d0" shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-camera-near={0.5} shadow-camera-far={120} shadow-camera-left={-35} shadow-camera-right={35} shadow-camera-top={35} shadow-camera-bottom={-35} />}
    {!studioMode && !sunOn && <><pointLight position={[0, 14, 0]} intensity={2} color="#ffffff" /><pointLight position={[-10, 8, -10]} intensity={0.6} color="#c8d8ff" /><pointLight position={[10, 8, 10]} intensity={0.6} color="#ffd8c8" /></>}
  </>;
}

// ─── Sun Sphere ───────────────────────────────────────────────────────────────
function SunSphere({ dir }: { dir: string }) {
  const sunRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);

  const getSunPos = (): [number, number, number] => {
    const now = new Date();
    const h = now.getHours() + now.getMinutes() / 60;
    const hourAngle = ((h - 12) / 12) * Math.PI;
    const elev = Math.cos(hourAngle) * 0.8;
    const azim = hourAngle;
    const D: Record<string, [number, number]> = {
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
    if (sunRef.current) {
      const np = getSunPos();
      sunRef.current.position.lerp(new THREE.Vector3(...np), 0.002);
    }
  });

  const h = new Date().getHours();
  if (h < 6 || h > 18) return null;

  return (
    <group ref={sunRef} position={pos}>
      <mesh><sphereGeometry args={[0.65, 20, 20]} /><meshStandardMaterial color="#fcd34d" emissive="#f59e0b" emissiveIntensity={2.0} /></mesh>
      <mesh ref={ringRef}><torusGeometry args={[1.0, 0.06, 8, 32]} /><meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={1.5} /></mesh>
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i / 8) * Math.PI * 2;
        return <mesh key={i} position={[Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0]} rotation={[0, 0, a]}>
          <boxGeometry args={[0.5, 0.04, 0.04]} />
          <meshStandardMaterial color="#fcd34d" emissive="#fbbf24" emissiveIntensity={1.5} />
        </mesh>;
      })}
      <pointLight intensity={4.0} color="#fcd34d" distance={60} decay={1.5} />
    </group>
  );
}

// ─── Wind Swirl ───────────────────────────────────────────────────────────────
// Uses imperative buffer setup to avoid R3F bufferAttribute JSX artifact bug
function WindSwirl({ dir, modelW, modelD }: { dir: string; modelW: number; modelD: number }) {
  const v = useMemo(() => {
    const M: Record<string, [number, number]> = {
      N:[0,-1], NNE:[0.38,-0.92], NE:[0.71,-0.71], ENE:[0.92,-0.38],
      E:[1,0],  ESE:[0.92,0.38],  SE:[0.71,0.71],  SSE:[0.38,0.92],
      S:[0,1],  SSW:[-0.38,0.92], SW:[-0.71,0.71], WSW:[-0.92,0.38],
      W:[-1,0], WNW:[-0.92,-0.38],NW:[-0.71,-0.71],NNW:[-0.38,-0.92],
    };
    const k = Object.keys(M).find(k => dir.startsWith(k)) ?? "SW";
    const [x, z] = M[k]; const l = Math.sqrt(x*x+z*z)||1;
    return { x:x/l, z:z/l };
  }, [dir]);
  const perp = useMemo(() => ({ x:-v.z, z:v.x }), [v]);

  const COUNT = 320;
  const spread  = Math.max(modelW, modelD) * 1.5;
  const travelD = Math.max(modelW, modelD) * 2.4;

  const ptsRef  = useRef<THREE.Points>(null!);
  const arrowRef = useRef<THREE.Group>(null!);

  // Particle data — kept in refs to avoid stale closure
  const particles = useRef(Array.from({ length: COUNT }, (_, i) => ({
    lane:   (i/COUNT - 0.5) * spread,
    baseY:  0.4 + (i % 16) * 0.25,
    phase:  (i/COUNT) * Math.PI * 2,
    speed:  0.16 + (i % 11) * 0.018,
    wobble: 0.35 + (i % 7) * 0.12,
    wfreq:  0.7  + (i % 5) * 0.25,
  }))).current;

  // Set up geometry imperatively once on mount
  useEffect(() => {
    if (!ptsRef.current) return;
    const geo = ptsRef.current.geometry;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, COUNT);
  }, []);

  const arrowAngle = Math.atan2(v.x, v.z);

  useFrame(({ clock }) => {
    if (!ptsRef.current) return;
    const T   = clock.elapsedTime;
    const geo = ptsRef.current.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color    as THREE.BufferAttribute;
    if (!pos || !col) return;
    const pa = pos.array as Float32Array;
    const ca = col.array as Float32Array;

    for (let i = 0; i < COUNT; i++) {
      const p = particles[i];
      const t = ((T * p.speed + p.phase) % (Math.PI*2)) / (Math.PI*2);
      const wb = Math.sin(t * Math.PI * p.wfreq * 4 + p.phase) * p.wobble;
      pa[i*3+0] = -v.x*travelD*0.5 + v.x*travelD*t + perp.x*(p.lane+wb);
      pa[i*3+1] =  p.baseY + t*1.0 + Math.sin(t*Math.PI*3 + p.phase)*0.2;
      pa[i*3+2] = -v.z*travelD*0.5 + v.z*travelD*t + perp.z*(p.lane+wb);
      const fade = Math.sin(t * Math.PI);
      const alt  = Math.min(1, pa[i*3+1] / 5);
      ca[i*3+0] = (0.15 + alt*0.55) * fade;
      ca[i*3+1] = (0.82 + alt*0.18) * fade;
      ca[i*3+2] = 1.0 * fade;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    geo.computeBoundingSphere();

    // Arrow bob
    if (arrowRef.current) {
      arrowRef.current.position.y = 8 + Math.sin(T * 1.1) * 0.3;
    }
  });

  return (
    <group>
      <points ref={ptsRef}>
        <bufferGeometry />
        <pointsMaterial size={0.2} vertexColors transparent opacity={0.88} sizeAttenuation depthWrite={false} />
      </points>
      {/* Floating direction arrow — no irregular geometry, just clean meshes */}
      <group ref={arrowRef} position={[0, 8, 0]} rotation={[0, arrowAngle, 0]}>
        {/* Shaft */}
        <mesh position={[0, 0, -1.0]} castShadow>
          <cylinderGeometry args={[0.07, 0.07, 2.0, 8]} />
          <meshStandardMaterial color="#38bdf8" emissive="#0ea5e9" emissiveIntensity={2.0} transparent opacity={0.92} />
        </mesh>
        {/* Arrowhead */}
        <mesh position={[0, 0, 0.38]} rotation={[Math.PI/2, 0, 0]}>
          <coneGeometry args={[0.28, 0.76, 8]} />
          <meshStandardMaterial color="#7dd3fc" emissive="#38bdf8" emissiveIntensity={3.0} transparent opacity={0.95} />
        </mesh>
      </group>
    </group>
  );
}

// ─── Rain ─────────────────────────────────────────────────────────────────────
function Rain() {
  const COUNT = 700;
  const ptsRef = useRef<THREE.Points>(null!);
  const velRef = useRef<Float32Array>(new Float32Array(COUNT).map(() => 0.18 + Math.random() * 0.12));

  useEffect(() => {
    if (!ptsRef.current) return;
    const geo = ptsRef.current.geometry;
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i*3+0] = (Math.random()-0.5)*44;
      pos[i*3+1] = Math.random()*20;
      pos[i*3+2] = (Math.random()-0.5)*44;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, COUNT);
  }, []);

  useFrame(() => {
    if (!ptsRef.current) return;
    const pos = ptsRef.current.geometry.attributes.position as THREE.BufferAttribute;
    if (!pos) return;
    const pa = pos.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      pa[i*3+1] -= velRef.current[i];
      if (pa[i*3+1] < -0.5) {
        pa[i*3+0] = (Math.random()-0.5)*44;
        pa[i*3+1] = 20;
        pa[i*3+2] = (Math.random()-0.5)*44;
      }
    }
    pos.needsUpdate = true;
    ptsRef.current.geometry.computeBoundingSphere();
  });

  return (
    <group>
      <points ref={ptsRef}>
        <bufferGeometry />
        <pointsMaterial size={0.05} color="#a8d8f8" transparent opacity={0.7} sizeAttenuation depthWrite={false} />
      </points>
      {/* Dark overcast sky tint */}
      <ambientLight intensity={0.2} color="#304060" />
      <pointLight position={[0, 14, 0]} intensity={0.5} color="#6090c0" distance={60} />
    </group>
  );
}

// ─── Snow ─────────────────────────────────────────────────────────────────────
function Snow() {
  const COUNT = 600;
  const ptsRef  = useRef<THREE.Points>(null!);
  const dataRef = useRef<{px:number;pz:number;phase:number;speed:number}[]>([]);

  useEffect(() => {
    if (!ptsRef.current) return;
    const geo = ptsRef.current.geometry;
    const pos = new Float32Array(COUNT * 3);
    dataRef.current = Array.from({length:COUNT}, (_, i) => {
      const px = (Math.random()-0.5)*44;
      const pz = (Math.random()-0.5)*44;
      pos[i*3+0] = px; pos[i*3+1] = Math.random()*20; pos[i*3+2] = pz;
      return { px, pz, phase: Math.random()*Math.PI*2, speed: 0.02+Math.random()*0.015 };
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, COUNT);
  }, []);

  useFrame(({ clock }) => {
    if (!ptsRef.current || !dataRef.current.length) return;
    const T   = clock.elapsedTime;
    const pos = ptsRef.current.geometry.attributes.position as THREE.BufferAttribute;
    if (!pos) return;
    const pa = pos.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const d = dataRef.current[i];
      pa[i*3+0] = d.px + Math.sin(T*0.4 + d.phase)*0.8;
      pa[i*3+1] -= d.speed;
      pa[i*3+2] = d.pz + Math.cos(T*0.3 + d.phase)*0.6;
      if (pa[i*3+1] < -0.5) {
        d.px = (Math.random()-0.5)*44;
        d.pz = (Math.random()-0.5)*44;
        pa[i*3+0] = d.px; pa[i*3+1] = 20; pa[i*3+2] = d.pz;
      }
    }
    pos.needsUpdate = true;
    ptsRef.current.geometry.computeBoundingSphere();
  });

  return (
    <group>
      <points ref={ptsRef}>
        <bufferGeometry />
        <pointsMaterial size={0.22} color="#e8f4ff" transparent opacity={0.9} sizeAttenuation depthWrite={false} />
      </points>
      {/* Snow ground cover */}
      <mesh rotation={[-Math.PI/2,0,0]} position={[0,-0.17,0]} raycast={NOOP_RAYCAST}>
        <planeGeometry args={[65,65]} />
        <meshStandardMaterial color="#d8ecff" roughness={1} transparent opacity={0.6} />
      </mesh>
      <ambientLight intensity={0.4} color="#b8d8f0" />
    </group>
  );
}

// ─── Moonlight ────────────────────────────────────────────────────────────────
function Moonlight() {
  const glowRef  = useRef<THREE.Mesh>(null!);
  const starsRef = useRef<THREE.Points>(null!);

  useEffect(() => {
    if (!starsRef.current) return;
    const geo = starsRef.current.geometry;
    const COUNT = 400;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random()*Math.PI*2;
      const phi   = Math.acos(Math.random()*0.55);
      const r     = 36 + Math.random()*6;
      pos[i*3+0] = r*Math.sin(phi)*Math.cos(theta);
      pos[i*3+1] = r*Math.cos(phi);
      pos[i*3+2] = r*Math.sin(phi)*Math.sin(theta);
      // Slightly randomise star colour: white/blue/warm
      const hue = Math.random();
      col[i*3+0] = hue > 0.7 ? 1.0 : hue > 0.4 ? 0.85 : 0.9;
      col[i*3+1] = hue > 0.7 ? 1.0 : hue > 0.4 ? 0.9  : 0.85;
      col[i*3+2] = hue > 0.7 ? 0.8 : hue > 0.4 ? 1.0  : 1.0;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, COUNT);
  }, []);

  useFrame(({ clock }) => {
    if (glowRef.current) glowRef.current.scale.setScalar(1+Math.sin(clock.elapsedTime*0.7)*0.06);
  });

  return (
    <group>
      <group position={[-16, 22, -20]}>
        <mesh>
          <sphereGeometry args={[1.3, 32, 32]} />
          <meshStandardMaterial color="#ede8d0" emissive="#b8b090" emissiveIntensity={0.9} roughness={0.88} />
        </mesh>
        <mesh ref={glowRef}>
          <sphereGeometry args={[2.2, 16, 16]} />
          <meshStandardMaterial color="#c8c0a0" transparent opacity={0.07} side={THREE.BackSide} depthWrite={false} />
        </mesh>
        <pointLight intensity={4.5} color="#b8cce0" distance={90} decay={1.0} />
      </group>
      <directionalLight position={[-16,22,-20]} intensity={1.4} color="#7788bb" castShadow
        shadow-mapSize-width={1024} shadow-mapSize-height={1024}
        shadow-camera-left={-35} shadow-camera-right={35}
        shadow-camera-top={35} shadow-camera-bottom={-35} />
      <ambientLight intensity={0.3} color="#0d1a30" />
      <points ref={starsRef}>
        <bufferGeometry />
        <pointsMaterial size={0.16} vertexColors transparent opacity={0.92} sizeAttenuation depthWrite={false} />
      </points>
    </group>
  );
}

// ─── Realistic Flood ──────────────────────────────────────────────────────────
// Animated vertex displacement for wave motion + foam particles + caustic light
function Flood() {
  const waterRef  = useRef<THREE.Mesh>(null!);
  const foamRef   = useRef<THREE.Points>(null!);
  const SEG = 40; // water plane subdivisions

  // Foam particles set up imperatively
  const FOAM = 300;
  const foamDataRef = useRef<{ox:number;oz:number;phase:number;speed:number}[]>([]);

  useEffect(() => {
    // Water plane — build vertex array for displacement
    if (waterRef.current) {
      const geo = waterRef.current.geometry as THREE.PlaneGeometry;
      // Store original Y for each vertex
      (geo as any)._origY = new Float32Array((geo.attributes.position.array as Float32Array).slice());
    }
    // Foam particles
    if (!foamRef.current) return;
    const geo  = foamRef.current.geometry;
    const pos  = new Float32Array(FOAM * 3);
    foamDataRef.current = Array.from({length:FOAM}, (_, i) => {
      const r = 6 + Math.random()*22;
      const a = Math.random()*Math.PI*2;
      const ox = Math.cos(a)*r; const oz = Math.sin(a)*r;
      pos[i*3+0] = ox; pos[i*3+1] = 0.68; pos[i*3+2] = oz;
      return { ox, oz, phase: Math.random()*Math.PI*2, speed: 0.004+Math.random()*0.006 };
    });
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, FOAM);
  }, []);

  useFrame(({ clock }) => {
    const T = clock.elapsedTime;

    // Animate water vertices
    if (waterRef.current) {
      const geo = waterRef.current.geometry as THREE.PlaneGeometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const orig = (geo as any)._origY as Float32Array;
      if (pos && orig) {
        const pa = pos.array as Float32Array;
        const vCount = pa.length / 3;
        for (let i = 0; i < vCount; i++) {
          const ox = orig[i*3+0]; const oz = orig[i*3+1]; // plane is XZ in plane geometry before rotation
          // Multi-wave superposition for realism
          const w1 = Math.sin(ox*0.4 + T*1.2) * 0.09;
          const w2 = Math.cos(oz*0.3 + T*0.9) * 0.07;
          const w3 = Math.sin((ox+oz)*0.25 + T*1.5) * 0.05;
          const w4 = Math.cos(ox*0.6 - oz*0.4 + T*0.7) * 0.03;
          pa[i*3+2] = w1+w2+w3+w4; // Z is up in plane geometry (pre-rotation)
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
      }
      // Whole plane gently rises/falls
      waterRef.current.position.y = 0.58 + Math.sin(T * 0.35) * 0.06;
    }

    // Animate foam drift
    if (foamRef.current && foamDataRef.current.length) {
      const pos = foamRef.current.geometry.attributes.position as THREE.BufferAttribute;
      if (!pos) return;
      const pa = pos.array as Float32Array;
      for (let i = 0; i < FOAM; i++) {
        const d = foamDataRef.current[i];
        d.phase += d.speed;
        const r = Math.sqrt(d.ox*d.ox + d.oz*d.oz);
        const a = Math.atan2(d.oz, d.ox) + 0.003; // slow orbit
        d.ox = Math.cos(a)*r + Math.sin(T*0.2+d.phase)*0.04;
        d.oz = Math.sin(a)*r + Math.cos(T*0.15+d.phase)*0.04;
        pa[i*3+0] = d.ox;
        pa[i*3+1] = 0.64 + Math.sin(T*2.0+d.phase)*0.03;
        pa[i*3+2] = d.oz;
      }
      pos.needsUpdate = true;
      foamRef.current.geometry.computeBoundingSphere();
    }
  });

  return (
    <group>
      {/* Water mesh — high-subdivision plane rotated flat */}
      <mesh ref={waterRef} rotation={[-Math.PI/2, 0, 0]} position={[0, 0.58, 0]} raycast={NOOP_RAYCAST}>
        <planeGeometry args={[65, 65, SEG, SEG]} />
        <meshStandardMaterial
          color="#1b6a9a"
          transparent opacity={0.72}
          metalness={0.55} roughness={0.0}
          emissive="#052840" emissiveIntensity={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Foam particle ring */}
      <points ref={foamRef}>
        <bufferGeometry />
        <pointsMaterial size={0.35} color="#c8e8ff" transparent opacity={0.6} sizeAttenuation depthWrite={false} />
      </points>
      {/* Caustic-style animated light shafts */}
      <pointLight position={[0, 1.2, 0]}   intensity={2.5} color="#1a80c0" distance={50} decay={1.2} />
      <pointLight position={[-12, 0.8,-12]} intensity={1.0} color="#0a5080" distance={35} />
      <pointLight position={[12,  0.8, 12]} intensity={1.0} color="#0a5080" distance={35} />
      <pointLight position={[-12, 0.8, 12]} intensity={0.8} color="#104070" distance={30} />
      <pointLight position={[12,  0.8,-12]} intensity={0.8} color="#104070" distance={30} />
    </group>
  );
}

// ─── Solar System ─────────────────────────────────────────────────────────────
const PLANETS = [
  { name:"Mercury", r:0.28, dist:14, speed:2.4,  color:"#a08870", emissive:"#604830", tilt:0.03 },
  { name:"Venus",   r:0.52, dist:18, speed:1.6,  color:"#e8c870", emissive:"#a07030", tilt:0.04 },
  { name:"Earth",   r:0.56, dist:23, speed:1.0,  color:"#3a7ac8", emissive:"#102850", tilt:0.41,
    hasMoon:true },
  { name:"Mars",    r:0.38, dist:29, speed:0.72, color:"#c05030", emissive:"#701810", tilt:0.44 },
  { name:"Jupiter", r:1.10, dist:38, speed:0.30, color:"#c89870", emissive:"#604020", tilt:0.05 },
  { name:"Saturn",  r:0.88, dist:48, speed:0.18, color:"#d8b870", emissive:"#806020", tilt:0.47, hasRing:true },
  { name:"Uranus",  r:0.65, dist:56, speed:0.10, color:"#70c8d8", emissive:"#104050", tilt:1.71 },
  { name:"Neptune", r:0.60, dist:63, speed:0.06, color:"#3060e0", emissive:"#102060", tilt:0.49 },
];

function SolarSystemPlanet({ planet, T }: { planet: typeof PLANETS[0]; T: number }) {
  const angle = T * planet.speed;
  const x = Math.cos(angle) * planet.dist;
  const z = Math.sin(angle) * planet.dist;
  const Y_BASE = 32;

  return (
    <group position={[x, Y_BASE + Math.sin(angle * 0.3) * 1.5, z]}>
      {/* Planet */}
      <mesh rotation={[planet.tilt, T * planet.speed * 3, 0]}>
        <sphereGeometry args={[planet.r, 24, 24]} />
        <meshStandardMaterial color={planet.color} emissive={planet.emissive} emissiveIntensity={0.4} roughness={0.75} metalness={0.1} />
      </mesh>
      {/* Saturn rings */}
      {planet.hasRing && (
        <group rotation={[1.2, 0, 0.4]}>
          <mesh>
            <torusGeometry args={[planet.r*1.6, planet.r*0.22, 4, 64]} />
            <meshStandardMaterial color="#c8a850" emissive="#604010" emissiveIntensity={0.3} transparent opacity={0.72} side={THREE.DoubleSide} />
          </mesh>
          <mesh>
            <torusGeometry args={[planet.r*2.1, planet.r*0.12, 4, 64]} />
            <meshStandardMaterial color="#b89840" emissive="#503010" emissiveIntensity={0.2} transparent opacity={0.45} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}
      {/* Earth moon */}
      {planet.hasMoon && (
        <group>
          <mesh position={[Math.cos(T*8)*1.5, Math.sin(T*3)*0.3, Math.sin(T*8)*1.5]}>
            <sphereGeometry args={[0.17, 12, 12]} />
            <meshStandardMaterial color="#c0b8a0" emissive="#504838" emissiveIntensity={0.3} roughness={0.95} />
          </mesh>
        </group>
      )}
      {/* Tiny glow point */}
      <pointLight intensity={0.15} color={planet.color} distance={4} />
    </group>
  );
}

function SolarSystem() {
  const groupRef = useRef<THREE.Group>(null!);
  const starsRef = useRef<THREE.Points>(null!);
  const timeRef  = useRef(0);

  useEffect(() => {
    if (!starsRef.current) return;
    const geo = starsRef.current.geometry;
    const COUNT = 600;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random()*Math.PI*2;
      const phi   = Math.acos(Math.random()*0.65);
      const r     = 55+Math.random()*15;
      pos[i*3+0] = r*Math.sin(phi)*Math.cos(theta);
      pos[i*3+1] = r*Math.cos(phi);
      pos[i*3+2] = r*Math.sin(phi)*Math.sin(theta);
      const t = Math.random();
      col[i*3+0] = t>0.6?1.0:t>0.3?0.8:0.9;
      col[i*3+1] = t>0.6?0.9:t>0.3?0.9:0.8;
      col[i*3+2] = t>0.6?0.7:t>0.3?1.0:1.0;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, COUNT);
  }, []);

  useFrame(({ clock }) => {
    timeRef.current = clock.elapsedTime * 0.12; // slow solar time
    // Slow whole system rotation
    if (groupRef.current) groupRef.current.rotation.y = clock.elapsedTime * 0.004;
  });

  const T = timeRef.current;

  // Orbit rings (decorative circles)
  const orbitRings = PLANETS.map((p) => {
    const pts: [number,number,number][] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i/64)*Math.PI*2;
      pts.push([Math.cos(a)*p.dist, 32, Math.sin(a)*p.dist]);
    }
    return pts;
  });

  return (
    <group ref={groupRef}>
      {/* Central star (Sun) */}
      <group position={[0, 32, 0]}>
        <mesh>
          <sphereGeometry args={[2.8, 32, 32]} />
          <meshStandardMaterial color="#fff0a0" emissive="#ff9000" emissiveIntensity={3.0} roughness={0.1} />
        </mesh>
        {/* Corona */}
        <mesh>
          <sphereGeometry args={[3.5, 16, 16]} />
          <meshStandardMaterial color="#ffcc00" transparent opacity={0.08} side={THREE.BackSide} depthWrite={false} />
        </mesh>
        <pointLight intensity={8.0} color="#fff0c0" distance={200} decay={0.8} />
      </group>

      {/* Orbit path rings */}
      {PLANETS.map((p) => {
        const ring = new THREE.RingGeometry(p.dist - 0.02, p.dist + 0.02, 128);
        return (
          <mesh key={`orbit-${p.name}`} rotation={[-Math.PI/2, 0, 0]} position={[0, 32, 0]} raycast={NOOP_RAYCAST}>
            <primitive object={ring} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.08} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        );
      })}

      {/* Planets */}
      {PLANETS.map(p => <SolarSystemPlanet key={p.name} planet={p} T={T} />)}

      {/* Background stars */}
      <points ref={starsRef}>
        <bufferGeometry />
        <pointsMaterial size={0.18} vertexColors transparent opacity={0.88} sizeAttenuation depthWrite={false} />
      </points>
    </group>
  );
}

// ─── Post-processing — Native Three.js render pipeline (no extra packages) ─────
// Custom GLSL full-screen passes: Bloom, Vignette, ChromaticAberration, ToneMapping
// Rendered via manual WebGLRenderTarget + TriangleMesh quad

const postVert = `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

const bloomFrag = `
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform float uIntensity;
  uniform float uThreshold;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 col = texture2D(tDiffuse, uv);
    // Extract bright areas
    float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 bright = col.rgb * max(0.0, lum - uThreshold);
    // Simple 9-tap box blur for glow
    vec3 blur = vec3(0.0);
    float blurSize = 2.5 / max(uResolution.x, uResolution.y);
    for(int x=-2;x<=2;x++) for(int y=-2;y<=2;y++) {
      vec2 off = uv + vec2(float(x), float(y)) * blurSize;
      vec3 s = texture2D(tDiffuse, clamp(off, 0.0, 1.0)).rgb;
      float sl = dot(s, vec3(0.2126, 0.7152, 0.0722));
      blur += s * max(0.0, sl - uThreshold);
    }
    blur /= 25.0;
    gl_FragColor = vec4(col.rgb + blur * uIntensity, col.a);
  }
`;

const compositeFrag = `
  uniform sampler2D tDiffuse;
  uniform vec2 uResolution;
  uniform float uVignette;
  uniform float uCA;
  uniform float uExposure;
  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    // Chromatic aberration
    vec2 dir = uv - 0.5;
    float dist = length(dir);
    vec2 caOff = normalize(dir) * dist * uCA;
    float r = texture2D(tDiffuse, uv + caOff).r;
    float g = texture2D(tDiffuse, uv).g;
    float b = texture2D(tDiffuse, uv - caOff).b;
    vec3 col = vec3(r, g, b);
    // ACES filmic tone mapping
    col *= uExposure;
    col = (col * (2.51*col + 0.03)) / (col * (2.43*col + 0.59) + 0.14);
    // Vignette
    float vig = 1.0 - dist * dist * uVignette;
    col *= vig;
    // Gamma
    col = pow(max(col, 0.0), vec3(1.0/2.2));
    gl_FragColor = vec4(col, 1.0);
  }
`;

function RenderPipeline({ quality }: { quality: "low"|"med"|"high" }) {
  const { gl, scene, camera, size } = useThree();

  // Two render targets: scene render + bloom pass
  const sceneRT  = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.HalfFloatType,
    samples: quality === "high" ? 8 : quality === "med" ? 4 : 0,
  }), [size.width, size.height, quality]);

  const bloomRT = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat,
  }), [size.width, size.height]);

  // Full-screen triangle (covers NDC -1..1 with just 3 verts, faster than quad)
  const triGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]), 3));
    return g;
  }, []);

  const bloomMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse:     { value: null },
      uResolution:  { value: new THREE.Vector2(size.width, size.height) },
      uIntensity:   { value: quality === "high" ? 0.85 : 0.5 },
      uThreshold:   { value: 0.55 },
    },
    vertexShader: postVert, fragmentShader: bloomFrag,
    depthTest: false, depthWrite: false,
  }), [quality, size.width, size.height]);

  const compositeMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse:    { value: null },
      uResolution: { value: new THREE.Vector2(size.width, size.height) },
      uVignette:   { value: 0.85 },
      uCA:         { value: quality === "high" ? 0.006 : 0.003 },
      uExposure:   { value: 1.0 },
    },
    vertexShader: postVert, fragmentShader: compositeFrag,
    depthTest: false, depthWrite: false,
  }), [quality, size.width, size.height]);

  // Ortho camera for full-screen passes
  const orthoCam = useMemo(() => new THREE.OrthographicCamera(-1,1,1,-1,0,1), []);

  useEffect(() => {
    // Update resolution when size changes
    bloomMat.uniforms.uResolution.value.set(size.width, size.height);
    compositeMat.uniforms.uResolution.value.set(size.width, size.height);
    sceneRT.setSize(size.width, size.height);
    bloomRT.setSize(size.width, size.height);
  }, [size.width, size.height, bloomMat, compositeMat, sceneRT, bloomRT]);

  useFrame(() => {
    // 1. Render scene into sceneRT
    gl.setRenderTarget(sceneRT);
    gl.render(scene, camera);

    // 2. Bloom pass: scene → bloomRT
    bloomMat.uniforms.tDiffuse.value = sceneRT.texture;
    const bloomMesh = new THREE.Mesh(triGeo, bloomMat);
    const bloomScene = new THREE.Scene();
    bloomScene.add(bloomMesh);
    gl.setRenderTarget(bloomRT);
    gl.render(bloomScene, orthoCam);
    bloomScene.remove(bloomMesh);

    // 3. Composite pass: bloomRT → screen
    compositeMat.uniforms.tDiffuse.value = bloomRT.texture;
    const compMesh = new THREE.Mesh(triGeo, compositeMat);
    const compScene = new THREE.Scene();
    compScene.add(compMesh);
    gl.setRenderTarget(null);
    gl.render(compScene, orthoCam);
    compScene.remove(compMesh);
  }, 1); // priority 1 = after main render

  useEffect(() => () => {
    sceneRT.dispose(); bloomRT.dispose();
    bloomMat.dispose(); compositeMat.dispose(); triGeo.dispose();
  }, [sceneRT, bloomRT, bloomMat, compositeMat, triGeo]);

  return null;
}

// ─── PBR Scene Environment ─────────────────────────────────────────────────
// Sets up a high-quality IBL environment using Three's PMREMGenerator
// with a procedural gradient sky used as the scene environment map
function PBREnvironment({ sunOn, nightMode }: { sunOn: boolean; nightMode: boolean }) {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    pmrem.compileEquirectangularShader();

    // Build a procedural gradient env map
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = y / size; // 0 = top, 1 = bottom
        let r: number, g: number, b: number;
        if (nightMode) {
          // Deep navy → dark teal
          r = Math.round(4  + t*10);
          g = Math.round(8  + t*18);
          b = Math.round(22 + t*14);
        } else if (sunOn) {
          // Pale blue sky → warm horizon
          r = Math.round(140 + t*80);
          g = Math.round(180 + t*60);
          b = Math.round(230 - t*80);
        } else {
          // Overcast
          r = Math.round(80 + t*40);
          g = Math.round(90 + t*40);
          b = Math.round(100 + t*30);
        }
        const i = (y * size + x) * 4;
        data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;

    const envMap = pmrem.fromEquirectangular(tex).texture;
    scene.environment = envMap;
    (scene as any).environmentIntensity = nightMode ? 0.08 : sunOn ? 0.55 : 0.22;

    return () => {
      scene.environment = null;
      pmrem.dispose();
      tex.dispose();
    };
  }, [gl, scene, sunOn, nightMode]);

  return null;
}

// ─── Custom PBR Ground with procedural detail normal map ──────────────────────
// GLSL shader that generates micro-surface normals without needing a texture file
const groundVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const groundFrag = /* glsl */ `
  uniform vec3  uColor;
  uniform vec3  uColor2;
  uniform float uTime;
  uniform float uWet;     // 0=dry 1=wet (flood)
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vNormal;

  // Hash for procedural noise
  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
               mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0; float a = 0.5;
    for(int i=0;i<5;i++){v+=a*noise(p);p*=2.1;a*=0.5;}
    return v;
  }

  void main() {
    vec2 uv = vWorldPos.xz * 0.18;
    float n  = fbm(uv * 2.0);
    float n2 = fbm(uv * 6.0 + 3.7);

    // Base ground colour with subtle variation
    vec3 col = mix(uColor, uColor2, n * 0.4 + n2 * 0.1);

    // Fake AO in corners / low spots
    float ao = 0.85 + 0.15 * n;
    col *= ao;

    // Wet reflection overlay
    vec3 wetCol = vec3(0.04, 0.08, 0.14);
    float wetGloss = pow(max(dot(vNormal, normalize(vec3(1,3,1))), 0.0), 24.0);
    col = mix(col, wetCol + wetGloss * 0.3, uWet * 0.65);

    // Subtle puddle specularity
    float puddle = smoothstep(0.48, 0.52, n2) * uWet;
    col = mix(col, vec3(0.06, 0.14, 0.22) + wetGloss * 0.6, puddle * 0.7);

    gl_FragColor = vec4(col, 1.0);
  }
`;

function PBRGround({ showGrid, wet }: { showGrid: boolean; wet: boolean }) {
  const matRef = useRef<THREE.ShaderMaterial>(null!);
  useFrame(({ clock }) => {
    if (matRef.current) matRef.current.uniforms.uTime.value = clock.elapsedTime;
  });
  const uniforms = useMemo(() => ({
    uColor:  { value: new THREE.Color("#141e14") },
    uColor2: { value: new THREE.Color("#0e1a10") },
    uTime:   { value: 0 },
    uWet:    { value: wet ? 1.0 : 0.0 },
  }), []);
  useEffect(() => {
    if (matRef.current) matRef.current.uniforms.uWet.value = wet ? 1.0 : 0.0;
  }, [wet]);

  return <>
    <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, -0.23, 0]} receiveShadow raycast={NOOP_RAYCAST}>
      <planeGeometry args={[120, 120, 1, 1]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={groundVert}
        fragmentShader={groundFrag}
        uniforms={uniforms}
      />
    </mesh>
    {showGrid && <gridHelper args={[100, 100, "#0a2020", "#091a19"]} position={[0, -0.22, 0]} raycast={NOOP_RAYCAST} />}
  </>;
}


// ─── Furniture meshes ─────────────────────────────────────────────────────────
function FurnitureMesh({ type }: { type: string }) {
  const t = type.toLowerCase();
  const wood = useMemo(() => new THREE.MeshStandardMaterial({ color: "#7c5a38", roughness: 0.8 }), []);
  const soft = useMemo(() => new THREE.MeshStandardMaterial({ color: "#3a5070", roughness: 0.9 }), []);
  const metal = useMemo(() => new THREE.MeshStandardMaterial({ color: "#9ab0b8", metalness: 0.7, roughness: 0.3 }), []);
  const white = useMemo(() => new THREE.MeshStandardMaterial({ color: "#e8e4de", roughness: 0.7 }), []);
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: "#1e2530", roughness: 0.5 }), []);
  const glass = useMemo(() => new THREE.MeshStandardMaterial({ color: "#88bbdd", transparent: true, opacity: 0.45 }), []);
  const green = useMemo(() => new THREE.MeshStandardMaterial({ color: "#2a7a2a", roughness: 0.85 }), []);
  const fab = useMemo(() => new THREE.MeshStandardMaterial({ color: "#4a6080", roughness: 0.95 }), []);
  const nr = NOOP_RAYCAST;

  if (t === "chair") return <group>
    {[[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]].map(([lx, lz], i) => (
      <mesh key={i} position={[lx, -0.22, lz]} material={wood} castShadow raycast={nr}><cylinderGeometry args={[0.025, 0.025, 0.44, 8]} /></mesh>
    ))}
    <mesh position={[0, 0.02, 0]} material={fab} castShadow raycast={nr}><boxGeometry args={[0.52, 0.08, 0.5]} /></mesh>
    <mesh position={[0, 0.04, 0]} material={soft} castShadow raycast={nr}><boxGeometry args={[0.46, 0.1, 0.44]} /></mesh>
    <mesh position={[0, 0.3, -0.23]} material={fab} castShadow raycast={nr}><boxGeometry args={[0.48, 0.5, 0.07]} /></mesh>
    <mesh position={[0, 0.3, -0.22]} material={soft} castShadow raycast={nr}><boxGeometry args={[0.42, 0.44, 0.05]} /></mesh>
  </group>;

  if (t === "sofa") return <group>
    <mesh position={[0, -0.1, 0]} material={soft} castShadow raycast={nr}><boxGeometry args={[1.9, 0.18, 0.82]} /></mesh>
    <mesh position={[0, 0.08, 0]} material={fab} castShadow raycast={nr}><boxGeometry args={[1.9, 0.34, 0.82]} /></mesh>
    {[-0.6, 0, 0.6].map((x, i) => (<mesh key={i} position={[x, 0.18, 0.06]} material={soft} castShadow raycast={nr}><boxGeometry args={[0.56, 0.2, 0.66]} /></mesh>))}
    <mesh position={[0, 0.34, -0.34]} material={fab} castShadow raycast={nr}><boxGeometry args={[1.9, 0.6, 0.13]} /></mesh>
    <mesh position={[-0.9, 0.14, 0]} material={fab} castShadow raycast={nr}><boxGeometry args={[0.14, 0.52, 0.82]} /></mesh>
    <mesh position={[0.9, 0.14, 0]} material={fab} castShadow raycast={nr}><boxGeometry args={[0.14, 0.52, 0.82]} /></mesh>
    {[[-0.82, -0.3, -0.32], [0.82, -0.3, -0.32], [-0.82, -0.3, 0.32], [0.82, -0.3, 0.32]].map(([lx, ly, lz], i) => (
      <mesh key={i} position={[lx, ly, lz]} material={metal} raycast={nr}><cylinderGeometry args={[0.03, 0.03, 0.14, 8]} /></mesh>
    ))}
  </group>;

  if (t === "bed") return <group>
    <mesh position={[0, -0.16, 0]} material={wood} castShadow raycast={nr}><boxGeometry args={[1.7, 0.12, 2.1]} /></mesh>
    <mesh position={[0, 0.04, 0.05]} material={white} castShadow raycast={nr}><boxGeometry args={[1.58, 0.26, 1.82]} /></mesh>
    <mesh position={[0, 0.18, 0.05]} material={white} castShadow raycast={nr}><boxGeometry args={[1.52, 0.08, 1.76]} /></mesh>
    {[-0.35, 0.35].map((x, i) => (<mesh key={i} position={[x, 0.26, -0.7]} material={white} castShadow raycast={nr}><boxGeometry args={[0.5, 0.18, 0.34]} /></mesh>))}
    <mesh position={[0, 0.24, -0.98]} material={wood} castShadow raycast={nr}><boxGeometry args={[1.7, 0.72, 0.1]} /></mesh>
  </group>;

  if (t === "table") return <group>
    <mesh position={[0, 0.04, 0]} material={wood} castShadow raycast={nr}><boxGeometry args={[1.2, 0.06, 0.7]} /></mesh>
    {[[-0.52, -0.32, -0.28], [0.52, -0.32, -0.28], [-0.52, -0.32, 0.28], [0.52, -0.32, 0.28]].map(([lx, ly, lz], i) => (
      <mesh key={i} position={[lx, ly, lz]} material={wood} castShadow raycast={nr}><boxGeometry args={[0.05, 0.7, 0.05]} /></mesh>
    ))}
    <mesh position={[0, -0.28, 0]} material={glass} raycast={nr}><boxGeometry args={[0.9, 0.02, 0.5]} /></mesh>
  </group>;

  if (t === "desk") return <group>
    <mesh position={[0, 0.04, 0]} material={wood} castShadow raycast={nr}><boxGeometry args={[1.4, 0.05, 0.65]} /></mesh>
    {[[-0.65, -0.32, -0.28], [0.65, -0.32, -0.28], [-0.65, -0.32, 0.28], [0.65, -0.32, 0.28]].map(([lx, ly, lz], i) => (
      <mesh key={i} position={[lx, ly, lz]} material={metal} castShadow raycast={nr}><boxGeometry args={[0.04, 0.7, 0.04]} /></mesh>
    ))}
    <mesh position={[0, 0.38, -0.25]} material={dark} castShadow raycast={nr}><boxGeometry args={[0.7, 0.42, 0.04]} /></mesh>
    <mesh position={[0, 0.18, -0.26]} material={metal} raycast={nr}><boxGeometry args={[0.06, 0.28, 0.04]} /></mesh>
  </group>;

  if (t === "bookshelf") return <group>
    <mesh position={[0, 0.5, 0]} material={wood} castShadow raycast={nr}><boxGeometry args={[0.9, 1.8, 0.3]} /></mesh>
    {[-0.55, -0.18, 0.18, 0.55].map((y, i) => (
      <mesh key={i} position={[0, y, 0.01]} material={new THREE.MeshStandardMaterial({ color: "#6a4828", roughness: 0.7 })} raycast={nr}><boxGeometry args={[0.84, 0.03, 0.26]} /></mesh>
    ))}
    {[[-0.3, -0.42, "#c04040"], [0, -0.42, "#4060c0"], [0.3, -0.42, "#40a040"], [-0.3, -0.05, "#c0a040"], [0, -0.05, "#8040c0"], [0.3, -0.05, "#e06020"], [-0.3, 0.32, "#2060c0"], [0, 0.32, "#c04060"]].map(([bx, by, bc], i) => (
      <mesh key={i} position={[bx as number, by as number, 0.06]} material={new THREE.MeshStandardMaterial({ color: bc as string, roughness: 0.9 })} raycast={nr}><boxGeometry args={[0.12, 0.28, 0.02]} /></mesh>
    ))}
  </group>;

  if (t === "wardrobe") return <group>
    <mesh position={[0, 0.56, 0]} material={wood} castShadow raycast={nr}><boxGeometry args={[1.2, 1.9, 0.55]} /></mesh>
    {[-0.28, 0.28].map((x, i) => (<mesh key={i} position={[x, 0.56, 0.285]} material={new THREE.MeshStandardMaterial({ color: "#8a6040", roughness: 0.65 })} castShadow raycast={nr}><boxGeometry args={[0.56, 1.82, 0.02]} /></mesh>))}
    {[-0.04, 0.04].map((x, i) => (<mesh key={i} position={[x, 0.56, 0.3]} material={metal} raycast={nr}><sphereGeometry args={[0.025, 8, 8]} /></mesh>))}
  </group>;

  if (t === "bathtub") return <group>
    <mesh position={[0, 0, 0]} material={white} castShadow raycast={nr}><boxGeometry args={[0.78, 0.42, 1.52]} /></mesh>
    <mesh position={[0, 0.12, 0]} material={new THREE.MeshStandardMaterial({ color: "#c8e8f0", roughness: 0.05 })} raycast={nr}><boxGeometry args={[0.62, 0.22, 1.36]} /></mesh>
    <mesh position={[0, 0.22, -0.6]} material={white} raycast={nr}><boxGeometry args={[0.62, 0.12, 0.2]} /></mesh>
    <mesh position={[0, 0.37, -0.58]} material={metal} raycast={nr}><cylinderGeometry args={[0.025, 0.025, 0.2, 8]} /></mesh>
  </group>;

  if (t === "counter") return <group>
    <mesh position={[0, 0.1, 0]} material={white} castShadow raycast={nr}><boxGeometry args={[2.0, 0.78, 0.6]} /></mesh>
    <mesh position={[0, 0.505, 0.01]} material={new THREE.MeshStandardMaterial({ color: "#c8c8c8", metalness: 0.3, roughness: 0.4 })} raycast={nr}><boxGeometry args={[2.0, 0.04, 0.62]} /></mesh>
    {[-0.92, 0.92].map((x, i) => (<mesh key={i} position={[x, -0.28, 0]} material={white} raycast={nr}><boxGeometry args={[0.14, 0.62, 0.58]} /></mesh>))}
  </group>;

  if (t === "plant") return <group>
    <mesh position={[0, -0.22, 0]} material={new THREE.MeshStandardMaterial({ color: "#8a6030", roughness: 0.9 })} castShadow raycast={nr}><cylinderGeometry args={[0.14, 0.1, 0.26, 10]} /></mesh>
    <mesh position={[0, -0.08, 0]} material={new THREE.MeshStandardMaterial({ color: "#2a7a2a", roughness: 0.85 })} castShadow raycast={nr}><sphereGeometry args={[0.24, 10, 8]} /></mesh>
    <mesh position={[-0.12, 0.04, 0.08]} material={green} castShadow raycast={nr}><sphereGeometry args={[0.14, 8, 6]} /></mesh>
    <mesh position={[0.14, 0.02, -0.06]} material={green} castShadow raycast={nr}><sphereGeometry args={[0.12, 8, 6]} /></mesh>
    <mesh position={[0.06, 0.1, 0.1]} material={green} castShadow raycast={nr}><sphereGeometry args={[0.1, 6, 5]} /></mesh>
  </group>;

  if (t === "tv stand") return <group>
    <mesh position={[0, -0.08, 0]} material={dark} castShadow raycast={nr}><boxGeometry args={[1.6, 0.42, 0.4]} /></mesh>
    <mesh position={[0, 0.52, 0.05]} material={dark} castShadow raycast={nr}><boxGeometry args={[1.1, 0.62, 0.07]} /></mesh>
    <mesh position={[0, 0.52, 0.08]} material={new THREE.MeshStandardMaterial({ color: "#0a0a18", roughness: 0.04 })} raycast={nr}><boxGeometry args={[1.02, 0.54, 0.02]} /></mesh>
    <mesh position={[0, 0.26, 0.06]} material={metal} raycast={nr}><cylinderGeometry args={[0.025, 0.025, 0.26, 8]} /></mesh>
  </group>;

  if (t === "lamp") return <group>
    <mesh position={[0, -0.3, 0]} material={metal} castShadow raycast={nr}><cylinderGeometry args={[0.14, 0.18, 0.05, 10]} /></mesh>
    <mesh position={[0, 0.1, 0]} material={metal} castShadow raycast={nr}><cylinderGeometry args={[0.02, 0.02, 0.8, 8]} /></mesh>
    <mesh position={[0, 0.54, 0]} material={new THREE.MeshStandardMaterial({ color: "#f5e8c0", transparent: true, opacity: 0.85, emissive: "#f0d060", emissiveIntensity: 0.5 })} raycast={nr}><coneGeometry args={[0.22, 0.28, 14, 1, true]} /></mesh>
    <mesh position={[0, 0.54, 0]} material={new THREE.MeshStandardMaterial({ color: "#ffe090", emissive: "#ffe090", emissiveIntensity: 1.2 })} raycast={nr}><sphereGeometry args={[0.04, 8, 8]} /></mesh>
    <pointLight position={[0, 0.5, 0]} intensity={0.8} color="#ffe090" distance={6} />
  </group>;

  if (t === "toilet") return <group>
    <mesh position={[0, -0.15, 0.05]} material={white} castShadow raycast={nr}><boxGeometry args={[0.38, 0.42, 0.52]} /></mesh>
    <mesh position={[0, 0.1, 0.05]} material={white} castShadow raycast={nr}><cylinderGeometry args={[0.18, 0.15, 0.14, 14]} /></mesh>
    <mesh position={[0, 0.18, 0.05]} material={new THREE.MeshStandardMaterial({ color: "#ddd", roughness: 0.3 })} raycast={nr}><torusGeometry args={[0.13, 0.04, 8, 20]} /></mesh>
    <mesh position={[0, -0.04, -0.24]} material={white} castShadow raycast={nr}><boxGeometry args={[0.36, 0.26, 0.18]} /></mesh>
  </group>;

  if (t === "sink") return <group>
    <mesh position={[0, 0, -0.05]} material={white} castShadow raycast={nr}><boxGeometry args={[0.58, 0.2, 0.46]} /></mesh>
    <mesh position={[0, 0.09, 0]} material={new THREE.MeshStandardMaterial({ color: "#c0dcec", roughness: 0.1 })} raycast={nr}><boxGeometry args={[0.44, 0.1, 0.32]} /></mesh>
    <mesh position={[0, 0.17, 0.04]} material={metal} raycast={nr}><cylinderGeometry args={[0.02, 0.02, 0.18, 8]} /></mesh>
    <mesh position={[0, 0.27, 0.04]} material={metal} raycast={nr}><sphereGeometry args={[0.03, 8, 8]} /></mesh>
    <mesh position={[0, -0.28, 0]} material={white} raycast={nr}><cylinderGeometry args={[0.04, 0.04, 0.38, 8]} /></mesh>
  </group>;

  if (t === "fridge") return <group>
    <mesh position={[0, 0.42, 0]} material={new THREE.MeshStandardMaterial({ color: "#d0d8e0", metalness: 0.35, roughness: 0.35 })} castShadow raycast={nr}><boxGeometry args={[0.7, 1.72, 0.68]} /></mesh>
    {[[0, 0.88, 0.35], [0, -0.04, 0.35]].map(([px, py, pz], i) => (
      <mesh key={i} position={[px, py, pz]} material={new THREE.MeshStandardMaterial({ color: "#c0c8d0", metalness: 0.4 })} raycast={nr}><boxGeometry args={[0.68, i === 0 ? 0.82 : 0.96, 0.02]} /></mesh>
    ))}
    {[[0.28, 0.88, 0.36], [0.28, -0.04, 0.36]].map(([px, py, pz], i) => (
      <mesh key={i} position={[px, py, pz]} material={metal} raycast={nr}><boxGeometry args={[0.04, 0.4, 0.02]} /></mesh>
    ))}
  </group>;

  return <mesh raycast={nr} castShadow><boxGeometry args={[0.6, 0.6, 0.6]} /><meshStandardMaterial color="#6080a0" roughness={0.6} /></mesh>;
}

// ─── Auto room furniture (matches drft.tsx Furniture component) ───────────────
function RoomFurniture({ type, w, d }: { type: string; w: number; d: number }) {
  const t = type.toLowerCase();
  const Y = 0.16;
  const wood  = useMemo(() => new THREE.MeshStandardMaterial({ color: "#7c5a38", roughness: 0.8 }), []);
  const soft  = useMemo(() => new THREE.MeshStandardMaterial({ color: "#3a5a70", roughness: 0.95 }), []);
  const white = useMemo(() => new THREE.MeshStandardMaterial({ color: "#e8e4de", roughness: 0.7 }), []);
  const dark  = useMemo(() => new THREE.MeshStandardMaterial({ color: "#252832", roughness: 0.5 }), []);
  const metal = useMemo(() => new THREE.MeshStandardMaterial({ color: "#9aacb4", metalness: 0.7, roughness: 0.3 }), []);
  const glassMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#88bbdd", transparent: true, opacity: 0.5 }), []);
  const green = useMemo(() => new THREE.MeshStandardMaterial({ color: "#2a7a2a", roughness: 0.9 }), []);
  const nr = NOOP_RAYCAST;

  if (t.includes("living")) return (
    <group>
      {/* Sofa */}
      <mesh position={[0, Y+0.2, d*0.28]} material={soft} castShadow raycast={nr}><boxGeometry args={[Math.min(w-0.9,2.8),0.42,0.85]}/></mesh>
      <mesh position={[0, Y+0.45, d*0.28-0.36]} material={soft} raycast={nr}><boxGeometry args={[Math.min(w-0.9,2.8),0.56,0.18]}/></mesh>
      {/* Armchairs */}
      <mesh position={[-(Math.min(w-0.9,2.8)/2+0.35), Y+0.2, d*0.05]} material={soft} castShadow raycast={nr}><boxGeometry args={[0.6,0.42,0.6]}/></mesh>
      <mesh position={[(Math.min(w-0.9,2.8)/2+0.35), Y+0.2, d*0.05]} material={soft} castShadow raycast={nr}><boxGeometry args={[0.6,0.42,0.6]}/></mesh>
      {/* Coffee table */}
      <mesh position={[0, Y+0.18, d*0.06]} material={glassMat} castShadow raycast={nr}><boxGeometry args={[1.0,0.04,0.55]}/></mesh>
      {/* TV unit */}
      <mesh position={[0, Y+0.16, -d*0.3]} material={dark} castShadow raycast={nr}><boxGeometry args={[Math.min(w-1,2.2),0.36,0.28]}/></mesh>
      <mesh position={[0, Y+0.35, -d*0.3]} material={dark} raycast={nr}><boxGeometry args={[Math.min(w-1.4,1.8),0.26,0.04]}/></mesh>
      {/* Rug */}
      <mesh position={[0, Y+0.01, d*0.1]} rotation={[-Math.PI/2,0,0]} raycast={nr}><planeGeometry args={[Math.min(w-1,2.5),1.8]}/><meshStandardMaterial color="#2a3a4a" roughness={1}/></mesh>
      {/* Plant */}
      <mesh position={[w*0.38, Y+0.42, -d*0.3]} material={metal} castShadow raycast={nr}><cylinderGeometry args={[0.09,0.11,0.28,8]}/></mesh>
      <mesh position={[w*0.38, Y+0.7, -d*0.3]} material={green} castShadow raycast={nr}><sphereGeometry args={[0.2,8,8]}/></mesh>
    </group>
  );

  if (t.includes("bedroom")) return (
    <group>
      {/* Bed frame */}
      <mesh position={[0, Y+0.22, 0.15]} material={wood} castShadow raycast={nr}><boxGeometry args={[Math.min(w-0.8,2.0),0.28,Math.min(d-1,2.0)]}/></mesh>
      {/* Mattress */}
      <mesh position={[0, Y+0.46, 0.15]} material={white} castShadow raycast={nr}><boxGeometry args={[Math.min(w-1,1.8),0.2,Math.min(d-1.4,1.8)]}/></mesh>
      {/* Pillows */}
      {[-0.36,0.36].map((px,i)=><mesh key={i} position={[px,Y+0.6,-0.35]} material={white} castShadow raycast={nr}><boxGeometry args={[0.5,0.1,0.35]}/></mesh>)}
      {/* Headboard */}
      <mesh position={[0, Y+0.68, -0.58]} material={wood} castShadow raycast={nr}><boxGeometry args={[Math.min(w-0.8,2.0),0.85,0.1]}/></mesh>
      {/* Bedside tables */}
      {[-1.1,1.1].filter(px=>Math.abs(px)<w/2-0.3).map((px,i)=>(
        <group key={i}>
          <mesh position={[px,Y+0.26,0.15]} material={wood} castShadow raycast={nr}><boxGeometry args={[0.44,0.44,0.42]}/></mesh>
          <mesh position={[px,Y+0.5,0.15]} material={metal} raycast={nr}><cylinderGeometry args={[0.05,0.05,0.06,8]}/></mesh>
        </group>
      ))}
      {/* Wardrobe */}
      <mesh position={[-w*0.32, Y+1.0, d*0.28]} material={white} castShadow raycast={nr}><boxGeometry args={[0.62,2.0,0.52]}/></mesh>
    </group>
  );

  if (t.includes("kitchen")) return (
    <group>
      {/* Counter */}
      <mesh position={[0, Y+0.44, -d/2+0.3]} material={white} castShadow raycast={nr}><boxGeometry args={[w-0.3,0.88,0.58]}/></mesh>
      <mesh position={[0, Y+0.89, -d/2+0.3]} material={metal} raycast={nr}><boxGeometry args={[w-0.3,0.04,0.58]}/></mesh>
      {/* Hob */}
      <mesh position={[-0.5, Y+0.93, -d/2+0.28]} material={dark} raycast={nr}><boxGeometry args={[0.62,0.03,0.52]}/></mesh>
      {[-0.65,-0.35].map((px,i)=><mesh key={i} position={[-0.5+px*0.18,Y+0.96,-d/2+0.26]} castShadow raycast={nr}><cylinderGeometry args={[0.07,0.07,0.02,10]}/><meshStandardMaterial color="#cc3300" emissive="#cc2200" emissiveIntensity={0.5}/></mesh>)}
      {/* Sink */}
      <mesh position={[w/2-0.48, Y+0.93, -d/2+0.28]} material={metal} raycast={nr}><boxGeometry args={[0.5,0.05,0.44]}/></mesh>
      {/* Wall cabinets */}
      <mesh position={[0, Y+1.68, -d/2+0.15]} material={white} raycast={nr}><boxGeometry args={[w-0.4,0.62,0.28]}/></mesh>
      {/* Island */}
      {d>3.5&&<mesh position={[0,Y+0.88,0.55]} material={white} castShadow raycast={nr}><boxGeometry args={[1.2,0.94,0.58]}/></mesh>}
    </group>
  );

  if (t.includes("bathroom")) return (
    <group>
      {/* Bathtub */}
      <mesh position={[-w/2+0.52, Y+0.28, -d/2+0.68]} material={white} castShadow raycast={nr}><boxGeometry args={[0.76,0.52,1.45]}/></mesh>
      {/* Toilet */}
      <mesh position={[w/2-0.36, Y+0.27, d/2-0.52]} material={white} castShadow raycast={nr}><boxGeometry args={[0.38,0.5,0.55]}/></mesh>
      <mesh position={[w/2-0.36, Y+0.54, d/2-0.82]} material={white} raycast={nr}><boxGeometry args={[0.38,0.11,0.18]}/></mesh>
      {/* Vanity/sink */}
      <mesh position={[-w/2+0.38, Y+0.4, d/2-0.38]} material={white} castShadow raycast={nr}><boxGeometry args={[0.62,0.8,0.44]}/></mesh>
      <mesh position={[-w/2+0.38, Y+0.82, d/2-0.38]} material={metal} raycast={nr}><boxGeometry args={[0.55,0.04,0.38]}/></mesh>
    </group>
  );

  if (t.includes("office")) return (
    <group>
      {/* Desk */}
      <mesh position={[0, Y+0.36, -d/2+0.44]} material={wood} castShadow raycast={nr}><boxGeometry args={[Math.min(w-0.6,1.6),0.04,0.68]}/></mesh>
      <mesh position={[0, Y+0.08, -d/2+0.44]} material={wood} raycast={nr}><boxGeometry args={[1.55,0.18,0.64]}/></mesh>
      {/* Chair */}
      <mesh position={[0, Y+0.2, 0.25]} material={dark} castShadow raycast={nr}><cylinderGeometry args={[0.2,0.2,0.42,8]}/></mesh>
      <mesh position={[0, Y+0.48, 0.2]} material={dark} raycast={nr}><boxGeometry args={[0.42,0.48,0.07]}/></mesh>
      {/* Bookshelf */}
      <mesh position={[w*0.32, Y+0.88, -d/2+0.15]} material={white} raycast={nr}><boxGeometry args={[0.55,1.75,0.2]}/></mesh>
    </group>
  );

  if (t.includes("garage")) return (
    <group>
      {/* Car silhouette */}
      <mesh position={[0, Y+0.28, 0]} material={metal} castShadow raycast={nr}><boxGeometry args={[Math.min(w-1,2.0),0.5,Math.min(d-1.2,4.2)]}/></mesh>
      <mesh position={[0, Y+0.58, -0.4]} castShadow raycast={nr}><boxGeometry args={[Math.min(w-1.4,1.6),0.4,Math.min(d-2,2.0)]}/><meshStandardMaterial color="#4a5a6a" roughness={0.4}/></mesh>
    </group>
  );

  if (t.includes("dining")) return (
    <group>
      {/* Dining table */}
      <mesh position={[0, Y+0.36, 0]} material={wood} castShadow raycast={nr}><boxGeometry args={[Math.min(w-0.8,1.8),0.05,Math.min(d-0.8,1.0)]}/></mesh>
      {[[-0.7,0],[0.7,0],[0,-0.4],[0,0.4]].filter(([lx])=>Math.abs(lx)<w/2-0.3).map(([lx,lz],i)=>(
        <group key={i} position={[lx,0,lz as number]}>
          <mesh position={[0,Y+0.2,0]} material={soft} castShadow raycast={nr}><boxGeometry args={[0.44,0.38,0.44]}/></mesh>
          <mesh position={[0,Y+0.4,-0.18]} material={soft} raycast={nr}><boxGeometry args={[0.42,0.5,0.07]}/></mesh>
        </group>
      ))}
    </group>
  );

  return null;
}

// ─── Selection outline ────────────────────────────────────────────────────────
function SelectionBox({ w, h, d }: { w: number; h: number; d: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BoxGeometry(w + 0.08, h + 0.08, d + 0.08);
    const e = new THREE.EdgesGeometry(g); g.dispose(); return e;
  }, [w, h, d]);
  return <lineSegments geometry={geo} raycast={NOOP_RAYCAST}><lineBasicMaterial color="#0df2f2" /></lineSegments>;
}

// ─── KEY FIX: useDragPlane ────────────────────────────────────────────────────
function useDragPlane(
  editMode: boolean,
  onMove: (x: number, z: number) => void,
  onDragChange: (d: boolean) => void
) {
  const { camera, gl } = useThree();
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const isDragging = useRef(false);

  const editModeRef = useRef(editMode);
  const onMoveRef = useRef(onMove);
  const onDragChangeRef = useRef(onDragChange);
  useLayoutEffect(() => { editModeRef.current = editMode; }, [editMode]);
  useLayoutEffect(() => { onMoveRef.current = onMove; }, [onMove]);
  useLayoutEffect(() => { onDragChangeRef.current = onDragChange; }, [onDragChange]);

  const projectToPlane = useCallback((clientX: number, clientY: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const pt = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, pt)) {
      onMoveRef.current(snap(pt.x), snap(pt.z));
    }
  }, [camera, gl, plane, raycaster]);

  const onPointerDown = useCallback((e: any) => {
    if (!editModeRef.current) return;
    e.stopPropagation();
    isDragging.current = true;
    onDragChangeRef.current(true);
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch (_) { }
    gl.domElement.style.cursor = "grabbing";
  }, [gl]);

  const onPointerUp = useCallback((e: any) => {
    if (!isDragging.current) return;
    e.stopPropagation();
    isDragging.current = false;
    onDragChangeRef.current(false);
    gl.domElement.style.cursor = editModeRef.current ? "grab" : "auto";
  }, [gl]);

  const onPointerMove = useCallback((e: any) => {
    if (!isDragging.current) return;
    e.stopPropagation();
    projectToPlane(e.clientX, e.clientY);
  }, [projectToPlane]);

  const onPointerOver = useCallback((e: any) => {
    if (!editModeRef.current) return;
    e.stopPropagation();
    if (!isDragging.current) gl.domElement.style.cursor = "grab";
  }, [gl]);

  const onPointerOut = useCallback((_e: any) => {
    if (!isDragging.current) gl.domElement.style.cursor = "auto";
  }, []);

  return { onPointerDown, onPointerUp, onPointerMove, onPointerOver, onPointerOut };
}

// ─── KEY FIX: HitMesh ────────────────────────────────────────────────────────
function HitMesh({
  args, editMode, onPointerDown, onPointerUp, onPointerMove, onPointerOver, onPointerOut, position
}: {
  args: [number, number, number];
  editMode: boolean;
  onPointerDown: (e: any) => void;
  onPointerUp: (e: any) => void;
  onPointerMove: (e: any) => void;
  onPointerOver: (e: any) => void;
  onPointerOut: (e: any) => void;
  position?: [number, number, number];
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    colorWrite: false,
    depthWrite: false,
    side: THREE.FrontSide,
  }), []);

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    meshRef.current.raycast = editMode ? REAL_RAYCAST : NOOP_RAYCAST;
  }, [editMode]);

  useFrame(() => {
    if (!meshRef.current) return;
    const want = editMode ? REAL_RAYCAST : NOOP_RAYCAST;
    if (meshRef.current.raycast !== want) meshRef.current.raycast = want;
  });

  return (
    <mesh
      ref={meshRef}
      position={position}
      raycast={NOOP_RAYCAST}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerMove={onPointerMove}
    >
      <boxGeometry args={args} />
      <primitive object={mat} />
    </mesh>
  );
}

// ─── SceneObject ──────────────────────────────────────────────────────────────
function SceneObject({ obj, selected, editMode, onSelect, onUpdate, onDragChange }: {
  obj: SceneObj; selected: boolean; editMode: boolean;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<SceneObj>) => void;
  onDragChange: (d: boolean) => void;
}) {
  const [hov, setHov] = useState(false);

  const onMove = useCallback((x: number, z: number) => onUpdate(obj.id, { x, z }), [obj.id, onUpdate]);
  const drag = useDragPlane(editMode, onMove, onDragChange);

  const accent = useMemo(() =>
    Object.entries({ living: "#0bc8c8", bedroom: "#4a9de8", kitchen: "#2cb46e", bathroom: "#9b72d4", office: "#e8c33a", utility: "#e08050", dining: "#e07060", hallway: "#6080a0" })
      .find(([k]) => obj.type.toLowerCase().includes(k))?.[1] ?? "#0df2f2"
    , [obj.type]);

  const wallMat = useMemo(() => makeMat(selected ? "#1ae0e0" : obj.color, obj.tex), [obj.color, obj.tex, selected]);

  const handleOver = useCallback((e: any) => { if (!editMode) return; setHov(true); drag.onPointerOver(e); }, [editMode, drag]);
  const handleOut = useCallback((e: any) => { setHov(false); drag.onPointerOut(e); }, [drag]);
  const handleDown = useCallback((e: any) => { if (!editMode) return; onSelect(obj.id); drag.onPointerDown(e); }, [editMode, obj.id, onSelect, drag]);

  if (obj.kind === "room") {
    return <group position={[obj.x, 0, obj.z]} rotation={[0, obj.rotY, 0]}>
      <HitMesh
        args={[obj.w, 0.3, obj.d]}
        editMode={editMode}
        position={[0, 0.15, 0]}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
        onPointerDown={handleDown}
        onPointerUp={drag.onPointerUp}
        onPointerMove={drag.onPointerMove}
      />
      <mesh position={[0, 0.06, 0]} receiveShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[obj.w - 0.14, 0.12, obj.d - 0.14]} />
        <meshStandardMaterial color={selected ? "#0a2a2a" : obj.color} roughness={0.9} />
      </mesh>
      <mesh position={[0, obj.h / 2, 0]} castShadow receiveShadow raycast={NOOP_RAYCAST}>
        <boxGeometry args={[obj.w, obj.h, obj.d]} />
        <meshStandardMaterial color={hov ? "#22e8e8" : selected ? "#0df2f2" : "#b0c8c8"} transparent opacity={0.07 + (selected ? 0.06 : hov ? 0.04 : 0)} roughness={0.9} side={THREE.BackSide} />
      </mesh>
      <Text position={[0, 1.2, 0]} color={accent} fontSize={Math.min(0.3, obj.w * 0.07)} anchorX="center" anchorY="middle" raycast={NOOP_RAYCAST}>
        {obj.type.toUpperCase()}
      </Text>
      {/* Auto furniture based on room type */}
      <RoomFurniture type={obj.type} w={obj.w - 0.28} d={obj.d - 0.28} />
      {(selected || hov) && editMode && <group position={[0, obj.h / 2, 0]}><SelectionBox w={obj.w} h={obj.h} d={obj.d} /></group>}
    </group>;
  }

  if (obj.kind === "wall") {
    return <group position={[obj.x, obj.y, obj.z]} rotation={[0, obj.rotY, 0]}>
      <mesh
        castShadow receiveShadow
        raycast={NOOP_RAYCAST}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
        onPointerDown={handleDown}
        onPointerUp={drag.onPointerUp}
        onPointerMove={drag.onPointerMove}
      >
        <boxGeometry args={[obj.w, obj.h, obj.d]} />
        <primitive object={wallMat} />
      </mesh>
      <HitMesh
        args={[obj.w + 0.04, obj.h + 0.04, obj.d + 0.04]}
        editMode={editMode}
        onPointerOver={handleOver}
        onPointerOut={handleOut}
        onPointerDown={handleDown}
        onPointerUp={drag.onPointerUp}
        onPointerMove={drag.onPointerMove}
      />
      {(selected || hov) && editMode && <SelectionBox w={obj.w} h={obj.h} d={obj.d} />}
    </group>;
  }

  return <group position={[obj.x, obj.y, obj.z]} rotation={[0, obj.rotY, 0]}>
    <HitMesh
      args={[obj.w + 0.1, obj.h + 0.1, obj.d + 0.1]}
      editMode={editMode}
      onPointerOver={handleOver}
      onPointerOut={handleOut}
      onPointerDown={handleDown}
      onPointerUp={drag.onPointerUp}
      onPointerMove={drag.onPointerMove}
    />
    <FurnitureMesh type={obj.type} />
    {editMode && (selected || hov) && <SelectionBox w={obj.w} h={obj.h} d={obj.d} />}
  </group>;
}

// ─── Room accent colours ──────────────────────────────────────────────────────
const ROOM_COLORS: Record<string, string> = { living: "#0bc8c8", bedroom: "#4a9de8", kitchen: "#2cb46e", bathroom: "#9b72d4", office: "#e8c33a", garage: "#8fa0a0", utility: "#e08050", dining: "#e07060", hallway: "#6080a0" };
const roomColor = (t: string) => Object.entries(ROOM_COLORS).find(([k]) => t.toLowerCase().includes(k))?.[1] ?? "#5a7080";

// ─── Palettes ─────────────────────────────────────────────────────────────────
const PALETTE_ROOMS = [
  { type: "Living Room", w: 5, h: 3.2, d: 4, color: "#1a2a2a" }, { type: "Bedroom", w: 4, h: 3.2, d: 3.5, color: "#1a2030" },
  { type: "Kitchen", w: 3.5, h: 3.2, d: 3, color: "#1a2820" }, { type: "Bathroom", w: 2.5, h: 3.2, d: 2.5, color: "#20182a" },
  { type: "Dining", w: 3.5, h: 3.2, d: 3, color: "#2a2018" }, { type: "Office", w: 3, h: 3.2, d: 3, color: "#2a2a18" },
  { type: "Hallway", w: 1.5, h: 3.2, d: 4, color: "#1e2030" }, { type: "Garage", w: 5.5, h: 3.2, d: 5, color: "#222222" },
];
const PALETTE_WALLS = [
  { type: "Wall H", w: 3, h: 2.8, d: 0.28, color: "#d8e2e8" }, { type: "Wall V", w: 0.28, h: 2.8, d: 3, color: "#d8e2e8" },
  { type: "Short Wall", w: 1.5, h: 2.8, d: 0.28, color: "#d8e2e8" }, { type: "Half Wall", w: 2, h: 1.2, d: 0.28, color: "#c8d0d8" },
  { type: "Thick Wall", w: 3, h: 2.8, d: 0.45, color: "#c0ccd8" }, { type: "Tall Wall", w: 3, h: 4.0, d: 0.28, color: "#d8e2e8" },
];
const PALETTE_OBJECTS = [
  { type: "Chair", w: 0.6, h: 0.9, d: 0.55, color: "#3a5070" }, { type: "Sofa", w: 2.0, h: 0.85, d: 0.88, color: "#3a5070" },
  { type: "Bed", w: 1.7, h: 0.55, d: 2.1, color: "#5a4a6a" }, { type: "Table", w: 1.2, h: 0.76, d: 0.7, color: "#7c5a38" },
  { type: "Desk", w: 1.4, h: 0.75, d: 0.65, color: "#7c5a38" }, { type: "Bookshelf", w: 0.9, h: 1.8, d: 0.32, color: "#5a3a20" },
  { type: "Wardrobe", w: 1.2, h: 1.9, d: 0.58, color: "#5a4a32" }, { type: "Bathtub", w: 0.8, h: 0.55, d: 1.55, color: "#e8e4de" },
  { type: "Counter", w: 2.0, h: 0.9, d: 0.62, color: "#c8c8c8" }, { type: "Plant", w: 0.4, h: 0.65, d: 0.4, color: "#2a7a2a" },
  { type: "TV Stand", w: 1.6, h: 0.9, d: 0.42, color: "#252832" }, { type: "Lamp", w: 0.35, h: 1.5, d: 0.35, color: "#c8a840" },
  { type: "Toilet", w: 0.42, h: 0.78, d: 0.6, color: "#e8e4de" }, { type: "Sink", w: 0.6, h: 0.85, d: 0.5, color: "#e8e4de" },
  { type: "Fridge", w: 0.72, h: 1.75, d: 0.7, color: "#d0d8e0" },
];

// ─── Initial scene builder — PROPER GRID LAYOUT matching floor plan ───────────
function buildInitialObjects(rooms: any[]): SceneObj[] {
  const floor1 = rooms.filter(r => (r.floor ?? 1) === 1);
  if (!floor1.length) return [];

  const FH = 3.2;
  const OWT = 0.28;
  const IWT = 0.14;

  const ORDER = ["living", "kitchen", "dining", "bedroom", "bedroom", "bathroom", "office", "utility", "garage"];
  const sorted = [...floor1].sort((a, b) => {
    const ai = ORDER.findIndex(o => a.type.toLowerCase().includes(o));
    const bi = ORDER.findIndex(o => b.type.toLowerCase().includes(o));
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  // Group rooms into rows by category (same as floor plan)
  const pubT = ["living", "kitchen", "dining"];
  const prvT = ["bedroom", "bathroom"];
  const svcT = ["office", "utility", "garage", "corridor"];
  const rows: any[][] = [
    sorted.filter(r => pubT.some(t => r.type.toLowerCase().includes(t))),
    sorted.filter(r => prvT.some(t => r.type.toLowerCase().includes(t))),
    sorted.filter(r => svcT.some(t => r.type.toLowerCase().includes(t))),
  ].filter(row => row.length > 0);

  const normSz = (r: any) => {
    const t = r.type.toLowerCase();
    if (t.includes("living"))   return { w: Math.max(4.5, Math.min(7, r.width ?? 5)),    d: Math.max(4, Math.min(6, r.height ?? 4.5)) };
    if (t.includes("kitchen"))  return { w: Math.max(3.5, Math.min(5.5, r.width ?? 4)),  d: Math.max(3, Math.min(5, r.height ?? 3.5)) };
    if (t.includes("dining"))   return { w: Math.max(3, Math.min(5, r.width ?? 3.5)),    d: Math.max(3, Math.min(4.5, r.height ?? 3.5)) };
    if (t.includes("bedroom"))  return { w: Math.max(3.2, Math.min(5, r.width ?? 4)),    d: Math.max(3, Math.min(4.5, r.height ?? 3.5)) };
    if (t.includes("bathroom")) return { w: Math.max(2, Math.min(3.5, r.width ?? 2.5)),  d: Math.max(2, Math.min(3.2, r.height ?? 2.5)) };
    if (t.includes("office"))   return { w: Math.max(3, Math.min(4.5, r.width ?? 3.5)),  d: Math.max(3, Math.min(4, r.height ?? 3)) };
    if (t.includes("garage"))   return { w: Math.max(4.5, Math.min(7, r.width ?? 5.5)),  d: Math.max(4, Math.min(6, r.height ?? 5)) };
    return { w: Math.max(2.5, Math.min(4, r.width ?? 3)), d: Math.max(2, Math.min(3.5, r.height ?? 3)) };
  };

  const rowData = rows.map(row => ({
    totalW: row.reduce((s: number, r: any) => s + normSz(r).w, 0),
    maxH: Math.max(...row.map((r: any) => normSz(r).d)),
    rooms: row,
  }));
  const maxW = Math.max(...rowData.map(r => r.totalW));

  type LR = { room: any; px: number; pz: number; pw: number; pd: number };
  const laid: LR[] = [];
  let curZ = 0;
  rowData.forEach(({ totalW, maxH, rooms: row }) => {
    const scale = totalW < maxW ? maxW / totalW : 1;
    let curX = 0;
    row.forEach((r: any) => {
      const sz = normSz(r);
      const rw = sz.w * scale;
      const rd = sz.d;
      laid.push({ room: r, px: curX, pz: curZ, pw: rw, pd: rd });
      curX += rw;
    });
    curZ += maxH;
  });

  const totalW = maxW;
  const totalD = rowData.reduce((s, r) => s + r.maxH, 0);
  const offX = -totalW / 2;
  const offZ = -totalD / 2;

  let id = 0;
  const objs: SceneObj[] = [];

  // Add room floors and ghost walls
  laid.forEach(({ room, px, pz, pw, pd }) => {
    const t = room.type.toLowerCase();
    const floorColor = t.includes("bathroom") ? "#2a3a3a" : t.includes("kitchen") ? "#1e2e2e" : "#1a2828";
    const cx = offX + px + pw / 2;
    const cz = offZ + pz + pd / 2;
    objs.push({
      id: `room-${id++}`, kind: "room", type: room.type,
      x: cx, y: FH / 2, z: cz, rotY: 0,
      w: pw, h: FH, d: pd,
      color: floorColor,
    });
  });

  // Outer perimeter walls
  objs.push({ id: `wall-n-${id++}`, kind: "wall", type: "Wall", x: 0, y: FH / 2, z: offZ - OWT / 2, rotY: 0, w: totalW + OWT * 2, h: FH, d: OWT, color: "#d8e2e8" });
  objs.push({ id: `wall-s-${id++}`, kind: "wall", type: "Wall", x: 0, y: FH / 2, z: offZ + totalD + OWT / 2, rotY: 0, w: totalW + OWT * 2, h: FH, d: OWT, color: "#d8e2e8" });
  objs.push({ id: `wall-w-${id++}`, kind: "wall", type: "Wall", x: offX - OWT / 2, y: FH / 2, z: 0, rotY: 0, w: OWT, h: FH, d: totalD + OWT * 2, color: "#d8e2e8" });
  objs.push({ id: `wall-e-${id++}`, kind: "wall", type: "Wall", x: offX + totalW + OWT / 2, y: FH / 2, z: 0, rotY: 0, w: OWT, h: FH, d: totalD + OWT * 2, color: "#d8e2e8" });

  // Interior divider walls
  laid.forEach(({ px, pz, pw, pd }) => {
    const roomRight  = px + pw < totalW - 0.01;
    const roomBottom = pz + pd < totalD - 0.01;
    if (roomRight) {
      objs.push({ id: `iwall-v-${id++}`, kind: "wall", type: "Wall", x: offX + px + pw, y: FH / 2, z: offZ + pz + pd / 2, rotY: 0, w: IWT, h: FH, d: pd, color: "#c8d4da" });
    }
    if (roomBottom) {
      objs.push({ id: `iwall-h-${id++}`, kind: "wall", type: "Wall", x: offX + px + pw / 2, y: FH / 2, z: offZ + pz + pd, rotY: 0, w: pw, h: FH, d: IWT, color: "#c8d4da" });
    }
  });

  return objs;
}

// ─── Properties panel ─────────────────────────────────────────────────────────
function PropertiesPanel({ obj, onUpdate, onDelete, onDuplicate, onDeselect }: {
  obj: SceneObj; onUpdate: (p: Partial<SceneObj>) => void;
  onDelete: () => void; onDuplicate: () => void; onDeselect: () => void;
}) {
  const S8: React.CSSProperties = { fontSize: 8, fontFamily: "'DM Mono',monospace" };
  const SL = ({ label, val, min, max, step, k }: { label: string; val: number; min: number; max: number; step: number; k: keyof SceneObj }) => (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ ...S8, color: "rgba(13,242,242,0.6)" }}>{label}</span>
        <span style={{ ...S8, color: "white" }}>{(val as number).toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => onUpdate({ [k]: parseFloat(e.target.value) } as any)}
        style={{ width: "100%", accentColor: "#0df2f2", cursor: "pointer" }} />
    </div>
  );
  const TEX: TexType[] = ["none", "brick", "concrete", "wood", "plaster", "marble", "tile"];
  return <div style={{ padding: 10, background: "rgba(13,242,242,0.06)", border: "1px solid rgba(13,242,242,0.28)", borderRadius: 8, marginBottom: 8 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
      <div style={{ fontSize: 9, color: "#0df2f2", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        ✦ {obj.kind === "wall" ? "Wall" : obj.type}
      </div>
      <div style={{ display: "flex", gap: 3 }}>
        <button onClick={onDuplicate} title="Duplicate" style={{ background: "rgba(13,242,242,0.1)", border: "1px solid rgba(13,242,242,0.3)", borderRadius: 4, color: "#0df2f2", cursor: "pointer", fontSize: 12, padding: "1px 7px", lineHeight: 1.6 }}>⧉</button>
        <button onClick={onDelete} title="Delete" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: 12, padding: "1px 7px", lineHeight: 1.6 }}>×</button>
        <button onClick={onDeselect} title="Deselect" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#64748b", cursor: "pointer", fontSize: 10, padding: "1px 7px", lineHeight: 1.6 }}>✕</button>
      </div>
    </div>
    <SL label="X Position" val={obj.x} min={-30} max={30} step={0.25} k="x" />
    <SL label="Z Position" val={obj.z} min={-30} max={30} step={0.25} k="z" />
    <SL label="Rotation Y°" val={obj.rotY} min={-Math.PI} max={Math.PI} step={0.05} k="rotY" />
    {(obj.kind === "wall" || obj.kind === "room") && <>
      <SL label="Width" val={obj.w} min={0.3} max={14} step={0.25} k="w" />
      <SL label="Depth" val={obj.d} min={0.14} max={14} step={0.14} k="d" />
      <SL label="Height" val={obj.h} min={0.8} max={6} step={0.1} k="h" />
    </>}
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
      <span style={{ ...S8, color: "rgba(13,242,242,0.6)", flex: 1 }}>Colour</span>
      <input type="color" value={obj.color} onChange={e => onUpdate({ color: e.target.value })}
        style={{ width: 26, height: 20, border: "1px solid rgba(13,242,242,0.3)", borderRadius: 3, cursor: "pointer", background: "none", padding: 1 }} />
      <span style={{ ...S8, color: "#94a3b8" }}>{obj.color}</span>
    </div>
    {obj.kind !== "object" && <>
      <div style={{ ...S8, color: "rgba(13,242,242,0.4)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>Texture</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 2, marginBottom: 7 }}>
        {TEX.map(t => (
          <button key={t} onClick={() => onUpdate({ tex: t })} style={{
            padding: "3px 1px", fontSize: 6.5, fontWeight: 600, cursor: "pointer",
            background: obj.tex === t ? "rgba(13,242,242,0.2)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${obj.tex === t ? "rgba(13,242,242,0.5)" : "rgba(255,255,255,0.06)"}`,
            borderRadius: 3, color: obj.tex === t ? "#0df2f2" : "#64748b", textTransform: "capitalize"
          }}>{t === "none" ? "Plain" : t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      {obj.kind === "wall" && <>
        <div style={{ ...S8, color: "rgba(13,242,242,0.4)", marginBottom: 4, textTransform: "uppercase" }}>Colour Presets</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
          {[{ l: "White", c: "#f0eeec" }, { l: "Beige", c: "#d4c4a8" }, { l: "Grey", c: "#8a9aa8" }, { l: "Terracotta", c: "#c06040" }, { l: "Sage", c: "#7a9a78" }, { l: "Slate", c: "#3a4a5a" }].map(p => (
            <button key={p.l} onClick={() => onUpdate({ color: p.c })}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 5px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 3, cursor: "pointer", color: "#94a3b8", fontSize: 7 }}>
              <span style={{ width: 9, height: 9, borderRadius: 1, background: p.c, flexShrink: 0 }} />{p.l}
            </button>
          ))}
        </div>
      </>}
    </>}
  </div>;
}

// ─── Palette button ───────────────────────────────────────────────────────────
function PalBtn({ item, onClick, children }: { item: any; onClick: () => void; children: React.ReactNode }) {
  const [hov, setHov] = useState(false);
  return <button onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
    style={{
      display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "7px 3px",
      background: hov ? "rgba(13,242,242,0.1)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${hov ? "rgba(13,242,242,0.4)" : "rgba(255,255,255,0.07)"}`,
      borderRadius: 6, cursor: "pointer", transition: "all 0.12s", width: "100%"
    }}>
    {children}
    <span style={{ fontSize: 7.5, color: hov ? "#0df2f2" : "#64748b", fontFamily: "'DM Mono',monospace", textAlign: "center", lineHeight: 1.2 }}>{item.type}</span>
  </button>;
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────
function RoomSvg({ type, color }: { type: string; color: string }) {
  const t = type.toLowerCase();
  return <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
    <rect x="2" y="2" width="22" height="22" rx="2.5" fill={color} fillOpacity="0.25" stroke={color} strokeWidth="1.5" />
    {t.includes("bed") && <><rect x="7" y="9" width="12" height="8" rx="1" fill={color} fillOpacity="0.7" /><rect x="7" y="7" width="12" height="3" rx="1" fill={color} /></>}
    {t.includes("bath") && <><ellipse cx="13" cy="14" rx="5" ry="4" fill={color} fillOpacity="0.6" /><rect x="10" y="7" width="6" height="2.5" rx="1" fill={color} /></>}
    {t.includes("kitch") && <><rect x="6" y="8" width="14" height="7" rx="1" fill={color} fillOpacity="0.5" /><circle cx="10" cy="8" r="2.2" fill={color} /><circle cx="16" cy="8" r="2.2" fill={color} /></>}
    {t.includes("living") && <><rect x="5" y="13" width="11" height="5" rx="1.5" fill={color} fillOpacity="0.7" /><rect x="5" y="9" width="16" height="2.5" rx="1" fill={color} fillOpacity="0.4" /><rect x="4" y="13" width="2.5" height="5" rx="1" fill={color} /><rect x="19.5" y="13" width="2.5" height="5" rx="1" fill={color} /></>}
    {t.includes("office") && <><rect x="5" y="11" width="12" height="6" rx="1" fill={color} fillOpacity="0.5" /><rect x="9" y="7" width="6" height="5" rx="0.5" fill={color} fillOpacity="0.7" /></>}
    {(t.includes("hall") || t.includes("dinin") || t.includes("garag") || t.includes("util")) && <rect x="5" y="6" width="16" height="14" rx="1" fill={color} fillOpacity="0.35" />}
  </svg>;
}
function WallSvg() {
  return <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
    <rect x="2" y="10" width="22" height="6" rx="1.5" fill="#8aa0b0" fillOpacity="0.7" stroke="#8aa0b0" strokeWidth="1" />
    <line x1="2" y1="13" x2="24" y2="13" stroke="white" strokeWidth="0.5" strokeOpacity="0.3" />
  </svg>;
}
function ObjSvg({ type, color }: { type: string; color: string }) {
  const t = type.toLowerCase();
  return <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
    {t === "chair" && <><rect x="8" y="6" width="10" height="8" rx="1" fill={color} fillOpacity="0.55" /><rect x="8" y="13" width="10" height="7" rx="1" fill={color} fillOpacity="0.8" /><rect x="7" y="5" width="2" height="16" rx="0.5" fill={color} fillOpacity="0.5" /></>}
    {t === "sofa" && <><rect x="3" y="12" width="20" height="8" rx="2" fill={color} fillOpacity="0.7" /><rect x="3" y="10" width="20" height="5" rx="1" fill={color} fillOpacity="0.4" /><rect x="3" y="10" width="3" height="10" rx="1.5" fill={color} /><rect x="20" y="10" width="3" height="10" rx="1.5" fill={color} /></>}
    {t === "bed" && <><rect x="3" y="10" width="20" height="11" rx="2" fill={color} fillOpacity="0.55" /><rect x="3" y="10" width="20" height="4" rx="1.5" fill={color} /></>}
    {(t === "table" || t === "desk") && <><rect x="4" y="9" width="18" height="4" rx="1" fill={color} /><rect x="5" y="13" width="3" height="8" rx="0.5" fill={color} fillOpacity="0.7" /><rect x="18" y="13" width="3" height="8" rx="0.5" fill={color} fillOpacity="0.7" /></>}
    {t === "lamp" && <><line x1="13" y1="5" x2="13" y2="16" stroke={color} strokeWidth="2.5" /><polygon points="8,16 18,16 16,22 10,22" fill={color} fillOpacity="0.7" /><circle cx="13" cy="5" r="4" fill={color} fillOpacity="0.9" /></>}
    {t === "plant" && <><ellipse cx="13" cy="10" rx="7" ry="8" fill={color} fillOpacity="0.75" /><rect x="11" y="17" width="4" height="6" rx="1" fill="#8a6030" /></>}
    {!["chair", "sofa", "bed", "table", "desk", "lamp", "plant"].includes(t) && <rect x="5" y="5" width="16" height="16" rx="2" fill={color} fillOpacity="0.6" stroke={color} strokeWidth="1" />}
  </svg>;
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Model3DPage() {
  const params = useParams();
  const plotId = params.id as string;
  const { floorPlan, analysis } = useEco3DStore();
  const rooms = floorPlan?.layout ?? [];
  const windDir = analysis?.environmental?.wind_direction ?? "NW";
  const sunHours = analysis?.environmental?.sun_exposure_hours ?? 8.2;

  const [objects, setObjects] = useState<SceneObj[]>(() => buildInitialObjects(rooms));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<"rooms" | "walls" | "objects" | "glass">("rooms");
  const [showGrid, setShowGrid] = useState(true);
  const [showSun, setShowSun] = useState(true);
  const [showWind, setShowWind] = useState(false);
  const [nightLight, setNightLight] = useState(false);
  const [showRain, setShowRain] = useState(false);
  const [showSnow, setShowSnow] = useState(false);
  const [showMoon, setShowMoon] = useState(false);
  const [showFlood, setShowFlood] = useState(false);
  const [showSolarSystem, setShowSolarSystem] = useState(false);
  const [renderQuality, setRenderQuality] = useState<"low"|"med"|"high">("high");
  const [showShaders, setShowShaders] = useState(true);
  const [camMode, setCamMode] = useState<"iso" | "top" | "interior">("iso");
  const [fps, setFps] = useState(0);
  const [wallColor, setWallColor] = useState("#d8e2e8");
  const [texType, setTexType] = useState<TexType>("none");
  const [winColor, setWinColor] = useState("#1a90e8");
  const [winOpacity, setWinOpacity] = useState(0.5);
  const nid = useRef(5000);
  const selected = objects.find(o => o.id === selectedId) ?? null;

  // Rebuild scene when floor plan data loads
  useEffect(() => {
    if (rooms.length > 0) {
      setObjects(buildInitialObjects(rooms));
    }
  }, [floorPlan]);

  // Compute model bounds for WindSwirl
  const modelBounds = useMemo(() => {
    const roomObjs = objects.filter(o => o.kind === "room");
    if (!roomObjs.length) return { w: 12, d: 10 };
    const xs = roomObjs.map(o => o.w); const ds = roomObjs.map(o => o.d);
    return { w: Math.max(...xs) * 2, d: Math.max(...ds) * 2 };
  }, [objects]);

  useEffect(() => {
    let frames = 0, last = performance.now();
    const id = setInterval(() => { const now = performance.now(); frames++; if (now - last > 1000) { setFps(Math.round(frames * 1000 / (now - last))); frames = 0; last = now; } }, 120);
    return () => clearInterval(id);
  }, []);

  const updateObject = useCallback((id: string, patch: Partial<SceneObj>) =>
    setObjects(p => p.map(o => o.id === id ? { ...o, ...patch } : o)), []);
  const deleteObject = useCallback((id: string) => { setObjects(p => p.filter(o => o.id !== id)); setSelectedId(null); }, []);
  const duplicateObject = useCallback((id: string) => {
    const obj = objects.find(o => o.id === id); if (!obj) return;
    const n: SceneObj = { ...obj, id: `obj-${nid.current++}`, x: obj.x + 1.5, z: obj.z + 1.5 };
    setObjects(p => [...p, n]); setSelectedId(n.id);
  }, [objects]);
  const addFromPalette = useCallback((item: any, kind: ObjKind) => {
    const n: SceneObj = {
      id: `obj-${nid.current++}`, kind, type: item.type,
      x: (Math.random() - 0.5) * 8, y: item.h / 2,
      z: (Math.random() - 0.5) * 8, rotY: 0,
      w: item.w, h: item.h ?? 2.8, d: item.d ?? item.w,
      color: item.color ?? wallColor,
      tex: kind === "wall" ? texType : undefined,
    };
    setObjects(p => [...p, n]); setSelectedId(n.id);
  }, [wallColor, texType]);

  const handleDragChange = useCallback((d: boolean) => setIsDragging(d), []);

  const camCfg = {
    iso: { pos: [20, 16, 20] as [number, number, number], fov: 46 },
    top: { pos: [0, 30, 0.001] as [number, number, number], fov: 52 },
    interior: { pos: [2, 2.4, 2] as [number, number, number], fov: 70 }
  };
  const cam = camCfg[camMode];

  const SL = ({ label, val, min, max, step, onChange }: { label: string; val: number; min: number; max: number; step: number; onChange: (v: number) => void }) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ fontSize: 8, color: "rgba(13,242,242,0.6)", fontFamily: "'DM Mono',monospace" }}>{label}</span>
        <span style={{ fontSize: 8, color: "white", fontFamily: "'DM Mono',monospace" }}>{val.toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val} onChange={e => onChange(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "#0df2f2", cursor: "pointer" }} />
    </div>
  );

  const Tab = ({ t, label }: { t: typeof activeTab; label: string }) => (
    <button onClick={() => setActiveTab(t)} style={{
      flex: 1, padding: "5px 2px", fontSize: 7.5, fontWeight: 700, cursor: "pointer",
      background: activeTab === t ? "rgba(13,242,242,0.15)" : "rgba(0,0,0,0.35)",
      border: `1px solid ${activeTab === t ? "rgba(13,242,242,0.4)" : "rgba(255,255,255,0.06)"}`,
      borderRadius: 4, color: activeTab === t ? "#0df2f2" : "#475569", fontFamily: "'DM Mono',monospace",
      textTransform: "uppercase", letterSpacing: "0.05em"
    }}>{label}</button>
  );
  const PanelSection = ({ title }: { title: string }) => (
    <div style={{ fontSize: 8, color: "rgba(13,242,242,0.5)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>{title}</div>
  );

  return <>
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@300;400;600;700&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />

    <div style={{ width: "100vw", height: "100vh", background: "#060e0e", display: "flex", flexDirection: "column", fontFamily: "'DM Sans',sans-serif", overflow: "hidden" }}>

      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 20px", background: "rgba(4,10,10,0.99)", borderBottom: "1px solid rgba(255,255,255,0.06)", flexShrink: 0, zIndex: 10 }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <span className="material-symbols-outlined" style={{ color: "#0df2f2", fontSize: 20 }}>deployed_code</span>
          <div>
            <div style={{ color: "white", fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em" }}>ECO-3D <span style={{ color: "rgba(13,242,242,0.5)", fontWeight: 300 }}>Studio</span></div>
            <div style={{ fontSize: 7.5, color: "#475569", textTransform: "uppercase", letterSpacing: "0.14em" }}>AI Architecture</div>
          </div>
        </Link>
        <nav style={{ display: "flex", gap: 2 }}>
          {[{ l: "Blueprint", h: `/analysis/${plotId}` }, { l: "Environment", h: `/environment/${plotId}` }, { l: "3D Model", h: `/model3d/${plotId}`, a: true }, { l: "Export", h: `/report/${plotId}` }].map(item => (
            <Link key={item.l} href={item.h} style={{ padding: "5px 14px", fontSize: 11, fontWeight: 500, textDecoration: "none", color: (item as any).a ? "#0df2f2" : "#64748b", borderBottom: (item as any).a ? "2px solid #0df2f2" : "2px solid transparent" }}>{item.l}</Link>
          ))}
        </nav>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => { setEditMode(v => !v); setSelectedId(null); }}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: editMode ? "rgba(13,242,242,0.15)" : "rgba(13,242,242,0.06)", border: `1px solid ${editMode ? "rgba(13,242,242,0.5)" : "rgba(13,242,242,0.2)"}`, borderRadius: 7, color: "#0df2f2", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{editMode ? "close" : "edit"}</span>
            {editMode ? "EXIT EDITOR" : "EDIT MODE"}
          </button>
          <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "#0df2f2", borderRadius: 7, color: "#060e0e", fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>EXPORT BIM
          </button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Left sidebar */}
        <div style={{ width: 136, flexShrink: 0, background: "rgba(5,9,9,0.98)", padding: "10px 9px", display: "flex", flexDirection: "column", gap: 7, borderRight: "1px solid rgba(255,255,255,0.05)", overflowY: "auto" }}>
          {[{ l: "Sun", v: `${windDir} · ${sunHours.toFixed(1)}h` }, { l: "Wind", v: `Prevailing ${windDir}` }, { l: "Objects", v: `${objects.length} in scene` }].map(({ l, v }) => (
            <div key={l} style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)", borderRadius: 6, padding: "7px 9px" }}>
              <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 3 }}>{l}</div>
              <div style={{ fontSize: 10, color: "white", fontWeight: 600, lineHeight: 1.4 }}>{v}</div>
            </div>
          ))}
          <div style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)", borderRadius: 6, padding: "7px 9px" }}>
            <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>Camera</div>
            {([["iso", "Isometric"], ["top", "Top-Down"], ["interior", "Interior"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => setCamMode(v)} style={{ display: "block", width: "100%", padding: "4px 6px", marginBottom: 3, background: camMode === v ? "rgba(13,242,242,0.15)" : "transparent", border: `1px solid ${camMode === v ? "rgba(13,242,242,0.3)" : "rgba(255,255,255,0.05)"}`, borderRadius: 4, color: camMode === v ? "#0df2f2" : "#64748b", fontSize: 9, cursor: "pointer", textAlign: "left", fontFamily: "'DM Mono',monospace" }}>{l}</button>
            ))}
          </div>
          <div style={{ background: "rgba(13,242,242,0.04)", border: "1px solid rgba(13,242,242,0.08)", borderRadius: 6, padding: "7px 9px" }}>
            <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Overlays</div>
            {[{ l: "Sun", active: showSun, fn: () => setShowSun(v => !v) }, { l: "Grid", active: showGrid, fn: () => setShowGrid(v => !v) }].map(({ l, active, fn }) => (
              <button key={l} onClick={fn} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "4px 0", background: "none", border: "none", cursor: "pointer", marginBottom: 2 }}>
                <span style={{ fontSize: 9, color: "#64748b", fontFamily: "'DM Mono',monospace" }}>{l}</span>
                <span style={{ width: 24, height: 12, borderRadius: 6, background: active ? "#0df2f2" : "#1e2a2a", display: "block", position: "relative", transition: "background 0.2s" }}>
                  <span style={{ position: "absolute", top: 2, left: active ? 10 : 2, width: 8, height: 8, borderRadius: "50%", background: active ? "#060e0e" : "#475569", transition: "left 0.2s" }} />
                </span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: "auto", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#0df2f2", fontFamily: "'DM Mono',monospace", fontWeight: 500 }}>{fps} FPS</div>
            <div style={{ fontSize: 8, color: "#334155", fontFamily: "'DM Mono',monospace" }}>{objects.length} objects</div>
          </div>
        </div>

        {/* Canvas area */}
        <div style={{ flex: 1, position: "relative", minWidth: 0, height: "100%" }}>
          <ThreeErrorBoundary>
            <Canvas
              shadows={{ type: THREE.PCFSoftShadowMap }}
              camera={{ position: cam.pos, fov: cam.fov, near: 0.1, far: 400 }}
              style={{ background: "#020608", height: "100%", width: "100%" }}
              gl={{
                antialias: true,
                alpha: false,
                powerPreference: "high-performance",
                stencil: false,
                depth: true,
                toneMapping: THREE.ACESFilmicToneMapping,
                toneMappingExposure: showMoon ? 0.4 : showSun ? 1.1 : 0.75,
              }}
              dpr={Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, renderQuality === "high" ? 2 : renderQuality === "med" ? 1.5 : 1)}
              key={camMode}
              onPointerMissed={() => { if (editMode) setSelectedId(null); }}>
              <Suspense fallback={null}>
                {/* PBR environment — IBL image-based lighting for all surfaces */}
                <PBREnvironment sunOn={showSun} nightMode={showMoon || (!showSun && !nightLight)} />

                {/* Scene lights + weather effects */}
                <Lighting dir={windDir} sunOn={showSun} nightLightOn={nightLight} />

                {/* Shader ground replaces plain mesh ground */}
                <PBRGround showGrid={showGrid} wet={showFlood} />

                {/* All scene objects */}
                {objects.map(obj => (
                  <SceneObject key={obj.id} obj={obj} selected={selectedId === obj.id}
                    editMode={editMode}
                    onSelect={id => setSelectedId(p => p === id ? null : id)}
                    onUpdate={updateObject}
                    onDragChange={handleDragChange} />
                ))}

                {/* Sky & environment overlays */}
                {showSun && <SunSphere dir={windDir} />}
                {showWind && <WindSwirl dir={windDir} modelW={modelBounds.w} modelD={modelBounds.d} />}
                {showRain && <Rain />}
                {showSnow && <Snow />}
                {showMoon && <Moonlight />}
                {showFlood && <Flood />}
                {showSolarSystem && <SolarSystem />}

                {editMode && <gridHelper args={[60, 60, "#0df2f2", "#0a3030"]} position={[0, 0.21, 0]} raycast={NOOP_RAYCAST} />}

                <OrbitControls makeDefault
                  enabled={!isDragging}
                  enablePan={!isDragging}
                  enableRotate={!isDragging}
                  enableZoom
                  target={[0, 1.5, 0]}
                  minPolarAngle={0.0} maxPolarAngle={Math.PI}
                  minDistance={3} maxDistance={90} />

                {/* Post-processing render pipeline — Blender-quality output */}
                {showShaders && <RenderPipeline quality={renderQuality} />}
              </Suspense>
            </Canvas>
          </ThreeErrorBoundary>

          {/* ── RIGHT TOOLBAR (Wind / Sun / Light / Grid toggles) ── */}
          <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 6 }}>
            {[
              { l: "WIND",  i: "air",           active: showWind,   fn: () => setShowWind(v => !v),   color: "#0df2f2" },
              { l: "SUN",   i: "wb_sunny",       active: showSun,    fn: () => setShowSun(v => !v),    color: "#f59e0b" },
              { l: "LIGHT", i: "lightbulb",      active: nightLight, fn: () => setNightLight(v => !v), color: "#fde047" },
              { l: "MOON",  i: "nights_stay",    active: showMoon,   fn: () => setShowMoon(v => !v),   color: "#a5b4fc" },
              { l: "RAIN",  i: "water_drop",     active: showRain,   fn: () => setShowRain(v => !v),   color: "#60a5fa" },
              { l: "SNOW",  i: "ac_unit",        active: showSnow,   fn: () => setShowSnow(v => !v),   color: "#e0f2fe" },
              { l: "FLOOD", i: "flood",          active: showFlood,  fn: () => setShowFlood(v => !v),  color: "#1d4ed8" },
              { l: "SOLAR", i: "public",          active: showSolarSystem, fn: () => setShowSolarSystem(v => !v), color: "#ffd700" },
              { l: "SHADER",i: "lens_blur",      active: showShaders,fn: () => setShowShaders(v=>!v),  color: "#e879f9" },
              { l: "GRID",  i: "grid_on",        active: showGrid,   fn: () => setShowGrid(v => !v),   color: "#0df2f2" },
            ].map(({ l, i, active, fn, color }) => (
              <button key={l} onClick={fn} style={{ width: 44, height: 44, background: active ? `${color}22` : "rgba(6,14,14,0.92)", border: `1px solid ${active ? `${color}88` : "rgba(255,255,255,0.06)"}`, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, cursor: "pointer", transition: "all 0.2s" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: active ? color : "#475569" }}>{i}</span>
                <span style={{ fontSize: 6, color: active ? color : "#334155", fontFamily: "monospace", letterSpacing: "0.06em" }}>{l}</span>
              </button>
            ))}
          </div>

          {/* Quality selector */}
          {showShaders && (
            <div style={{ position: "absolute", right: 62, bottom: 14, display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 7, color: "rgba(232,121,249,0.6)", fontFamily: "monospace", letterSpacing: "0.1em", marginRight: 2 }}>RENDER</span>
              {(["low","med","high"] as const).map(q => (
                <button key={q} onClick={() => setRenderQuality(q)} style={{
                  padding: "3px 8px", fontSize: 7, fontFamily: "monospace", cursor: "pointer",
                  background: renderQuality===q ? "rgba(232,121,249,0.18)" : "rgba(6,14,14,0.9)",
                  border: `1px solid ${renderQuality===q ? "rgba(232,121,249,0.5)" : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 4, color: renderQuality===q ? "#e879f9" : "#475569",
                  textTransform: "uppercase", letterSpacing: "0.08em",
                }}>
                  {q === "low" ? "PERF" : q === "med" ? "BALANCED" : "ULTRA"}
                </button>
              ))}
            </div>
          )}

          {/* HUD */}
          <div style={{ position: "absolute", top: 10, left: 10, display: "flex", flexDirection: "column", gap: 5, pointerEvents: "none" }}>
            {showSun && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#f59e0b" }}>wb_sunny</span>
              <span style={{ fontSize: 8.5, color: "#fbbf24", fontFamily: "'DM Mono',monospace" }}>SUN {windDir} · {sunHours.toFixed(1)}h/day</span>
            </div>}
            {showWind && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#60a5fa" }}>air</span>
              <span style={{ fontSize: 8.5, color: "#93c5fd", fontFamily: "'DM Mono',monospace" }}>WIND: Prevailing {windDir}</span>
            </div>}
            {nightLight && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(250,230,50,0.10)", border: "1px solid rgba(250,230,50,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#fde047" }}>lightbulb</span>
              <span style={{ fontSize: 8.5, color: "#fef08a", fontFamily: "'DM Mono',monospace" }}>Studio Lighting ON</span>
            </div>}
            {showMoon && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#a5b4fc" }}>nights_stay</span>
              <span style={{ fontSize: 8.5, color: "#c7d2fe", fontFamily: "'DM Mono',monospace" }}>Moonlight · Stars active</span>
            </div>}
            {showRain && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(37,99,235,0.12)", border: "1px solid rgba(37,99,235,0.3)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#60a5fa" }}>water_drop</span>
              <span style={{ fontSize: 8.5, color: "#93c5fd", fontFamily: "'DM Mono',monospace" }}>Rain simulation active</span>
            </div>}
            {showSnow && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(186,230,253,0.10)", border: "1px solid rgba(186,230,253,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#e0f2fe" }}>ac_unit</span>
              <span style={{ fontSize: 8.5, color: "#e0f2fe", fontFamily: "'DM Mono',monospace" }}>Snowfall simulation active</span>
            </div>}
            {showSolarSystem && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(255,215,0,0.10)", border: "1px solid rgba(255,215,0,0.30)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#ffd700" }}>public</span>
              <span style={{ fontSize: 8.5, color: "#ffe566", fontFamily: "'DM Mono',monospace" }}>Solar System · 8 planets orbiting</span>
            </div>}
            {showFlood && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(29,78,216,0.15)", border: "1px solid rgba(29,78,216,0.35)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#3b82f6" }}>flood</span>
              <span style={{ fontSize: 8.5, color: "#93c5fd", fontFamily: "'DM Mono',monospace" }}>⚠ Flood simulation active</span>
            </div>}
            {showShaders && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(232,121,249,0.08)", border: "1px solid rgba(232,121,249,0.2)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#e879f9" }}>lens_blur</span>
              <span style={{ fontSize: 8.5, color: "#d946ef", fontFamily: "'DM Mono',monospace" }}>PBR Shaders · {renderQuality.toUpperCase()} · SSAO · Bloom · DOF</span>
            </div>}
            {editMode && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(13,242,242,0.1)", border: "1px solid rgba(13,242,242,0.3)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#0df2f2" }}>edit</span>
              <span style={{ fontSize: 8.5, color: "#0df2f2", fontFamily: "'DM Mono',monospace" }}>
                {selected ? `${selected.type} · drag to move · sliders to resize/rotate` : "Click any object to select"}
              </span>
            </div>}
          </div>

          {/* Compass */}
          <div style={{ position: "absolute", top: 10, right: editMode ? 312 : 62, width: 32, height: 32, transition: "right 0.3s", pointerEvents: "none" }}>
            <svg width="32" height="32">
              <circle cx="16" cy="16" r="14" fill="rgba(6,14,14,0.9)" stroke="rgba(13,242,242,0.2)" strokeWidth="1" />
              <polygon points="16,4 19,16 16,14 13,16" fill="#0df2f2" />
              <polygon points="16,28 13,16 16,18 19,16" fill="#334155" />
              <text x="16" y="10" textAnchor="middle" fill="#0df2f2" fontSize="5.5" fontFamily="monospace" fontWeight="bold">N</text>
            </svg>
          </div>

          {/* Legend */}
          <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 6, padding: "5px 12px", background: "rgba(4,10,10,0.93)", borderRadius: 7, border: "1px solid rgba(13,242,242,0.08)", flexWrap: "wrap", justifyContent: "center", maxWidth: "70vw", pointerEvents: "none" }}>
            <span style={{ color: "rgba(13,242,242,0.35)", fontSize: 7.5, fontFamily: "'DM Mono',monospace", alignSelf: "center" }}>LEGEND</span>
            {Object.entries(ROOM_COLORS).filter(([k]) => objects.some(o => o.kind === "room" && o.type.toLowerCase().includes(k))).map(([k, c]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ width: 7, height: 7, borderRadius: 1, background: c, display: "inline-block" }} />
                <span style={{ color: "#94a3b8", fontSize: 7.5, fontFamily: "'DM Mono',monospace", textTransform: "capitalize" }}>{k}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right edit panel */}
        {editMode && (
          <div style={{ width: 300, flexShrink: 0, background: "rgba(3,8,8,0.99)", borderLeft: "1px solid rgba(13,242,242,0.1)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 2, padding: "8px 8px 0", flexShrink: 0 }}>
              <Tab t="rooms" label="Rooms" />
              <Tab t="walls" label="Walls" />
              <Tab t="objects" label="Objects" />
              <Tab t="glass" label="Glass" />
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "10px 10px 12px" }}>
              {selected && <PropertiesPanel obj={selected}
                onUpdate={p => updateObject(selected.id, p)}
                onDelete={() => deleteObject(selected.id)}
                onDuplicate={() => duplicateObject(selected.id)}
                onDeselect={() => setSelectedId(null)} />}

              {!selected && editMode && <div style={{ padding: "8px 10px", background: "rgba(13,242,242,0.03)", border: "1px solid rgba(13,242,242,0.08)", borderRadius: 6, marginBottom: 8, fontSize: 8, color: "rgba(255,255,255,0.3)", fontFamily: "'DM Mono',monospace", lineHeight: 1.7, textAlign: "center" }}>
                Click any object in the 3D view<br />to select · drag to move · sliders to resize/rotate
              </div>}

              {activeTab === "rooms" && <>
                <PanelSection title="Add Room" />
                <div style={{ fontSize: 7.5, color: "rgba(255,255,255,0.25)", marginBottom: 8, fontFamily: "'DM Mono',monospace", lineHeight: 1.6 }}>Click to place · Drag in 3D · Select to resize/rotate</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 12 }}>
                  {PALETTE_ROOMS.map(item => (
                    <PalBtn key={item.type} item={item} onClick={() => addFromPalette(item, "room")}>
                      <RoomSvg type={item.type} color={roomColor(item.type)} />
                    </PalBtn>
                  ))}
                </div>
              </>}

              {activeTab === "walls" && <>
                <PanelSection title="Add Wall" />
                <div style={{ fontSize: 7.5, color: "rgba(255,255,255,0.25)", marginBottom: 8, fontFamily: "'DM Mono',monospace", lineHeight: 1.6 }}>Click to place · Select to move/rotate/resize/texture</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 12 }}>
                  {PALETTE_WALLS.map(item => (
                    <PalBtn key={item.type} item={item} onClick={() => addFromPalette(item, "wall")}>
                      <WallSvg />
                    </PalBtn>
                  ))}
                </div>
                <PanelSection title="Global Wall Colour" />
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <input type="color" value={wallColor} onChange={e => setWallColor(e.target.value)} style={{ width: 26, height: 20, border: "1px solid rgba(13,242,242,0.3)", borderRadius: 3, cursor: "pointer", background: "none", padding: 1 }} />
                  <span style={{ fontSize: 8, color: "#94a3b8", fontFamily: "'DM Mono',monospace", flex: 1 }}>{wallColor}</span>
                  <button onClick={() => setObjects(p => p.map(o => o.kind === "wall" ? { ...o, color: wallColor } : o))}
                    style={{ fontSize: 7.5, color: "#0df2f2", background: "rgba(13,242,242,0.1)", border: "1px solid rgba(13,242,242,0.3)", borderRadius: 4, cursor: "pointer", padding: "3px 8px", fontFamily: "'DM Mono',monospace" }}>Apply all</button>
                </div>
                <PanelSection title="Colour Presets" />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
                  {[{ l: "Modern White", c: "#f0eeec" }, { l: "Warm Beige", c: "#d4c4a8" }, { l: "Urban Grey", c: "#8a9aa8" }, { l: "Terracotta", c: "#c06040" }, { l: "Sage Green", c: "#7a9a78" }, { l: "Dark Slate", c: "#3a4a5a" }, { l: "Cream", c: "#f5e6c8" }, { l: "Clay", c: "#b8805a" }].map(p => (
                    <button key={p.l} onClick={() => { setWallColor(p.c); if (selected && selected.kind === "wall") updateObject(selected.id, { color: p.c }); }}
                      style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 4, cursor: "pointer", color: "#94a3b8", fontSize: 7.5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 1, background: p.c, flexShrink: 0 }} />{p.l}
                    </button>
                  ))}
                </div>
              </>}

              {activeTab === "objects" && <>
                <PanelSection title="Furniture & Objects" />
                <div style={{ fontSize: 7.5, color: "rgba(255,255,255,0.25)", marginBottom: 8, fontFamily: "'DM Mono',monospace", lineHeight: 1.6 }}>Click to place · Drag to move · Select to rotate</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 3 }}>
                  {PALETTE_OBJECTS.map(item => (
                    <PalBtn key={item.type} item={item} onClick={() => addFromPalette(item, "object")}>
                      <ObjSvg type={item.type} color={item.color} />
                    </PalBtn>
                  ))}
                </div>
              </>}

              {activeTab === "glass" && <>
                <PanelSection title="Window Glass" />
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 8, color: "rgba(13,242,242,0.6)", fontFamily: "'DM Mono',monospace", flex: 1 }}>Glass Colour</span>
                  <input type="color" value={winColor} onChange={e => setWinColor(e.target.value)} style={{ width: 26, height: 20, border: "1px solid rgba(13,242,242,0.3)", borderRadius: 3, cursor: "pointer", background: "none", padding: 1 }} />
                </div>
                <SL label="Opacity" val={winOpacity} min={0.05} max={1.0} step={0.05} onChange={setWinOpacity} />
                <PanelSection title="Glass Presets" />
                {[{ l: "Sky Blue", c: "#1a90e8", o: 0.45 }, { l: "Ice Clear", c: "#c8e8ff", o: 0.2 }, { l: "Tinted Green", c: "#1a7040", o: 0.55 }, { l: "Bronze", c: "#8b6020", o: 0.5 }, { l: "Frosted", c: "#e0e4e8", o: 0.75 }, { l: "Mirror", c: "#a0b8c8", o: 0.85 }, { l: "Cobalt", c: "#0040c0", o: 0.4 }, { l: "Rose", c: "#e05080", o: 0.35 }].map(p => (
                  <button key={p.l} onClick={() => { setWinColor(p.c); setWinOpacity(p.o); }}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "5px 8px", marginBottom: 3, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 5, cursor: "pointer", color: "#94a3b8", fontSize: 8, textAlign: "left" }}>
                    <span style={{ width: 12, height: 12, borderRadius: 2, background: p.c, opacity: p.o + 0.2, flexShrink: 0, border: "1px solid rgba(255,255,255,0.15)" }} />{p.l}
                  </button>
                ))}
              </>}
            </div>

            {/* Scene list */}
            <div style={{ borderTop: "1px solid rgba(13,242,242,0.07)", padding: "8px 10px", maxHeight: 200, overflowY: "auto", flexShrink: 0, background: "rgba(2,6,6,0.8)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.4)", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "'DM Mono',monospace" }}>Scene ({objects.length})</div>
                <button onClick={() => { setObjects([]); setSelectedId(null); }} style={{ fontSize: 7.5, color: "#ef4444", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "'DM Mono',monospace" }}>Clear all</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {objects.map(obj => (
                  <div key={obj.id} onClick={() => setSelectedId(p => p === obj.id ? null : obj.id)}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 7px", background: selectedId === obj.id ? "rgba(13,242,242,0.1)" : "rgba(255,255,255,0.02)", border: `1px solid ${selectedId === obj.id ? "rgba(13,242,242,0.3)" : "rgba(255,255,255,0.04)"}`, borderRadius: 4, cursor: "pointer" }}>
                    <span style={{ width: 7, height: 7, borderRadius: 1, background: obj.kind === "wall" ? "#8aa0b0" : obj.kind === "room" ? roomColor(obj.type) : obj.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 8, color: selectedId === obj.id ? "#0df2f2" : "#64748b", fontFamily: "'DM Mono',monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {obj.kind === "room" ? "⬡" : obj.kind === "wall" ? "▬" : "◈"} {obj.type}
                    </span>
                    <button onClick={e => { e.stopPropagation(); deleteObject(obj.id); }}
                      style={{ fontSize: 10, color: "#475569", background: "none", border: "none", cursor: "pointer", padding: "0 2px", lineHeight: 1, flexShrink: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = "#ef4444")}
                      onMouseLeave={e => (e.currentTarget.style.color = "#475569")}>×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  </>;
}
