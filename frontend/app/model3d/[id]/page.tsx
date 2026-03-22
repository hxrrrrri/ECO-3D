"use client";
import { useRef, useMemo, Suspense, useState, useEffect, useLayoutEffect, useCallback, Component, type ReactNode } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text, Sky, useGLTF } from "@react-three/drei";

import * as THREE from "three";
import { useEco3DStore } from "@/store/useEco3DStore";
import { computeSunPosition, fetchLiveEnvironment } from "@/lib/liveEnvironment";

// ─── Constants ────────────────────────────────────────────────────────────────
const NOOP_RAYCAST = () => {};
// Capture ONCE at module level — never null, survives hot-reload
const REAL_RAYCAST = THREE.Mesh.prototype.raycast;
const SNAP = 0.25;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

type TexType = "none" | "brick" | "concrete" | "wood" | "plaster" | "marble" | "tile";
type ObjKind = "object" | "wall" | "room";
type RenderQuality = "low" | "med" | "high" | "ultra";
type TimeOfDayMode = "auto" | "day" | "night";
type ShaderLookPreset = "custom" | "golden-hour" | "cinematic-day" | "deep-night";
type GraphicsStylePreset = "default" | "minecraft" | "valorant" | "wuthering-waves" | "sakura-blooms";
type MusicTrackId = "night-slow" | "cinematic-chase-inspired" | "ambient-dusk";
type MusicPlaybackState = "idle" | "playing" | "paused" | "error";
type SceneObj = {
  id: string; kind: ObjKind; type: string;
  x: number; y: number; z: number; rotY: number;
  w: number; h: number; d: number;
  color: string; tex?: TexType;
};

type BlenderAssetEntry = {
  url: string;
  position?: [number, number, number];
  rotationDeg?: [number, number, number];
  scale?: number | [number, number, number];
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureMode?: "auto" | "pixelated" | "smooth";
  material?: {
    roughnessMin?: number;
    roughnessMax?: number;
    metalnessMin?: number;
    metalnessMax?: number;
    envMapIntensity?: number;
    normalScale?: number;
    saturation?: number;
    brightness?: number;
  };
};

type BlenderSurroundingsManifest = Partial<Record<GraphicsStylePreset, BlenderAssetEntry[]>>;
type SurroundingsRuntimeStatus = {
  source: "blender" | "procedural";
  loaded: number;
  expected: number;
};
type SurroundingsRenderMode = "blender" | "normal";

const PROFILE_SURROUNDINGS_GLB: Partial<Record<GraphicsStylePreset, string>> = {
  minecraft: "/models/surroundings/minecraft.glb",
  "sakura-blooms": "/models/surroundings/sakura-blooms.glb",
  valorant: "/models/surroundings/valorant.glb",
  "wuthering-waves": "/models/surroundings/wuthering-waves.glb",
};

const PROFILE_ASSET_MATERIAL_PRESET: Record<Exclude<GraphicsStylePreset, "default">, Required<NonNullable<BlenderAssetEntry["material"]>>> = {
  minecraft: {
    roughnessMin: 0.32,
    roughnessMax: 0.92,
    metalnessMin: 0.0,
    metalnessMax: 0.18,
    envMapIntensity: 0.62,
    normalScale: 1.0,
    saturation: 1.06,
    brightness: 1.03,
  },
  "sakura-blooms": {
    roughnessMin: 0.24,
    roughnessMax: 0.84,
    metalnessMin: 0.0,
    metalnessMax: 0.22,
    envMapIntensity: 0.74,
    normalScale: 1.0,
    saturation: 1.04,
    brightness: 1.05,
  },
  valorant: {
    roughnessMin: 0.3,
    roughnessMax: 0.88,
    metalnessMin: 0.02,
    metalnessMax: 0.3,
    envMapIntensity: 0.64,
    normalScale: 0.95,
    saturation: 0.98,
    brightness: 1.02,
  },
  "wuthering-waves": {
    roughnessMin: 0.26,
    roughnessMax: 0.86,
    metalnessMin: 0.02,
    metalnessMax: 0.32,
    envMapIntensity: 0.68,
    normalScale: 1.0,
    saturation: 0.99,
    brightness: 1.04,
  },
};

const BACKGROUND_TRACKS: { id: MusicTrackId; label: string; src: string }[] = [
  { id: "night-slow", label: "Night Slow", src: "/audio/night-slow-01.mp3" },
  { id: "cinematic-chase-inspired", label: "Cinematic Chase (Inspired)", src: "/audio/cinematic-chase-inspired.mp3" },
  { id: "ambient-dusk", label: "Ambient Dusk", src: "/audio/ambient-dusk.mp3" },
];

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

// ─── Procedural texture system ────────────────────────────────────────────────
// Generates high-quality 512px albedo + canvas-baked normal map for each material
// All noise/detail is generated mathematically — no image files needed

function _noise2d(x: number, y: number): number {
  // Smooth value noise via dot products
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => {
    let n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  return (
    h(ix,iy)*(1-ux)*(1-uy) + h(ix+1,iy)*ux*(1-uy) +
    h(ix,iy+1)*(1-ux)*uy   + h(ix+1,iy+1)*ux*uy
  );
}

function _fbm(x: number, y: number, oct: number): number {
  let v = 0, a = 0.5, fx = x, fy = y;
  for (let i = 0; i < oct; i++) { v += a * _noise2d(fx, fy); fx *= 2.1; fy *= 2.1; a *= 0.5; }
  return v;
}

// Build heightfield pixel array (used to derive normal maps)
function _buildHeightfield(sz: number, fn: (x:number,y:number)=>number): Float32Array {
  const h = new Float32Array(sz * sz);
  for (let y = 0; y < sz; y++)
    for (let x = 0; x < sz; x++)
      h[y * sz + x] = fn(x / sz, y / sz);
  return h;
}

// Convert heightfield to normal map canvas texture
function _heightToNormal(h: Float32Array, sz: number, strength: number): THREE.CanvasTexture {
  const cv = document.createElement("canvas"); cv.width = sz; cv.height = sz;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(sz, sz);
  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      const l = h[y*sz + Math.max(0, x-1)];
      const r2 = h[y*sz + Math.min(sz-1, x+1)];
      const u = h[Math.max(0,y-1)*sz + x];
      const d = h[Math.min(sz-1,y+1)*sz + x];
      const nx = (l - r2) * strength;
      const ny = (u - d) * strength;
      const nz = 1.0;
      const len = Math.sqrt(nx*nx+ny*ny+nz*nz);
      const i = (y*sz+x)*4;
      img.data[i]   = Math.round((nx/len*0.5+0.5)*255);
      img.data[i+1] = Math.round((ny/len*0.5+0.5)*255);
      img.data[i+2] = Math.round((nz/len*0.5+0.5)*255);
      img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeTexture(type: TexType, color: string): THREE.CanvasTexture {
  const sz = 512;
  const cv = document.createElement("canvas"); cv.width = sz; cv.height = sz;
  const ctx = cv.getContext("2d")!;
  const c = new THREE.Color(color);
  const R = c.r * 255, G = c.g * 255, B = c.b * 255;

  if (type === "brick") {
    const bw = 56, bh = 26, gap = 4;
    // Mortar base
    ctx.fillStyle = `rgb(${Math.round(R*0.55)},${Math.round(G*0.52)},${Math.round(B*0.48)})`; 
    ctx.fillRect(0, 0, sz, sz);
    for (let row = 0; row * (bh + gap) < sz + bh; row++) {
      const off = (row % 2) * (bw * 0.5 + gap * 0.5);
      for (let col = -1; col * (bw + gap) < sz + bw; col++) {
        const bx = col * (bw + gap) + off + gap;
        const by = row * (bh + gap) + gap;
        // Brick face — slight per-brick color variation
        const vr = (Math.random() - 0.5) * 22;
        const vg = (Math.random() - 0.5) * 12;
        const vb = (Math.random() - 0.5) * 10;
        ctx.fillStyle = `rgb(${Math.round(Math.min(255,Math.max(0,R+vr)))},${Math.round(Math.min(255,Math.max(0,G+vg)))},${Math.round(Math.min(255,Math.max(0,B+vb)))})`;
        ctx.fillRect(bx, by, bw - gap, bh - gap);
        // Surface noise per brick
        for (let k = 0; k < 60; k++) {
          const kx = bx + Math.random()*(bw-gap), ky = by + Math.random()*(bh-gap);
          const kv = (Math.random()-0.5)*18;
          ctx.fillStyle = `rgba(${kv>0?255:0},${kv>0?255:0},${kv>0?255:0},${Math.abs(kv)/200})`;
          ctx.fillRect(kx, ky, 2, 2);
        }
        // Subtle edge darkening (depth cue)
        ctx.strokeStyle = `rgba(0,0,0,0.15)`; ctx.lineWidth = 1.5;
        ctx.strokeRect(bx+0.75, by+0.75, bw-gap-1.5, bh-gap-1.5);
      }
    }
  } else if (type === "concrete") {
    ctx.fillStyle = `rgb(${Math.round(R)},${Math.round(G)},${Math.round(B)})`; ctx.fillRect(0,0,sz,sz);
    // Multi-scale noise layers
    for (let scale = 1; scale <= 4; scale++) {
      for (let y = 0; y < sz; y += scale) {
        for (let x = 0; x < sz; x += scale) {
          const n = _fbm(x*0.04*scale, y*0.04*scale, 3);
          const v = (n - 0.5) * 28 / scale;
          ctx.fillStyle = `rgba(${v>0?255:0},${v>0?255:0},${v>0?255:0},${Math.abs(v)/260})`;
          ctx.fillRect(x, y, scale, scale);
        }
      }
    }
    // Hairline cracks
    for (let c2 = 0; c2 < 4; c2++) {
      ctx.strokeStyle = `rgba(0,0,0,${0.08 + Math.random()*0.07})`; ctx.lineWidth = 0.6 + Math.random()*0.8;
      ctx.beginPath();
      let cx2 = Math.random()*sz, cy2 = Math.random()*sz;
      ctx.moveTo(cx2, cy2);
      for (let s = 0; s < 6; s++) { cx2 += (Math.random()-0.5)*60; cy2 += (Math.random()-0.5)*60; ctx.lineTo(cx2, cy2); }
      ctx.stroke();
    }
  } else if (type === "wood") {
    ctx.fillStyle = `rgb(${Math.round(R)},${Math.round(G)},${Math.round(B)})`; ctx.fillRect(0,0,sz,sz);
    // Grain rings — concentric sinusoidal variation
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const grain = Math.sin((x * 0.18) + Math.sin(y * 0.04) * 8 + _noise2d(x*0.02,y*0.015)*12) * 0.5 + 0.5;
        const knot  = Math.exp(-((x-sz*0.3)*(x-sz*0.3)+(y-sz*0.45)*(y-sz*0.45))/3800) * 0.3;
        const v = (grain * 0.7 + knot) * 34 - 17;
        if (Math.abs(v) > 2) {
          ctx.fillStyle = `rgba(${v>0?255:0},${v>0?200:0},${v>0?100:0},${Math.min(1,Math.abs(v)/80)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    // Pore lines
    for (let p = 0; p < 80; p++) {
      const px = Math.random()*sz;
      ctx.strokeStyle = `rgba(0,0,0,${0.06+Math.random()*0.08})`; ctx.lineWidth = 0.4+Math.random()*0.6;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px + (Math.random()-0.5)*30, sz); ctx.stroke();
    }
  } else if (type === "marble") {
    ctx.fillStyle = `rgb(${Math.round(R)},${Math.round(G)},${Math.round(B)})`; ctx.fillRect(0,0,sz,sz);
    // Subtle base cloudiness
    for (let y = 0; y < sz; y += 2) {
      for (let x = 0; x < sz; x += 2) {
        const n = _fbm(x*0.012, y*0.012, 4);
        const v = (n - 0.5) * 20;
        ctx.fillStyle = `rgba(${v>0?255:220},${v>0?255:220},${v>0?255:220},${Math.abs(v)/300})`;
        ctx.fillRect(x, y, 2, 2);
      }
    }
    // Veins — multiple bezier curves with varying thickness
    for (let i = 0; i < 9; i++) {
      const alpha = 0.08 + Math.random() * 0.18;
      const lw    = 0.5 + Math.random() * 1.8;
      const gray  = Math.round(180 + Math.random() * 70);
      ctx.strokeStyle = `rgba(${gray},${gray},${gray},${alpha})`; ctx.lineWidth = lw;
      ctx.beginPath();
      const sx = Math.random()*sz, sy = Math.random()*sz * 0.2;
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(
        Math.random()*sz, sy + Math.random()*sz*0.35,
        Math.random()*sz, sy + Math.random()*sz*0.6,
        Math.random()*sz, sy + sz * (0.8 + Math.random()*0.2)
      );
      ctx.stroke();
      // Branch veins
      if (Math.random() > 0.5) {
        ctx.lineWidth = lw * 0.4;
        ctx.beginPath(); ctx.moveTo(sx + (Math.random()-0.5)*60, sy + sz*0.3);
        ctx.lineTo(sx + (Math.random()-0.5)*120, sy + sz*0.7); ctx.stroke();
      }
    }
    // Highlight shimmer
    for (let s = 0; s < 12; s++) {
      const sx2 = Math.random()*sz, sy2 = Math.random()*sz;
      const grd = ctx.createRadialGradient(sx2,sy2,0,sx2,sy2,30+Math.random()*50);
      grd.addColorStop(0, `rgba(255,255,255,${0.04+Math.random()*0.08})`);
      grd.addColorStop(1, `rgba(255,255,255,0)`);
      ctx.fillStyle = grd; ctx.fillRect(sx2-80,sy2-80,160,160);
    }
  } else if (type === "tile") {
    const ts = 52, gap2 = 3;
    ctx.fillStyle = `rgb(${Math.round(R*0.5)},${Math.round(G*0.5)},${Math.round(B*0.5)})`; ctx.fillRect(0,0,sz,sz);
    for (let ty = 0; ty * (ts + gap2) < sz + ts; ty++) {
      for (let tx = 0; tx * (ts + gap2) < sz + ts; tx++) {
        const ttx = tx*(ts+gap2), tty = ty*(ts+gap2);
        // Tile face with subtle gloss gradient
        const grd = ctx.createLinearGradient(ttx, tty, ttx+ts, tty+ts);
        const vr = (Math.random()-0.5)*12, vg = (Math.random()-0.5)*12, vb = (Math.random()-0.5)*12;
        grd.addColorStop(0, `rgb(${Math.round(Math.min(255,R+vr+15))},${Math.round(Math.min(255,G+vg+15))},${Math.round(Math.min(255,B+vb+15))})`);
        grd.addColorStop(1, `rgb(${Math.round(Math.max(0,R+vr-15))},${Math.round(Math.max(0,G+vg-15))},${Math.round(Math.max(0,B+vb-15))})`);
        ctx.fillStyle = grd; ctx.fillRect(ttx+gap2, tty+gap2, ts-gap2, ts-gap2);
        // Specular highlight dot
        ctx.fillStyle = `rgba(255,255,255,0.12)`; ctx.beginPath();
        ctx.arc(ttx + ts*0.3, tty + ts*0.28, ts*0.09, 0, Math.PI*2); ctx.fill();
      }
    }
  } else if (type === "plaster") {
    ctx.fillStyle = `rgb(${Math.round(R)},${Math.round(G)},${Math.round(B)})`; ctx.fillRect(0,0,sz,sz);
    // Fine stucco-like noise
    for (let y = 0; y < sz; y++) {
      for (let x = 0; x < sz; x++) {
        const n = _noise2d(x*0.3, y*0.3);
        const v = (n - 0.5) * 16;
        ctx.fillStyle = `rgba(${v>0?255:0},${v>0?255:0},${v>0?255:0},${Math.abs(v)/220})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  } else {
    ctx.fillStyle = `rgb(${Math.round(R)},${Math.round(G)},${Math.round(B)})`; ctx.fillRect(0,0,sz,sz);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(type === "tile" ? 2 : type === "brick" ? 2.5 : 3, type === "tile" ? 2 : type === "brick" ? 2.5 : 3);
  tex.anisotropy = 16;
  tex.generateMipmaps = true;
  return tex;
}

// Generate a canvas-baked normal map for a given texture type
function makeNormalMap(type: TexType): THREE.CanvasTexture | null {
  const sz = 256;
  let heightFn: ((x:number,y:number)=>number) | null = null;
  let strength = 6;

  if (type === "brick") {
    strength = 10;
    heightFn = (x, y) => {
      const bw = 56/sz, bh = 26/sz, gap = 4/sz;
      const row = Math.floor(y / (bh + gap));
      const off = (row % 2) * (bw * 0.5);
      const lx = ((x - off) % (bw + gap) + (bw + gap)) % (bw + gap);
      const ly = (y % (bh + gap));
      const inMortar = lx < gap || ly < gap;
      return inMortar ? 0.2 : 0.75 + _noise2d(x*30, y*30)*0.08;
    };
  } else if (type === "concrete") {
    strength = 5;
    heightFn = (x, y) => 0.5 + _fbm(x*8, y*8, 4)*0.28;
  } else if (type === "wood") {
    strength = 4;
    heightFn = (x, y) => {
      const g = Math.sin(x*sz*0.18 + Math.sin(y*sz*0.04)*8)*0.5+0.5;
      return 0.4 + g*0.35 + _noise2d(x*20,y*20)*0.08;
    };
  } else if (type === "marble") {
    strength = 3;
    heightFn = (x, y) => 0.5 + _fbm(x*4, y*4, 3)*0.15;
  } else if (type === "tile") {
    strength = 12;
    heightFn = (x, y) => {
      const ts = (52+3)/sz;
      const lx = (x % ts) / ts, ly = (y % ts) / ts;
      const gap2 = 3/(52+3);
      const inGap = lx < gap2 || ly < gap2;
      return inGap ? 0.0 : 0.6 + _fbm(x*40,y*40,2)*0.1;
    };
  } else if (type === "plaster") {
    strength = 3;
    heightFn = (x, y) => 0.5 + _fbm(x*12, y*12, 3)*0.18;
  }

  if (!heightFn) return null;
  const hf = _buildHeightfield(sz, heightFn);
  const nmap = _heightToNormal(hf, sz, strength);
  nmap.repeat.set(3, 3);
  nmap.wrapS = nmap.wrapT = THREE.RepeatWrapping;
  nmap.anisotropy = 8;
  return nmap;
}

// Roughness variation map — modulates surface micro-roughness procedurally
function makeRoughnessMap(type: TexType): THREE.CanvasTexture | null {
  const sz = 256;
  const cv = document.createElement("canvas"); cv.width = sz; cv.height = sz;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(sz, sz);

  if (type === "none") return null;

  for (let y = 0; y < sz; y++) {
    for (let x = 0; x < sz; x++) {
      let v = 0.5;
      if (type === "marble")  v = 0.1 + _fbm(x*0.03, y*0.03, 3)*0.15;
      if (type === "tile")    v = 0.15 + _noise2d(x*0.5, y*0.5)*0.12;
      if (type === "wood")    v = 0.55 + _fbm(x*0.08, y*0.08, 2)*0.2;
      if (type === "brick")   v = 0.7  + _fbm(x*0.12, y*0.12, 2)*0.15;
      if (type === "concrete")v = 0.75 + _fbm(x*0.15, y*0.15, 3)*0.18;
      if (type === "plaster") v = 0.65 + _noise2d(x*0.4, y*0.4)*0.2;
      const bv = Math.round(Math.min(1, Math.max(0, v)) * 255);
      const i = (y*sz+x)*4;
      img.data[i] = bv; img.data[i+1] = bv; img.data[i+2] = bv; img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3,3);
  return t;
}

function makeMat(color: string, tex?: TexType, roughness = 0.78) {
  if (!tex || tex === "none") return new THREE.MeshPhysicalMaterial({
    color, roughness, metalness: 0.04,
    clearcoat: 0.06, clearcoatRoughness: 0.45, reflectivity: 0.1,
  });

  const map      = makeTexture(tex, color);
  const normalMap  = makeNormalMap(tex);
  const roughnessMap = makeRoughnessMap(tex);

  // Per-material PBR parameter sets
  const params: Record<TexType, { r: number; metal: number; cc: number; ccR: number; refl: number; nScale: number }> = {
    brick:    { r:0.82, metal:0.00, cc:0.00, ccR:1.0, refl:0.06, nScale:0.8  },
    concrete: { r:0.88, metal:0.01, cc:0.00, ccR:1.0, refl:0.05, nScale:0.6  },
    wood:     { r:0.72, metal:0.00, cc:0.04, ccR:0.8, refl:0.08, nScale:0.5  },
    plaster:  { r:0.90, metal:0.00, cc:0.00, ccR:1.0, refl:0.04, nScale:0.35 },
    marble:   { r:0.12, metal:0.05, cc:0.55, ccR:0.1, refl:0.70, nScale:0.4  },
    tile:     { r:0.18, metal:0.02, cc:0.40, ccR:0.15,refl:0.55, nScale:0.9  },
    none:     { r:roughness, metal:0.04, cc:0.06, ccR:0.45, refl:0.1, nScale:0 },
  };
  const p = params[tex] ?? params.none;

  const mat = new THREE.MeshPhysicalMaterial({
    color, map,
    roughness: p.r, metalness: p.metal,
    clearcoat: p.cc, clearcoatRoughness: p.ccR,
    reflectivity: p.refl,
  });
  if (normalMap) { mat.normalMap = normalMap; mat.normalScale = new THREE.Vector2(p.nScale, p.nScale); }
  if (roughnessMap) mat.roughnessMap = roughnessMap;
  return mat;
}

// ─── Lighting ─────────────────────────────────────────────────────────────────
function sunAnglesToScenePosition(azimuthDeg: number, elevationDeg: number, radius: number): [number, number, number] {
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const elevationRad = (Math.max(-89, Math.min(89, elevationDeg)) * Math.PI) / 180;
  const horizontal = Math.cos(elevationRad) * radius;
  const x = Math.sin(azimuthRad) * horizontal;
  const z = -Math.cos(azimuthRad) * horizontal;
  const y = Math.sin(elevationRad) * radius;
  return [x, y, z];
}

function Lighting({
  sunAzimuthDeg,
  sunElevationDeg,
  sunOn,
  nightLightOn,
  nightMode,
  sunriseRaysIntensity,
}: {
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunOn: boolean;
  nightLightOn: boolean;
  nightMode: boolean;
  sunriseRaysIntensity: number;
}) {
  const pos = sunAnglesToScenePosition(sunAzimuthDeg, sunElevationDeg, 24);
  const studioMode = nightLightOn && !nightMode;
  const isSunAboveHorizon = sunElevationDeg > 0;
  const useNightLighting = nightMode && !studioMode;
  const horizonBoost = clamp01(1 - Math.abs(sunElevationDeg - 6) / 18);
  const sunsetWarmth = clamp01(1 - Math.abs(sunElevationDeg - 4) / 14);
  const raysBoost = 1 + horizonBoost * sunriseRaysIntensity * 0.95;
  const sunKeyColor = new THREE.Color("#fff2cf").lerp(new THREE.Color("#ffad69"), sunsetWarmth * 0.92).getStyle();
  const sunFillColor = new THREE.Color("#ffd4a0").lerp(new THREE.Color("#ff8f56"), sunsetWarmth * 0.75).getStyle();
  const ambientDay = new THREE.Color("#d8e8ff").lerp(new THREE.Color("#ffd8b6"), sunsetWarmth * 0.52).getStyle();
  const hemiSky = new THREE.Color("#bcdcff").lerp(new THREE.Color("#ffb57f"), sunsetWarmth * 0.55).getStyle();
  const hemiGround = new THREE.Color("#1a2424").lerp(new THREE.Color("#3a2620"), sunsetWarmth * 0.45).getStyle();
  return <>
    <ambientLight intensity={studioMode ? 0.7 : useNightLighting ? 0.12 : (sunOn ? 0.34 : 0.42)} color={studioMode ? "#fff9ef" : useNightLighting ? "#9db6d8" : ambientDay} />
    <hemisphereLight args={studioMode ? ["#fff6e8","#8d9b8a",0.45] : useNightLighting ? ["#506a8a", "#0f1620", 0.2] : [hemiSky, hemiGround, 0.38]} />
    {studioMode && <>
      <directionalLight position={[14, 20, 10]} intensity={1.15} color="#fff8ef" castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-camera-left={-32} shadow-camera-right={32} shadow-camera-top={32} shadow-camera-bottom={-32} shadow-camera-near={0.5} shadow-camera-far={100} />
      <directionalLight position={[-12, 15, -8]} intensity={0.55} color="#d8eeff" />
      <directionalLight position={[0, 10, -16]} intensity={0.35} color="#ffeedd" />
      <pointLight position={[0, 6, 0]} intensity={0.35} color="#ffe8cc" distance={40} decay={1.2} />
    </>}
    {!useNightLighting && sunOn && isSunAboveHorizon && <directionalLight position={pos} intensity={1.55 * raysBoost * (1 + sunsetWarmth * 0.18)} castShadow color={sunKeyColor} shadow-mapSize-width={2048} shadow-mapSize-height={2048} shadow-camera-near={0.5} shadow-camera-far={120} shadow-camera-left={-35} shadow-camera-right={35} shadow-camera-top={35} shadow-camera-bottom={-35} />}
    {!useNightLighting && sunOn && isSunAboveHorizon && <pointLight position={[pos[0] * 0.62, Math.max(1.6, pos[1] * 0.42), pos[2] * 0.62]} intensity={0.58 + sunriseRaysIntensity * 1.35 * horizonBoost} color={sunFillColor} distance={106} decay={1.28} />}
    {!useNightLighting && sunOn && isSunAboveHorizon && <pointLight position={[pos[0] * 0.28, 1.2, pos[2] * 0.28]} intensity={0.16 + sunsetWarmth * 0.24} color="#ff9a62" distance={52} decay={1.45} />}
    {!studioMode && !useNightLighting && !sunOn && <><pointLight position={[0, 14, 0]} intensity={0.55} color="#ffffff" /><pointLight position={[-10, 8, -10]} intensity={0.2} color="#c8d8ff" /><pointLight position={[10, 8, 10]} intensity={0.2} color="#ffd8c8" /></>}
    {useNightLighting && <>
      <directionalLight position={[-16, 20, -14]} intensity={0.38} color="#8ea8d8" castShadow shadow-mapSize-width={1024} shadow-mapSize-height={1024} shadow-camera-left={-30} shadow-camera-right={30} shadow-camera-top={30} shadow-camera-bottom={-30} />
      <pointLight position={[0, 8, 0]} intensity={0.18} color="#9fc2ff" distance={40} decay={1.35} />
    </>}
  </>;
}

// ─── Sun Sphere ───────────────────────────────────────────────────────────────
function SunSphere({ sunAzimuthDeg, sunElevationDeg, sunriseRaysIntensity }: { sunAzimuthDeg: number; sunElevationDeg: number; sunriseRaysIntensity: number }) {
  const sunRef = useRef<THREE.Group>(null);
  const belowHorizon = sunElevationDeg < -1.0;
  const horizonBoost = clamp01(1 - Math.abs(sunElevationDeg - 5) / 18);
  const glowBoost = 1 + sunriseRaysIntensity * horizonBoost * 0.55;

  const getSunPos = useCallback(
    (): [number, number, number] => sunAnglesToScenePosition(sunAzimuthDeg, sunElevationDeg, 20),
    [sunAzimuthDeg, sunElevationDeg]
  );

  const pos = getSunPos();

  useFrame((s) => {
    if (belowHorizon) return;
    if (sunRef.current) {
      const np = getSunPos();
      sunRef.current.position.lerp(new THREE.Vector3(...np), 0.002);
    }
  });

  if (belowHorizon) return null;

  return (
    <group ref={sunRef} position={pos}>
      <mesh>
        <sphereGeometry args={[0.62, 20, 20]} />
        <meshStandardMaterial color="#ffd27a" emissive="#ffb45f" emissiveIntensity={0.92 * glowBoost} />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.22, 20, 20]} />
        <meshBasicMaterial color="#ffd9a8" transparent opacity={0.1 + horizonBoost * 0.08} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight intensity={1.55 + sunriseRaysIntensity * 0.8} color="#ffd09a" distance={56} decay={1.7} />
    </group>
  );
}

function SunRayBeams({
  active,
  sunAzimuthDeg,
  sunElevationDeg,
  strength,
}: {
  active: boolean;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  strength: number;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const matsRef = useRef<Array<THREE.MeshBasicMaterial | null>>([]);

  const sunPos = useMemo(() => {
    const [x, y, z] = sunAnglesToScenePosition(sunAzimuthDeg, sunElevationDeg, 19);
    return new THREE.Vector3(x, y, z);
  }, [sunAzimuthDeg, sunElevationDeg]);

  useFrame(({ clock }) => {
    if (!active || !groupRef.current) return;
    groupRef.current.position.copy(sunPos.clone().multiplyScalar(0.84));
    groupRef.current.lookAt(0, 0.5, 0);
    const horizonFactor = clamp01(1 - Math.max(0, sunElevationDeg - 10) / 28);
    const pulse = 0.97 + Math.sin(clock.elapsedTime * 0.55) * 0.03;
    for (let i = 0; i < matsRef.current.length; i++) {
      const m = matsRef.current[i];
      if (!m) continue;
      m.opacity = (0.048 + i * 0.018) * clamp01(strength) * horizonFactor * pulse;
    }
  });

  if (!active || sunElevationDeg < 0 || sunElevationDeg > 40) return null;

  return (
    <group ref={groupRef} raycast={NOOP_RAYCAST}>
      {[0, 1, 2].map((i) => (
        <mesh key={`beam-${i}`} rotation={[Math.PI * 0.5, (i - 1) * 0.1, 0]}>
          <coneGeometry args={[0.44 + i * 0.2, 24 + i * 6, 20, 1, true]} />
          <meshBasicMaterial
            ref={(node) => { matsRef.current[i] = node; }}
            color={i === 0 ? "#ffe9cb" : i === 1 ? "#ffdeb6" : "#ffd29f"}
            transparent
            opacity={0.06}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

function RealisticSky({
  nightMode,
  sunAzimuthDeg,
  sunElevationDeg,
  sunriseRaysIntensity,
  surroundingsBlend,
}: {
  nightMode: boolean;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunriseRaysIntensity: number;
  surroundingsBlend: number;
}) {
  const sunPosition = useMemo<[number, number, number]>(() => {
    const a = THREE.MathUtils.degToRad(sunAzimuthDeg);
    const e = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(sunElevationDeg, -2, 85));
    const r = 1200;
    return [Math.sin(a) * Math.cos(e) * r, Math.sin(e) * r, -Math.cos(a) * Math.cos(e) * r];
  }, [sunAzimuthDeg, sunElevationDeg]);

  if (nightMode) return null;

  const horizonWarmth = clamp01(1 - Math.abs(sunElevationDeg - 7) / 18);
  const realisticFactor = clamp01(surroundingsBlend);

  return (
    <Sky
      distance={450000}
      sunPosition={sunPosition}
      turbidity={THREE.MathUtils.lerp(5.2, 3.8, realisticFactor) + horizonWarmth * 0.42 + sunriseRaysIntensity * 0.08}
      rayleigh={THREE.MathUtils.lerp(4.6, 3.6, realisticFactor) + horizonWarmth * 0.35}
      mieCoefficient={THREE.MathUtils.lerp(0.0028, 0.0018, realisticFactor) + horizonWarmth * 0.00012}
      mieDirectionalG={THREE.MathUtils.lerp(0.62, 0.7, realisticFactor)}
    />
  );
}

const eveningSkyVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const eveningSkyFrag = /* glsl */ `
  varying vec3 vWorld;
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uSunGlow;
  uniform vec3 uSunDir;
  uniform float uIntensity;

  void main() {
    vec3 dir = normalize(vWorld);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

    vec3 base = mix(uHorizon, uMid, smoothstep(0.0, 0.55, h));
    base = mix(base, uTop, smoothstep(0.42, 1.0, h));

    float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
    float halo = pow(sunDot, 7.0) * 0.52 + pow(sunDot, 28.0) * 0.78;
    vec3 col = base + uSunGlow * halo;

    col *= uIntensity;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function EveningGradientSky({
  nightMode,
  sunAzimuthDeg,
  sunElevationDeg,
  graphicsStylePreset,
}: {
  nightMode: boolean;
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  graphicsStylePreset: GraphicsStylePreset;
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null!);

  const sunDir = useMemo(() => {
    const [x, y, z] = sunAnglesToScenePosition(sunAzimuthDeg, sunElevationDeg, 1.0);
    return new THREE.Vector3(x, y, z).normalize();
  }, [sunAzimuthDeg, sunElevationDeg]);

  useEffect(() => {
    if (!matRef.current) return;
    if (graphicsStylePreset === "sakura-blooms") {
      matRef.current.uniforms.uTop.value.set("#6a6bc6");
      matRef.current.uniforms.uMid.value.set("#c57fc6");
      matRef.current.uniforms.uHorizon.value.set("#ff9f6a");
      matRef.current.uniforms.uSunGlow.value.set("#ffd2a1");
      matRef.current.uniforms.uIntensity.value = 1.04;
    } else if (graphicsStylePreset === "minecraft") {
      matRef.current.uniforms.uTop.value.set("#5c72c5");
      matRef.current.uniforms.uMid.value.set("#8f70c8");
      matRef.current.uniforms.uHorizon.value.set("#ff9e5f");
      matRef.current.uniforms.uSunGlow.value.set("#ffd09a");
      matRef.current.uniforms.uIntensity.value = 1.0;
    } else {
      matRef.current.uniforms.uTop.value.set("#5971ba");
      matRef.current.uniforms.uMid.value.set("#8b75bf");
      matRef.current.uniforms.uHorizon.value.set("#ffa56e");
      matRef.current.uniforms.uSunGlow.value.set("#ffd8aa");
      matRef.current.uniforms.uIntensity.value = 0.98;
    }
  }, [graphicsStylePreset]);

  useFrame(() => {
    if (!matRef.current) return;
    matRef.current.uniforms.uSunDir.value.copy(sunDir);
  });

  if (nightMode) return null;

  return (
    <mesh scale={[360, 360, 360]} raycast={NOOP_RAYCAST}>
      <sphereGeometry args={[1, 56, 40]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={eveningSkyVert}
        fragmentShader={eveningSkyFrag}
        side={THREE.BackSide}
        depthWrite={false}
        uniforms={{
          uTop: { value: new THREE.Color("#5f72c0") },
          uMid: { value: new THREE.Color("#8b74bf") },
          uHorizon: { value: new THREE.Color("#ffab75") },
          uSunGlow: { value: new THREE.Color("#ffd8aa") },
          uSunDir: { value: sunDir.clone() },
          uIntensity: { value: 1.0 },
        }}
      />
    </mesh>
  );
}

function UniversalWaterBody({
  nightMode,
  style,
}: {
  nightMode: boolean;
  style: GraphicsStylePreset;
}) {
  const strips = useMemo(() => ([
    { pos: [0, -0.56, -64] as [number, number, number], rot: [-Math.PI / 2, 0, 0] as [number, number, number], size: [180, 26, 56, 14] as [number, number, number, number] },
    { pos: [0, -0.56, 64] as [number, number, number], rot: [-Math.PI / 2, 0, 0] as [number, number, number], size: [180, 26, 56, 14] as [number, number, number, number] },
    { pos: [-64, -0.56, 0] as [number, number, number], rot: [-Math.PI / 2, Math.PI / 2, 0] as [number, number, number], size: [180, 26, 56, 14] as [number, number, number, number] },
    { pos: [64, -0.56, 0] as [number, number, number], rot: [-Math.PI / 2, Math.PI / 2, 0] as [number, number, number], size: [180, 26, 56, 14] as [number, number, number, number] },
  ]), []);

  const refs = useRef<Array<THREE.Mesh | null>>([]);

  useFrame(({ clock }) => {
    const T = clock.elapsedTime;
    for (let i = 0; i < refs.current.length; i++) {
      const m = refs.current[i];
      if (!m) continue;
      const geo = m.geometry as THREE.PlaneGeometry;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const pa = pos.array as Float32Array;
      for (let v = 0; v < pa.length / 3; v++) {
        const x = pa[v * 3 + 0];
        const y = pa[v * 3 + 1];
        pa[v * 3 + 2] = Math.sin(x * 0.05 + T * 0.8) * 0.07 + Math.cos(y * 0.08 + T * 0.65) * 0.05;
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }
  });

  const waterColor = nightMode
    ? "#1a2e4a"
    : style === "sakura-blooms"
      ? "#8f79b8"
      : style === "minecraft"
        ? "#4f83c3"
        : style === "valorant"
          ? "#5f7488"
          : style === "wuthering-waves"
            ? "#4b6a89"
            : "#5d86be";

  return (
    <group>
      {strips.map((s, i) => (
        <mesh
          key={`uw-${i}`}
          ref={(node) => { refs.current[i] = node; }}
          position={s.pos}
          rotation={s.rot}
          raycast={NOOP_RAYCAST}
        >
          <planeGeometry args={s.size} />
          <meshPhysicalMaterial
            color={waterColor}
            roughness={nightMode ? 0.09 : 0.05}
            metalness={0.18}
            transmission={0.18}
            reflectivity={1.0}
            clearcoat={1.0}
            clearcoatRoughness={0.05}
            transparent
            opacity={0.92}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

function ArchitecturalNightFill({ nightMode, assistOn }: { nightMode: boolean; assistOn: boolean }) {
  const active = nightMode || assistOn;
  if (!active) return null;

  const assistBoost = assistOn ? 1.0 : 0.0;
  const nightBoost = nightMode ? 1.0 : 0.45;

  return (
    <group>
      {/* Localized fills keep the architecture readable while surroundings stay dark. */}
      <pointLight position={[0, 4.8, 0]} intensity={0.86 + nightBoost * 0.36 + assistBoost * 0.8} color={assistOn ? "#fff4d8" : "#b8cdf2"} distance={assistOn ? 28 : 20} decay={1.35} />
      <pointLight position={[7, 3.4, 6]} intensity={0.24 + nightBoost * 0.2 + assistBoost * 0.3} color={assistOn ? "#ffe7c2" : "#7fa6e6"} distance={assistOn ? 17 : 14} decay={1.5} />
      <pointLight position={[-7, 3.4, -6]} intensity={0.2 + nightBoost * 0.18 + assistBoost * 0.28} color={assistOn ? "#f4dcc1" : "#85b0f0"} distance={assistOn ? 17 : 14} decay={1.5} />
      <hemisphereLight args={[assistOn ? "#fff2df" : "#8ea8d2", "#111820", 0.2 + nightBoost * 0.08 + assistBoost * 0.15]} />
    </group>
  );
}

function StylePresetFill({ graphicsStylePreset, nightMode }: { graphicsStylePreset: GraphicsStylePreset; nightMode: boolean }) {
  if (nightMode) return null;
  if (graphicsStylePreset !== "valorant" && graphicsStylePreset !== "wuthering-waves" && graphicsStylePreset !== "sakura-blooms") return null;

  if (graphicsStylePreset === "valorant") {
    return (
      <group>
        {/* Daytime tactical fill to avoid black silhouette buildings. */}
        <hemisphereLight args={["#f4ddc0", "#8c7765", 0.34]} />
        <directionalLight position={[-10, 12, 9]} intensity={0.58} color="#f3d3ae" />
        <directionalLight position={[9, 10, -8]} intensity={0.42} color="#e3eef8" />
      </group>
    );
  }

  if (graphicsStylePreset === "sakura-blooms") {
    return (
      <group>
        <hemisphereLight args={["#ffe6f1", "#8e7688", 0.36]} />
        <directionalLight position={[-10, 12, 9]} intensity={0.52} color="#ffd1e3" />
        <directionalLight position={[9, 10, -8]} intensity={0.38} color="#f7f2ff" />
      </group>
    );
  }

  return (
    <group>
      {/* Cooler cinematic fill for wuthering profile readability. */}
      <hemisphereLight args={["#d9e9ff", "#4f657b", 0.32]} />
      <directionalLight position={[-11, 13, 10]} intensity={0.54} color="#c8deff" />
      <directionalLight position={[10, 11, -9]} intensity={0.38} color="#f1f6ff" />
    </group>
  );
}

function VoxelClouds({
  active,
  sunElevationDeg,
  cloudDensity,
  surroundingsBlend,
}: {
  active: boolean;
  sunElevationDeg: number;
  cloudDensity: number;
  surroundingsBlend: number;
}) {
  const cloudRefs = useRef<Array<THREE.Group | null>>([]);
  const cloudRuntime = useRef<Array<{ x: number; y: number; z: number; len: number; driftX: number; driftZ: number; speed: number; phase: number }>>([]);
  const density = clamp01(cloudDensity);
  const blend = clamp01(surroundingsBlend);
  const spanX = 230;
  const spanZ = 180;
  const cloudColor = useMemo(() => {
    const warm = Math.max(0, Math.min(1, 1 - Math.abs(sunElevationDeg - 10) / 30));
    const base = new THREE.Color("#eef3fb").lerp(new THREE.Color("#f6f7f9"), blend * 0.55);
    const dusk = new THREE.Color("#ffd9c2").lerp(new THREE.Color("#ffceb0"), blend * 0.35);
    return base.lerp(dusk, warm * 0.6).getStyle();
  }, [sunElevationDeg, blend]);
  const clusters = useMemo(() => {
    const count = Math.round(14 + density * 34);
    return Array.from({ length: count }, (_, i) => {
      const cols = Math.max(4, Math.ceil(Math.sqrt(count * 1.35)));
      const rows = Math.max(3, Math.ceil(count / cols));
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cellW = spanX / cols;
      const cellH = spanZ / rows;

      const x = ((col + 0.5) / cols - 0.5) * spanX + (Math.random() - 0.5) * cellW * 0.46;
      const z = ((row + 0.5) / rows - 0.5) * spanZ + (Math.random() - 0.5) * cellH * 0.52;
      const y = 16 + Math.random() * 12;
      const len = 4 + Math.floor(Math.random() * 5);
      return {
        x,
        y,
        z,
        len,
        driftX: 0.08 + Math.random() * 0.22,
        driftZ: (Math.random() - 0.5) * 0.11,
        speed: 0.7 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
      };
    });
  }, [density]);

  useEffect(() => {
    cloudRuntime.current = clusters.map(c => ({ ...c }));
    cloudRefs.current = new Array(clusters.length).fill(null);
  }, [clusters]);

  useFrame(({ clock }, delta) => {
    if (!active || !cloudRuntime.current.length) return;
    const time = clock.elapsedTime;
    const sx = spanX * 0.5;
    const sz = spanZ * 0.5;

    for (let i = 0; i < cloudRuntime.current.length; i++) {
      const c = cloudRuntime.current[i];
      const ref = cloudRefs.current[i];
      if (!c || !ref) continue;

      c.x += c.driftX * c.speed * delta * 8;
      c.z += c.driftZ * c.speed * delta * 8;

      if (c.x > sx) c.x = -sx;
      if (c.x < -sx) c.x = sx;
      if (c.z > sz) c.z = -sz;
      if (c.z < -sz) c.z = sz;

      ref.position.set(
        c.x,
        c.y + Math.sin(time * 0.22 + c.phase) * 0.24,
        c.z + Math.cos(time * 0.15 + c.phase) * 0.18
      );
    }
  });

  if (!active) return null;

  return (
    <group>
      {clusters.map((c, i) => (
        <group key={`cl-${i}`} ref={(node) => { cloudRefs.current[i] = node; }} position={[c.x, c.y, c.z]}>
          {Array.from({ length: c.len }, (_, k) => (
            <mesh key={k} position={[(k - (c.len - 1) * 0.5) * 2.55, Math.sin(k * 0.8 + c.phase) * 0.24, Math.cos(k * 0.65 + c.phase) * 1.1]} raycast={NOOP_RAYCAST}>
              <boxGeometry args={[2.35, 1.02, 1.45]} />
              <meshStandardMaterial color={cloudColor} roughness={THREE.MathUtils.lerp(0.95, 0.74, blend)} metalness={0.0} emissive={new THREE.Color("#ffd9c8").lerp(new THREE.Color("#ffffff"), blend * 0.7).getStyle()} emissiveIntensity={Math.max(0.02, (1 - blend) * 0.045)} transparent opacity={THREE.MathUtils.lerp(0.72, 0.94, density)} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function NightStarfield({ active }: { active: boolean }) {
  const ptsRef = useRef<THREE.Points>(null!);

  useEffect(() => {
    if (!ptsRef.current || !active) return;
    const geo = ptsRef.current.geometry;
    const COUNT = 900;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.9);
      const r = 140 + Math.random() * 40;
      pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi);
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const warm = Math.random();
      col[i * 3 + 0] = warm > 0.75 ? 1.0 : 0.86;
      col[i * 3 + 1] = warm > 0.75 ? 0.95 : 0.9;
      col[i * 3 + 2] = warm > 0.75 ? 0.8 : 1.0;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, COUNT);
  }, [active]);

  if (!active) return null;
  return (
    <points ref={ptsRef} raycast={NOOP_RAYCAST}>
      <bufferGeometry />
      <pointsMaterial size={0.34} vertexColors transparent opacity={0.9} depthWrite={false} sizeAttenuation />
    </points>
  );
}

// ─── Wind Swirl ───────────────────────────────────────────────────────────────
// Uses imperative buffer setup to avoid R3F bufferAttribute JSX artifact bug
function WindSwirl({ windDirectionDeg, modelW, modelD }: { windDirectionDeg: number; modelW: number; modelD: number }) {
  const v = useMemo(() => {
    const radians = (windDirectionDeg * Math.PI) / 180;
    const x = Math.sin(radians);
    const z = -Math.cos(radians);
    const l = Math.sqrt(x*x+z*z)||1;
    return { x:x/l, z:z/l };
  }, [windDirectionDeg]);
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

  // Set up geometry imperatively — pre-fill positions to avoid zero-vertex spike artifact
  useEffect(() => {
    if (!ptsRef.current) return;
    const geo = ptsRef.current.geometry;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    // Pre-scatter particles across a large volume so none start at origin (causes spike)
    for (let i = 0; i < COUNT; i++) {
      pos[i*3+0] = (Math.random()-0.5)*40;
      pos[i*3+1] = 1 + Math.random()*6;
      pos[i*3+2] = (Math.random()-0.5)*40;
      col[i*3+0] = 0.2; col[i*3+1] = 0.8; col[i*3+2] = 1.0;
    }
    const posAttr = new THREE.BufferAttribute(pos, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
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

// ─── Atmosphere Dust ─────────────────────────────────────────────────────────
// Very subtle floating particles that add depth cues in sunlit/interior scenes.
function AtmosphereDust({ active }: { active: boolean }) {
  const COUNT = 260;
  const ptsRef = useRef<THREE.Points>(null!);
  const stateRef = useRef<{ x: number; y: number; z: number; phase: number; speed: number }[]>([]);

  useEffect(() => {
    if (!ptsRef.current) return;
    const geo = ptsRef.current.geometry;
    const pos = new Float32Array(COUNT * 3);
    stateRef.current = Array.from({ length: COUNT }, (_, i) => {
      const x = (Math.random() - 0.5) * 30;
      const y = 0.7 + Math.random() * 9;
      const z = (Math.random() - 0.5) * 30;
      pos[i * 3 + 0] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      return {
        x,
        y,
        z,
        phase: Math.random() * Math.PI * 2,
        speed: 0.025 + Math.random() * 0.04,
      };
    });
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, COUNT);
  }, []);

  useFrame(({ clock }) => {
    if (!active || !ptsRef.current) return;
    const T = clock.elapsedTime;
    const pos = ptsRef.current.geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos || !stateRef.current.length) return;
    const pa = pos.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const s = stateRef.current[i];
      if (!s) continue;
      pa[i * 3 + 0] = s.x + Math.sin(T * s.speed + s.phase) * 0.22;
      pa[i * 3 + 1] = s.y + Math.cos(T * s.speed * 0.7 + s.phase) * 0.16;
      pa[i * 3 + 2] = s.z + Math.cos(T * s.speed + s.phase) * 0.2;
    }
    pos.needsUpdate = true;
  });

  if (!active) return null;

  return (
    <points ref={ptsRef} raycast={NOOP_RAYCAST}>
      <bufferGeometry />
      <pointsMaterial size={0.06} color="#fff5d8" transparent opacity={0.18} depthWrite={false} sizeAttenuation />
    </points>
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
function Flood({ waterStyle }: { waterStyle: number }) {
  const waterRef  = useRef<THREE.Mesh>(null!);
  const foamRef   = useRef<THREE.Points>(null!);
  const SEG = 40; // water plane subdivisions
  const style = clamp01(waterStyle);

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
        const waveAmp = 0.55 + style * 1.45;
        for (let i = 0; i < vCount; i++) {
          const ox = orig[i*3+0]; const oz = orig[i*3+1]; // plane is XZ in plane geometry before rotation
          // Multi-wave superposition for realism
          const w1 = Math.sin(ox*0.4 + T*1.2) * 0.09 * waveAmp;
          const w2 = Math.cos(oz*0.3 + T*0.9) * 0.07 * waveAmp;
          const w3 = Math.sin((ox+oz)*0.25 + T*1.5) * 0.05 * waveAmp;
          const w4 = Math.cos(ox*0.6 - oz*0.4 + T*0.7) * 0.03 * waveAmp;
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
          color={new THREE.Color("#2f6d95").lerp(new THREE.Color("#6aa2cf"), style * 0.32).getStyle()}
          transparent opacity={THREE.MathUtils.lerp(0.62, 0.84, style)}
          metalness={THREE.MathUtils.lerp(0.3, 0.7, style)} roughness={THREE.MathUtils.lerp(0.16, 0.02, style)}
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
  const Y_BASE = 52;

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
      <group position={[0, 52, 0]}>
        <mesh>
          <sphereGeometry args={[2.8, 32, 32]} />
          <meshStandardMaterial color="#fff0a0" emissive="#ff9000" emissiveIntensity={3.0} roughness={0.1} />
        </mesh>
        {/* Corona */}
        <mesh>
          <sphereGeometry args={[3.5, 16, 16]} />
          <meshStandardMaterial color="#ffcc00" transparent opacity={0.08} side={THREE.BackSide} depthWrite={false} />
        </mesh>
        <pointLight intensity={0.8} color="#ffe7b5" distance={36} decay={1.35} />
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

  // Gaussian weights for 13-tap separable bloom
  float gauss(float x, float s) { return exp(-x*x/(2.0*s*s)); }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec4 base = texture2D(tDiffuse, uv);

    // Large-radius gaussian blur on bright areas — 2 passes faked in 1 with 2D kernel
    vec3 glow = vec3(0.0);
    float wSum = 0.0;
    float blurR = 4.0 / min(uResolution.x, uResolution.y);
    for(int ix=-3; ix<=3; ix++) {
      for(int iy=-3; iy<=3; iy++) {
        vec2 off = uv + vec2(float(ix), float(iy)) * blurR;
        vec3 s = texture2D(tDiffuse, clamp(off,0.0,1.0)).rgb;
        float lum = dot(s, vec3(0.2126,0.7152,0.0722));
        float bright = max(0.0, lum - uThreshold);
        float w = gauss(float(ix),1.6) * gauss(float(iy),1.6);
        glow += s * bright * w;
        wSum += w;
      }
    }
    glow /= max(wSum, 0.001);

    // Additive glow with intensity, tinted slightly warm
    vec3 result = base.rgb + glow * uIntensity * vec3(1.05, 1.0, 0.95);
    gl_FragColor = vec4(result, base.a);
  }
`;

const compositeFrag = `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uVignette;
  uniform float uCA;
  uniform float uExposure;
  uniform float uNear;
  uniform float uFar;
  uniform float uFocus;
  uniform float uDOF;
  uniform float uAO;
  uniform float uSharpen;
  uniform float uGrain;
  uniform float uTime;
  uniform float uBloomMix;
  uniform float uSaturation;
  uniform float uContrast;
  uniform vec3 uGradeColor;
  uniform float uGradeStrength;

  // Precise ACES fitted curve (Stephen Hill fit)
  vec3 aces(vec3 x) {
    x = max(vec3(0.0), x);
    float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
  }

  float linearizeDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 dir = uv - 0.5;
    float dist = length(dir);

    vec3 sceneCol = texture2D(tScene, uv).rgb;
    vec3 bloomCol = texture2D(tBloom, uv).rgb;

    float depth = linearizeDepth(texture2D(tDepth, uv).r);
    float px = 1.0 / uResolution.x;
    float py = 1.0 / uResolution.y;

    // Screen-space AO approximation from depth neighborhood.
    float dL = linearizeDepth(texture2D(tDepth, uv + vec2(-px * 2.5, 0.0)).r);
    float dR = linearizeDepth(texture2D(tDepth, uv + vec2( px * 2.5, 0.0)).r);
    float dU = linearizeDepth(texture2D(tDepth, uv + vec2(0.0,  py * 2.5)).r);
    float dD = linearizeDepth(texture2D(tDepth, uv + vec2(0.0, -py * 2.5)).r);
    float ao = 1.0 - min(0.45, (abs(dL - depth) + abs(dR - depth) + abs(dU - depth) + abs(dD - depth)) * uAO * 0.02);

    // Depth-of-field approximation with a tiny 8-tap bokeh blur.
    float coc = clamp(abs(depth - uFocus) / max(uDOF, 0.001), 0.0, 1.0);
    float radius = coc * 1.2;
    vec2 blurX = vec2(px * radius, 0.0);
    vec2 blurY = vec2(0.0, py * radius);
    vec3 blurCol = vec3(0.0);
    blurCol += texture2D(tScene, uv + blurX).rgb;
    blurCol += texture2D(tScene, uv - blurX).rgb;
    blurCol += texture2D(tScene, uv + blurY).rgb;
    blurCol += texture2D(tScene, uv - blurY).rgb;
    blurCol += texture2D(tScene, uv + blurX + blurY).rgb;
    blurCol += texture2D(tScene, uv + blurX - blurY).rgb;
    blurCol += texture2D(tScene, uv - blurX + blurY).rgb;
    blurCol += texture2D(tScene, uv - blurX - blurY).rgb;
    blurCol *= 0.125;

    vec3 col = mix(sceneCol, blurCol, coc * 0.35);
    col *= ao;
    col += bloomCol * uBloomMix;

    // Subtle unsharp mask for crisp edges in high/ultra modes.
    vec3 neigh = (
      texture2D(tScene, uv + vec2(px, 0.0)).rgb +
      texture2D(tScene, uv - vec2(px, 0.0)).rgb +
      texture2D(tScene, uv + vec2(0.0, py)).rgb +
      texture2D(tScene, uv - vec2(0.0, py)).rgb
    ) * 0.25;
    col = mix(col, col + (col - neigh) * 1.2, uSharpen);

    // Radial chromatic aberration (stronger toward edges, zero at center)
    float caStr = uCA * dist * dist * 2.5;
    vec2 caOff = normalize(dir + vec2(0.001)) * caStr;
    float r = texture2D(tScene, clamp(uv + caOff,      0.0, 1.0)).r;
    float g = texture2D(tScene, uv).g;
    float b = texture2D(tScene, clamp(uv - caOff*0.7,  0.0, 1.0)).b;
    vec3 caCol = vec3(r, g, b);
    col = mix(col, caCol, 0.25);

    // Film grain for micro-detail; scales down in lower quality.
    float grain = (hash12(uv * uResolution + uTime * 21.7) - 0.5) * uGrain;
    col += grain;

    // Exposure
    col *= uExposure;

    // Style tint before tone mapping.
    col = mix(col, col * uGradeColor, uGradeStrength);

    // ACES filmic tonemapping
    col = aces(col);

    // Style-driven contrast and saturation.
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(luma), col, uSaturation);
    col = (col - 0.5) * uContrast + 0.5;
    col = clamp(col, 0.0, 1.0);

    // Smooth vignette (cosine falloff)
    float vig = 1.0 - smoothstep(0.45, 1.05, dist) * uVignette;
    col *= vig;

    // Gamma 2.2 encode
    col = pow(max(col, vec3(0.0)), vec3(1.0/2.2));

    gl_FragColor = vec4(col, 1.0);
  }
`;

function RenderPipeline({
  quality,
  cinematicBoost,
  sunElevationDeg,
  nightMode,
  graphicsStylePreset,
}: {
  quality: RenderQuality;
  cinematicBoost: number;
  sunElevationDeg: number;
  nightMode: boolean;
  graphicsStylePreset: GraphicsStylePreset;
}) {
  const { gl, scene, camera, size } = useThree();

  const depthTexture = useMemo(() => {
    const depth = new THREE.DepthTexture(size.width, size.height);
    depth.type = THREE.UnsignedShortType;
    return depth;
  }, [size.width, size.height]);

  // Two render targets: scene render + bloom pass
  const sceneRT  = useMemo(() => new THREE.WebGLRenderTarget(size.width, size.height, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.HalfFloatType,
    depthBuffer: true,
    depthTexture,
    samples: quality === "ultra" ? 8 : quality === "high" ? 6 : quality === "med" ? 3 : 0,
  }), [size.width, size.height, quality, depthTexture]);

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
      uIntensity:   { value: quality === "ultra" ? 0.72 : quality === "high" ? 0.58 : quality === "med" ? 0.45 : 0.32 },
      uThreshold:   { value: quality === "ultra" ? 0.72 : quality === "high" ? 0.76 : quality === "med" ? 0.8 : 0.85 },
    },
    vertexShader: postVert, fragmentShader: bloomFrag,
    depthTest: false, depthWrite: false,
  }), [quality, size.width, size.height]);

  const compositeMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      tScene:      { value: null },
      tBloom:      { value: null },
      tDepth:      { value: depthTexture },
      uResolution: { value: new THREE.Vector2(size.width, size.height) },
      uVignette:   { value: quality === "ultra" ? 0.66 : quality === "high" ? 0.62 : 0.58 },
      uCA:         { value: quality === "ultra" ? 0.0022 : quality === "high" ? 0.0018 : 0.0012 },
      uExposure:   { value: quality === "ultra" ? 0.98 : quality === "high" ? 0.96 : quality === "med" ? 0.94 : 0.92 },
      uNear:       { value: camera.near },
      uFar:        { value: camera.far },
      uFocus:      { value: quality === "low" ? 30 : quality === "med" ? 28 : quality === "high" ? 26 : 24 },
      uDOF:        { value: quality === "ultra" ? 42 : quality === "high" ? 46 : quality === "med" ? 50 : 58 },
      uAO:         { value: quality === "ultra" ? 0.65 : quality === "high" ? 0.55 : quality === "med" ? 0.45 : 0.35 },
      uSharpen:    { value: quality === "ultra" ? 0.38 : quality === "high" ? 0.28 : quality === "med" ? 0.18 : 0.08 },
      uGrain:      { value: quality === "ultra" ? 0.01 : quality === "high" ? 0.008 : quality === "med" ? 0.006 : 0.003 },
      uTime:       { value: 0 },
      uBloomMix:   { value: quality === "ultra" ? 0.42 : quality === "high" ? 0.34 : quality === "med" ? 0.24 : 0.16 },
      uSaturation: { value: 1.1 },
      uContrast:   { value: 1.05 },
      uGradeColor: { value: new THREE.Color("#ffffff") },
      uGradeStrength: { value: 0.0 },
    },
    vertexShader: postVert, fragmentShader: compositeFrag,
    depthTest: false, depthWrite: false,
  }), [quality, size.width, size.height, depthTexture, camera.near, camera.far]);

  // Ortho camera for full-screen passes
  const orthoCam = useMemo(() => new THREE.OrthographicCamera(-1,1,1,-1,0,1), []);

  useEffect(() => {
    // Update resolution when size changes
    bloomMat.uniforms.uResolution.value.set(size.width, size.height);
    compositeMat.uniforms.uResolution.value.set(size.width, size.height);
    compositeMat.uniforms.uNear.value = camera.near;
    compositeMat.uniforms.uFar.value = camera.far;
    sceneRT.setSize(size.width, size.height);
    bloomRT.setSize(size.width, size.height);
  }, [size.width, size.height, bloomMat, compositeMat, sceneRT, bloomRT, camera.near, camera.far]);

  useFrame(({ clock }) => {
    const cb = clamp01(cinematicBoost);
    const horizonBoost = clamp01(1 - Math.abs(sunElevationDeg - 7) / 19);

    const baseBloomIntensity = quality === "ultra" ? 0.44 : quality === "high" ? 0.36 : quality === "med" ? 0.28 : 0.2;
    const baseBloomThreshold = quality === "ultra" ? 0.88 : quality === "high" ? 0.9 : quality === "med" ? 0.92 : 0.94;
    const baseExposure = quality === "ultra" ? 0.84 : quality === "high" ? 0.82 : quality === "med" ? 0.8 : 0.78;
    const baseBloomMix = quality === "ultra" ? 0.2 : quality === "high" ? 0.16 : quality === "med" ? 0.12 : 0.08;
    const baseVignette = quality === "ultra" ? 0.66 : quality === "high" ? 0.62 : 0.58;

    const style = (() => {
      if (graphicsStylePreset === "valorant") {
        return {
          bloomMul: 0.68,
          bloomMixAdd: -0.05,
          bloomThresholdAdd: 0.06,
          exposureAdd: 0.03,
          vignetteAdd: -0.05,
          caMul: 0.12,
          grainMul: 0.2,
          dofMul: 1.08,
          saturation: 1.01,
          contrast: 1.02,
          gradeColor: new THREE.Color("#f4eadf"),
          gradeStrength: 0.04,
        };
      }
      if (graphicsStylePreset === "wuthering-waves") {
        return {
          bloomMul: 0.74,
          bloomMixAdd: -0.04,
          bloomThresholdAdd: 0.05,
          exposureAdd: 0.02,
          vignetteAdd: -0.01,
          caMul: 0.14,
          grainMul: 0.22,
          dofMul: 1.15,
          saturation: 1.03,
          contrast: 1.03,
          gradeColor: new THREE.Color("#e4eef7"),
          gradeStrength: 0.05,
        };
      }
      if (graphicsStylePreset === "minecraft") {
        return {
          bloomMul: 0.9,
          bloomMixAdd: 0.01,
          bloomThresholdAdd: 0.06,
          exposureAdd: 0.08,
          vignetteAdd: 0.02,
          caMul: 0.08,
          grainMul: 0.12,
          dofMul: 0.94,
          saturation: 1.12,
          contrast: 1.09,
          gradeColor: new THREE.Color("#ffc58f"),
          gradeStrength: 0.12,
        };
      }
      if (graphicsStylePreset === "sakura-blooms") {
        return {
          bloomMul: 0.84,
          bloomMixAdd: -0.01,
          bloomThresholdAdd: 0.08,
          exposureAdd: 0.07,
          vignetteAdd: 0.0,
          caMul: 0.1,
          grainMul: 0.14,
          dofMul: 0.9,
          saturation: 1.08,
          contrast: 1.04,
          gradeColor: new THREE.Color("#ffd7e9"),
          gradeStrength: 0.1,
        };
      }
      if (graphicsStylePreset === "default") {
        return {
          bloomMul: 0.45,
          bloomMixAdd: -0.08,
          bloomThresholdAdd: 0.14,
          exposureAdd: -0.02,
          vignetteAdd: 0.0,
          caMul: 0.0,
          grainMul: 0.0,
          dofMul: 1.0,
          saturation: 1.0,
          contrast: 1.0,
          gradeColor: new THREE.Color("#ffffff"),
          gradeStrength: 0.0,
        };
      }
      return {
        bloomMul: 0.78,
        bloomMixAdd: -0.05,
        bloomThresholdAdd: 0.12,
        exposureAdd: 0.02,
        vignetteAdd: 0.02,
        caMul: 0.14,
        grainMul: 0.2,
        dofMul: 1.35,
        saturation: 1.04,
        contrast: 1.05,
        gradeColor: new THREE.Color("#ffcba0"),
        gradeStrength: 0.1,
      };
    })();

    bloomMat.uniforms.uIntensity.value = (baseBloomIntensity + cb * horizonBoost * 0.2 + (nightMode ? 0.02 : 0)) * style.bloomMul;
    bloomMat.uniforms.uThreshold.value = Math.max(0.58, baseBloomThreshold - cb * horizonBoost * 0.12 + style.bloomThresholdAdd);
    compositeMat.uniforms.uBloomMix.value = baseBloomMix + cb * horizonBoost * 0.1 + style.bloomMixAdd;
    compositeMat.uniforms.uExposure.value = (nightMode ? THREE.MathUtils.lerp(0.72, 0.82, cb) : baseExposure + cb * horizonBoost * 0.04) + style.exposureAdd;
    compositeMat.uniforms.uVignette.value = Math.max(0.35, baseVignette + cb * (nightMode ? 0.03 : 0.05) + style.vignetteAdd);
    compositeMat.uniforms.uCA.value = (quality === "ultra" ? 0.0022 : quality === "high" ? 0.0018 : 0.0012) * style.caMul;
    compositeMat.uniforms.uGrain.value = (quality === "ultra" ? 0.01 : quality === "high" ? 0.008 : quality === "med" ? 0.006 : 0.003) * style.grainMul;
    compositeMat.uniforms.uDOF.value = (quality === "ultra" ? 42 : quality === "high" ? 46 : quality === "med" ? 50 : 58) * style.dofMul;
    compositeMat.uniforms.uSaturation.value = style.saturation;
    compositeMat.uniforms.uContrast.value = style.contrast;
    compositeMat.uniforms.uGradeColor.value.copy(style.gradeColor);
    compositeMat.uniforms.uGradeStrength.value = style.gradeStrength;

    compositeMat.uniforms.uTime.value = clock.elapsedTime;

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
    compositeMat.uniforms.tScene.value = sceneRT.texture;
    compositeMat.uniforms.tBloom.value = bloomRT.texture;
    compositeMat.uniforms.tDepth.value = sceneRT.depthTexture;
    const compMesh = new THREE.Mesh(triGeo, compositeMat);
    const compScene = new THREE.Scene();
    compScene.add(compMesh);
    gl.setRenderTarget(null);
    gl.render(compScene, orthoCam);
    compScene.remove(compMesh);
  }, 1); // priority 1 = after main render

  useEffect(() => () => {
    sceneRT.dispose(); bloomRT.dispose();
    depthTexture.dispose();
    bloomMat.dispose(); compositeMat.dispose(); triGeo.dispose();
  }, [sceneRT, bloomRT, depthTexture, bloomMat, compositeMat, triGeo]);

  return null;
}

// ─── PBR Scene Environment ─────────────────────────────────────────────────
// Sets up a high-quality IBL environment using Three's PMREMGenerator
// with a procedural gradient sky used as the scene environment map
function PBREnvironment({ sunOn, nightMode, graphicsStylePreset }: { sunOn: boolean; nightMode: boolean; graphicsStylePreset: GraphicsStylePreset }) {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    pmrem.compileEquirectangularShader();

    // Reflection environment only; visible sky is rendered separately.
    const size = 1024;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const t = y / size; // 0 = top, 1 = bottom
        const horizon = Math.exp(-Math.pow((t - 0.7) * 5.0, 2.0));

        let r: number, g: number, b: number;
        if (nightMode) {
          r = Math.round(6 + t * 12 + horizon * 4);
          g = Math.round(10 + t * 16 + horizon * 5);
          b = Math.round(24 + t * 22 + horizon * 6);
        } else if (graphicsStylePreset === "default") {
          r = 2;
          g = 3;
          b = 5;
        } else if (graphicsStylePreset === "valorant") {
          r = Math.round(96 + t * 78 + horizon * 22);
          g = Math.round(100 + t * 66 + horizon * 18);
          b = Math.round(108 + t * 54 + horizon * 8);
        } else if (graphicsStylePreset === "wuthering-waves") {
          r = Math.round(44 + t * 30 + horizon * 6);
          g = Math.round(62 + t * 38 + horizon * 8);
          b = Math.round(84 + t * 48 + horizon * 10);
        } else if (graphicsStylePreset === "sakura-blooms") {
          r = Math.round(146 + t * 66 + horizon * 20);
          g = Math.round(106 + t * 56 + horizon * 15);
          b = Math.round(134 + t * 62 + horizon * 18);
        } else if (sunOn) {
          r = Math.round(58 + t * 84 + horizon * 10);
          g = Math.round(118 + t * 78 + horizon * 8);
          b = Math.round(202 + t * 38 + horizon * 5);
        } else {
          r = Math.round(74 + t * 32 + horizon * 7);
          g = Math.round(86 + t * 34 + horizon * 6);
          b = Math.round(104 + t * 26 + horizon * 6);
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
    scene.background = new THREE.Color(
      nightMode
        ? "#01040d"
        : graphicsStylePreset === "default"
          ? "#000000"
          : graphicsStylePreset === "valorant"
          ? "#c8b9a4"
          : graphicsStylePreset === "wuthering-waves"
            ? "#8396a8"
            : graphicsStylePreset === "sakura-blooms"
              ? "#f1bfd3"
            : sunOn
              ? "#82b9ea"
              : "#7f96aa"
    );
    scene.fog = new THREE.FogExp2(
      nightMode
        ? "#070d1a"
        : graphicsStylePreset === "default"
          ? "#000000"
          : graphicsStylePreset === "valorant"
          ? "#9a8776"
          : graphicsStylePreset === "wuthering-waves"
            ? "#6e7f90"
            : graphicsStylePreset === "sakura-blooms"
              ? "#b68ea2"
            : sunOn
              ? "#6f9bc8"
              : "#60788c",
      nightMode ? 0.0016 : graphicsStylePreset === "default" ? 0.0 : graphicsStylePreset === "valorant" ? 0.00016 : graphicsStylePreset === "wuthering-waves" ? 0.00042 : graphicsStylePreset === "sakura-blooms" ? 0.00034 : sunOn ? 0.00032 : 0.00075
    );
    (scene as any).environmentIntensity = nightMode ? 0.2 : graphicsStylePreset === "default" ? 0.0 : graphicsStylePreset === "valorant" ? 0.5 : graphicsStylePreset === "wuthering-waves" ? 0.5 : graphicsStylePreset === "sakura-blooms" ? 0.62 : sunOn ? 0.58 : 0.34;

    return () => {
      scene.environment = null;
      scene.background = null;
      scene.fog = null;
      pmrem.dispose();
      tex.dispose();
      envMap.dispose();
    };
  }, [gl, scene, sunOn, nightMode, graphicsStylePreset]);

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
  uniform float uWet;
  uniform float uNight;
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vNormal;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1,311.7)); p += dot(p,p+45.32); return fract(p.x*p.y);
  }
  float noise(vec2 p) {
    vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
  }
  float fbm(vec2 p) {
    float v=0.0,a=0.5; for(int i=0;i<6;i++){v+=a*noise(p);p*=2.1;a*=0.48;} return v;
  }

  // Derived normal from heightfield gradient
  vec3 fbmNormal(vec2 p, float eps) {
    float h  = fbm(p);
    float hx = fbm(p + vec2(eps, 0.0));
    float hy = fbm(p + vec2(0.0, eps));
    return normalize(vec3(h-hx, eps*1.5, h-hy));
  }

  // Blinn-Phong diffuse+specular
  float blinnPhong(vec3 N, vec3 L, vec3 V, float roughness) {
    vec3 H = normalize(L + V);
    float diff = max(dot(N, L), 0.0);
    float shin = 2.0 / (roughness*roughness) - 2.0;
    float spec = pow(max(dot(N, H), 0.0), shin) * (1.0 - roughness);
    return diff * 0.85 + spec * 0.3;
  }

  void main() {
    vec2 uv  = vWorldPos.xz * 0.14;
    float n  = fbm(uv * 1.8);
    float n2 = fbm(uv * 5.5 + 3.7);
    float n3 = fbm(uv * 14.0 + 7.2); // micro detail

    // 3-tone base: shadow/mid/light spots
    vec3 col = mix(uColor * 0.7, uColor, n);
    col = mix(col, uColor2, n2 * 0.3);
    col += (n3 - 0.5) * 0.04; // micro variation

    // Derived surface normal for lighting
    vec3 N = fbmNormal(uv * 1.8, 0.005);

    // Key light + fill + ambient
    vec3 lightDir  = normalize(vec3(0.6, 1.0, 0.5));
    vec3 viewDir   = normalize(vec3(0.0, 1.0, 0.5));
    float lighting = blinnPhong(N, lightDir, viewDir, 0.88);
    float ambient  = 0.38;
    col *= (ambient + lighting * 0.62);

    // Ambient occlusion approximation from noise
    float ao = 0.78 + 0.22 * n;
    col *= ao;

    // Edge darkening around objects (proximity shadow approximation)
    float edgeAO = 1.0 - smoothstep(0.0, 2.0, abs(vWorldPos.x)) * 0.05;
    col *= edgeAO;

    // ── Wet ground / flood ──────────────────────────────────────────────────
    float puddleN = fbm(uv * 3.0 + 1.2);
    float puddleMask = smoothstep(0.42, 0.58, puddleN) * uWet;

    // Wet base darkening
    col = mix(col, col * 0.45, uWet * 0.5);

    // Water reflection (Fresnel-like specular off puddles)
    vec3 reflDir = reflect(-lightDir, vec3(0,1,0));
    float refl   = pow(max(dot(viewDir, reflDir), 0.0), 32.0);
    vec3 wetSpec = vec3(0.15, 0.22, 0.32) + refl * 0.5;
    col = mix(col, wetSpec, puddleMask * 0.75);

    // Ripple normal on wet parts (time-animated)
    float ripple = sin(vWorldPos.x*2.5 + uTime*1.2)*sin(vWorldPos.z*2.8 + uTime*0.9)*0.5+0.5;
    col += ripple * puddleMask * 0.04;

    // Minecraft-shader-style moving cloud shadows and day/night tint.
    float cloud = fbm(uv * 0.36 + vec2(uTime * 0.013, uTime * 0.004));
    float shadow = mix(0.86, 1.08, cloud);
    col *= mix(shadow, 0.94 + cloud * 0.08, uNight);
    col = mix(col, col * vec3(0.82, 0.9, 1.12), uNight * 0.5);
    col += vec3(0.05, 0.07, 0.12) * uNight;

    gl_FragColor = vec4(col, 1.0);
  }
`;

function PBRGround({ showGrid, wet, nightMode, graphicsStylePreset }: { showGrid: boolean; wet: boolean; nightMode: boolean; graphicsStylePreset: GraphicsStylePreset }) {
  const matRef = useRef<THREE.ShaderMaterial>(null!);
  const styleGroundTex = useMemo(() => makeGroundProfileTexture(graphicsStylePreset), [graphicsStylePreset]);
  useFrame(({ clock }) => {
    if (matRef.current) matRef.current.uniforms.uTime.value = clock.elapsedTime;
  });
  const uniforms = useMemo(() => ({
    uColor:  { value: new THREE.Color("#141e14") },
    uColor2: { value: new THREE.Color("#0e1a10") },
    uTime:   { value: 0 },
    uWet:    { value: wet ? 1.0 : 0.0 },
    uNight:  { value: 0.0 },
  }), []);
  useEffect(() => {
    if (!matRef.current) return;
    matRef.current.uniforms.uWet.value = wet ? 1.0 : 0.0;
    matRef.current.uniforms.uNight.value = nightMode && graphicsStylePreset !== "default" ? 1.0 : 0.0;
    if (graphicsStylePreset === "valorant") {
      matRef.current.uniforms.uColor.value.set("#2d3138");
      matRef.current.uniforms.uColor2.value.set("#3a4048");
    } else if (graphicsStylePreset === "wuthering-waves") {
      matRef.current.uniforms.uColor.value.set("#2b333c");
      matRef.current.uniforms.uColor2.value.set("#394754");
    } else if (graphicsStylePreset === "sakura-blooms") {
      matRef.current.uniforms.uColor.value.set("#b7808f");
      matRef.current.uniforms.uColor2.value.set("#d7a3b4");
    } else if (graphicsStylePreset === "minecraft") {
      matRef.current.uniforms.uColor.value.set("#8f6436");
      matRef.current.uniforms.uColor2.value.set("#b8844f");
    } else if (graphicsStylePreset === "default") {
      matRef.current.uniforms.uColor.value.set("#030507");
      matRef.current.uniforms.uColor2.value.set("#05080b");
    } else {
      matRef.current.uniforms.uColor.value.set("#101515");
      matRef.current.uniforms.uColor2.value.set("#111a1e");
    }
  }, [wet, nightMode, graphicsStylePreset]);

  useEffect(() => () => {
    styleGroundTex.dispose();
  }, [styleGroundTex]);

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
    {graphicsStylePreset !== "default" && (
      <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, -0.224, 0]} receiveShadow raycast={NOOP_RAYCAST}>
        <planeGeometry args={[120, 120, 1, 1]} />
        <meshStandardMaterial
          map={styleGroundTex}
          roughness={graphicsStylePreset === "valorant" ? 0.84 : graphicsStylePreset === "wuthering-waves" ? 0.73 : graphicsStylePreset === "sakura-blooms" ? 0.8 : 0.88}
          metalness={graphicsStylePreset === "valorant" ? 0.08 : graphicsStylePreset === "wuthering-waves" ? 0.1 : graphicsStylePreset === "sakura-blooms" ? 0.03 : 0.02}
          transparent
          opacity={graphicsStylePreset === "minecraft" ? 0.96 : graphicsStylePreset === "sakura-blooms" ? 0.94 : 0.92}
        />
      </mesh>
    )}
    {showGrid && <gridHelper args={[100, 100, "#0a2020", "#091a19"]} position={[0, -0.22, 0]} raycast={NOOP_RAYCAST} />}
  </>;
}

function makePixelTexture(base: string, variation: number, gridSize: number, repeat: number, sharp = true) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const baseColor = new THREE.Color(base);
  const cells = Math.floor(size / gridSize);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const n = (Math.sin((x + 13.1) * 12.9898 + (y + 47.7) * 78.233) * 43758.5453) % 1;
      const mix = Math.abs(n) * variation - variation * 0.5;
      const c = baseColor.clone().offsetHSL(0, mix * 0.03, mix * 0.18);
      ctx.fillStyle = c.getStyle();
      ctx.fillRect(x * gridSize, y * gridSize, gridSize, gridSize);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.minFilter = sharp ? THREE.NearestMipmapLinearFilter : THREE.LinearMipmapLinearFilter;
  tex.magFilter = sharp ? THREE.NearestFilter : THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  return tex;
}

function makeGroundProfileTexture(style: GraphicsStylePreset): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d")!;

  if (style === "minecraft") {
    // Minecraft-inspired dirt + grass top fringe, biased to light-brown base.
    const tile = 16;
    for (let y = 0; y < size; y += tile) {
      for (let x = 0; x < size; x += tile) {
        const r = Math.random();
        let base = "#9a6b3d";
        if (r > 0.84) base = "#b27c46";
        else if (r > 0.68) base = "#865a32";
        else if (r > 0.5) base = "#a97441";
        ctx.fillStyle = base;
        ctx.fillRect(x, y, tile, tile);

        // Pixel noise and tiny pebbles.
        for (let i = 0; i < 20; i++) {
          const px = x + ((Math.random() * tile) | 0);
          const py = y + ((Math.random() * tile) | 0);
          ctx.fillStyle = Math.random() > 0.5 ? "#774d2b" : "#bf8650";
          ctx.fillRect(px, py, 1, 1);
        }

        // Grass fringe near top like classic block top transition.
        for (let gy = 0; gy < 4; gy++) {
          for (let gx = 0; gx < tile; gx++) {
            if (Math.random() > 0.28) {
              ctx.fillStyle = gy < 2 ? "#6fa945" : "#5f933e";
              ctx.fillRect(x + gx, y + gy, 1, 1);
            }
          }
        }

        // Keep block seams brown, not near-black.
        ctx.fillStyle = "rgba(94,58,30,0.42)";
        ctx.fillRect(x, y + tile - 1, tile, 1);
        ctx.fillRect(x + tile - 1, y, 1, tile);
      }
    }
  } else if (style === "valorant") {
    // Tactical sand-concrete look with painted lane guides.
    ctx.fillStyle = "#8f7d6f";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 3200; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const v = 95 + Math.random() * 85;
      ctx.fillStyle = `rgba(${v},${v - 10},${v - 18},0.09)`;
      ctx.fillRect(x, y, 2 + Math.random() * 1.4, 2 + Math.random() * 1.2);
    }
    ctx.strokeStyle = "rgba(245,223,186,0.36)";
    ctx.lineWidth = 4;
    ctx.strokeRect(24, 24, size - 48, size - 48);
    ctx.lineWidth = 2;
    for (let i = 64; i < size; i += 96) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(72,68,62,0.28)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
      const sy = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.bezierCurveTo(size * 0.3, sy + Math.random() * 14, size * 0.6, sy - Math.random() * 18, size, sy + Math.random() * 8);
      ctx.stroke();
    }
  } else if (style === "wuthering-waves") {
    // Cooler rock mix with atmospheric streaks.
    ctx.fillStyle = "#53606d";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 4200; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const w = 1 + Math.random() * 4;
      const h = 1 + Math.random() * 4;
      const c = 92 + Math.random() * 82;
      ctx.fillStyle = `rgba(${c - 24},${c - 8},${c + 10},0.1)`;
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeStyle = "rgba(185,220,255,0.14)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 22; i++) {
      ctx.beginPath();
      const sx = Math.random() * size;
      const sy = Math.random() * size;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (Math.random() - 0.5) * 200, sy + (Math.random() - 0.5) * 200);
      ctx.stroke();
    }
    for (let i = 0; i < 14; i++) {
      const gx = Math.random() * size;
      const gy = Math.random() * size;
      const rg = ctx.createRadialGradient(gx, gy, 0, gx, gy, 28 + Math.random() * 36);
      rg.addColorStop(0, "rgba(210,235,255,0.08)");
      rg.addColorStop(1, "rgba(210,235,255,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(gx - 72, gy - 72, 144, 144);
    }
  } else if (style === "sakura-blooms") {
    // Soft spring meadow with pink petals and blossom highlights.
    ctx.fillStyle = "#c892a7";
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 16) {
      for (let x = 0; x < size; x += 16) {
        const roll = Math.random();
        let base = "#be879f";
        if (roll > 0.8) base = "#d8a8bb";
        else if (roll > 0.58) base = "#ad748e";
        ctx.fillStyle = base;
        ctx.fillRect(x, y, 16, 16);
        for (let i = 0; i < 22; i++) {
          const px = x + ((Math.random() * 16) | 0);
          const py = y + ((Math.random() * 16) | 0);
          ctx.fillStyle = Math.random() > 0.52 ? "#ffd9eb" : "#f2bdd6";
          ctx.fillRect(px, py, 1, 1);
        }
      }
    }
    for (let i = 0; i < 28; i++) {
      const cx = Math.random() * size;
      const cy = Math.random() * size;
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18 + Math.random() * 28);
      rg.addColorStop(0, "rgba(255,225,240,0.22)");
      rg.addColorStop(1, "rgba(255,225,240,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(cx - 52, cy - 52, 104, 104);
    }
  } else {
    ctx.fillStyle = "#06080b";
    ctx.fillRect(0, 0, size, size);
  }

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(
    style === "minecraft" ? 22 : style === "valorant" ? 9 : style === "wuthering-waves" ? 10 : style === "sakura-blooms" ? 14 : 8,
    style === "minecraft" ? 22 : style === "valorant" ? 9 : style === "wuthering-waves" ? 10 : style === "sakura-blooms" ? 14 : 8
  );
  t.generateMipmaps = true;
  t.minFilter = (style === "minecraft" || style === "sakura-blooms") ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
  t.magFilter = (style === "minecraft" || style === "sakura-blooms") ? THREE.NearestFilter : THREE.LinearFilter;
  t.anisotropy = 8;
  return t;
}

function SakuraRainbow({ active }: { active: boolean }) {
  if (!active) return null;
  const arcs = [
    { c: "#ff5f7f", r: 62 },
    { c: "#ff9a5f", r: 60.8 },
    { c: "#ffd85f", r: 59.6 },
    { c: "#89d86f", r: 58.4 },
    { c: "#6fc9ff", r: 57.2 },
    { c: "#9d95ff", r: 56.0 },
    { c: "#db9cff", r: 54.8 },
  ];

  return (
    <group position={[0, 38, -115]} rotation={[0.32, 0, 0]} raycast={NOOP_RAYCAST}>
      {arcs.map((a, i) => (
        <mesh key={`rb-${i}`} rotation={[Math.PI * 0.5, 0, 0]}>
          <torusGeometry args={[a.r, 0.26, 6, 96, Math.PI]} />
          <meshBasicMaterial color={a.c} transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function SakuraPetals({ active }: { active: boolean }) {
  const COUNT = 380;
  const ptsRef = useRef<THREE.Points>(null!);
  const dataRef = useRef<Array<{ x: number; y: number; z: number; drift: number; speed: number; phase: number }>>([]);

  useEffect(() => {
    if (!ptsRef.current || !active) return;
    const geo = ptsRef.current.geometry;
    const pos = new Float32Array(COUNT * 3);
    dataRef.current = Array.from({ length: COUNT }, (_, i) => {
      const x = (Math.random() - 0.5) * 86;
      const y = 2 + Math.random() * 20;
      const z = (Math.random() - 0.5) * 86;
      pos[i * 3 + 0] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      return {
        x,
        y,
        z,
        drift: 0.18 + Math.random() * 0.5,
        speed: 0.06 + Math.random() * 0.12,
        phase: Math.random() * Math.PI * 2,
      };
    });
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, COUNT);
  }, [active]);

  useFrame(({ clock }) => {
    if (!active || !ptsRef.current || !dataRef.current.length) return;
    const T = clock.elapsedTime;
    const pos = ptsRef.current.geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const pa = pos.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const d = dataRef.current[i];
      pa[i * 3 + 0] = d.x + Math.sin(T * 0.55 + d.phase) * d.drift;
      pa[i * 3 + 1] -= d.speed;
      pa[i * 3 + 2] = d.z + Math.cos(T * 0.42 + d.phase) * (d.drift * 0.6);
      if (pa[i * 3 + 1] < -0.2) {
        d.x = (Math.random() - 0.5) * 86;
        d.z = (Math.random() - 0.5) * 86;
        pa[i * 3 + 0] = d.x;
        pa[i * 3 + 1] = 20 + Math.random() * 4;
        pa[i * 3 + 2] = d.z;
      }
    }
    pos.needsUpdate = true;
  });

  if (!active) return null;

  return (
    <points ref={ptsRef} raycast={NOOP_RAYCAST}>
      <bufferGeometry />
      <pointsMaterial size={0.12} color="#ffd9eb" transparent opacity={0.7} depthWrite={false} sizeAttenuation />
    </points>
  );
}

function DistantScenery({
  nightMode,
  sunElevationDeg,
  surroundingsBlend,
  waterStyle,
  graphicsStylePreset,
}: {
  nightMode: boolean;
  sunElevationDeg: number;
  surroundingsBlend: number;
  waterStyle: number;
  graphicsStylePreset: GraphicsStylePreset;
}) {
  const blend = clamp01(surroundingsBlend);
  const stylized = 1 - blend;
  const waterBlend = clamp01(waterStyle);
  const warm = Math.max(0, Math.min(1, 1 - Math.abs(sunElevationDeg - 8) / 24));
  const grassTint = useMemo(() => {
    if (graphicsStylePreset === "valorant") return new THREE.Color("#868574").lerp(new THREE.Color("#b79f84"), warm * 0.25).getStyle();
    if (graphicsStylePreset === "wuthering-waves") return new THREE.Color("#51645d").lerp(new THREE.Color("#748070"), warm * 0.3).getStyle();
    if (graphicsStylePreset === "sakura-blooms") return new THREE.Color("#cb90a9").lerp(new THREE.Color("#f0b5cc"), warm * 0.5 + blend * 0.24).getStyle();
    if (graphicsStylePreset === "minecraft") return new THREE.Color("#3f8a3f").lerp(new THREE.Color("#7dad5f"), warm * 0.5 + blend * 0.24).getStyle();
    return new THREE.Color("#4d9a45").lerp(new THREE.Color("#88b45b"), warm * 0.45 + blend * 0.2).getStyle();
  }, [warm, blend, graphicsStylePreset]);
  const darkGrassTint = useMemo(() => new THREE.Color(grassTint).multiplyScalar(nightMode ? 0.38 : 0.92 + blend * 0.1).getStyle(), [grassTint, nightMode, blend]);
  const dirtTint = useMemo(() => {
    if (graphicsStylePreset === "valorant") return new THREE.Color("#705f50").lerp(new THREE.Color("#9a8268"), blend * 0.25).multiplyScalar(nightMode ? 0.5 : 1).getStyle();
    if (graphicsStylePreset === "wuthering-waves") return new THREE.Color("#353b42").lerp(new THREE.Color("#56606a"), blend * 0.45).multiplyScalar(nightMode ? 0.52 : 0.92).getStyle();
    if (graphicsStylePreset === "sakura-blooms") return new THREE.Color("#8f6172").lerp(new THREE.Color("#ba8399"), blend * 0.4).multiplyScalar(nightMode ? 0.52 : 0.96).getStyle();
    if (graphicsStylePreset === "minecraft") return new THREE.Color("#8b5d34").lerp(new THREE.Color("#b47c44"), blend * 0.34).multiplyScalar(nightMode ? 0.62 : 1.05).getStyle();
    return new THREE.Color("#5c3f2d").lerp(new THREE.Color("#7a5840"), blend * 0.35).multiplyScalar(nightMode ? 0.5 : 1).getStyle();
  }, [nightMode, blend, graphicsStylePreset]);

  const smoothTex = graphicsStylePreset !== "minecraft" && graphicsStylePreset !== "sakura-blooms";
  const blockyTex = graphicsStylePreset === "minecraft" || graphicsStylePreset === "sakura-blooms";

  const grassTex = useMemo(() => makePixelTexture(
    graphicsStylePreset === "wuthering-waves" ? "#60766f" : graphicsStylePreset === "valorant" ? "#9f8a6f" : graphicsStylePreset === "sakura-blooms" ? "#d39cb8" : "#4d9a45",
    THREE.MathUtils.lerp(0.34, 0.16, blend),
    graphicsStylePreset === "minecraft" ? 5 : graphicsStylePreset === "valorant" ? 18 : graphicsStylePreset === "wuthering-waves" ? 20 : graphicsStylePreset === "sakura-blooms" ? 12 : THREE.MathUtils.lerp(16, 8, blend),
    graphicsStylePreset === "minecraft" ? 9 : graphicsStylePreset === "valorant" ? 5 : graphicsStylePreset === "wuthering-waves" ? 6 : graphicsStylePreset === "sakura-blooms" ? 8 : 7,
    blockyTex || !smoothTex
  ), [blend, graphicsStylePreset, smoothTex, blockyTex]);
  const dirtTex = useMemo(() => makePixelTexture(
    graphicsStylePreset === "wuthering-waves" ? "#434f5a" : graphicsStylePreset === "valorant" ? "#7c6a57" : graphicsStylePreset === "minecraft" ? "#8f6036" : graphicsStylePreset === "sakura-blooms" ? "#9a6b7f" : "#5c3f2d",
    THREE.MathUtils.lerp(0.3, 0.14, blend),
    graphicsStylePreset === "minecraft" ? 5 : graphicsStylePreset === "valorant" ? 17 : graphicsStylePreset === "wuthering-waves" ? 18 : graphicsStylePreset === "sakura-blooms" ? 12 : THREE.MathUtils.lerp(14, 8, blend),
    graphicsStylePreset === "minecraft" ? 7 : graphicsStylePreset === "valorant" ? 5 : graphicsStylePreset === "wuthering-waves" ? 5 : graphicsStylePreset === "sakura-blooms" ? 7 : 5,
    blockyTex || !smoothTex
  ), [blend, graphicsStylePreset, smoothTex, blockyTex]);
  const barkTex = useMemo(() => makePixelTexture(graphicsStylePreset === "sakura-blooms" ? "#7f5966" : "#6f4a2a", THREE.MathUtils.lerp(0.4, 0.16, blend), graphicsStylePreset === "minecraft" ? 4 : THREE.MathUtils.lerp(14, 6, blend), 4, blockyTex || !smoothTex), [blend, graphicsStylePreset, smoothTex, blockyTex]);
  const leafTex = useMemo(() => makePixelTexture(graphicsStylePreset === "wuthering-waves" ? "#607468" : graphicsStylePreset === "sakura-blooms" ? "#f3bfd5" : "#3f9148", THREE.MathUtils.lerp(0.45, 0.2, blend), graphicsStylePreset === "minecraft" ? 4 : THREE.MathUtils.lerp(12, 6, blend), 5, blockyTex || !smoothTex), [blend, graphicsStylePreset, smoothTex, blockyTex]);

  // Dedicated texture packs per graphics profile for surrounding objects.
  const valorantWallTex = useMemo(() => {
    const t = makeTexture("concrete", "#9a846f");
    t.repeat.set(8, 8);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }, []);
  const valorantMetalTex = useMemo(() => {
    const t = makeTexture("tile", "#6a5f57");
    t.repeat.set(6, 6);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }, []);
  const wutheringRockTex = useMemo(() => {
    const t = makeTexture("marble", "#67788a");
    t.repeat.set(7, 7);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }, []);
  const wutheringRuinTex = useMemo(() => {
    const t = makeTexture("concrete", "#5a6673");
    t.repeat.set(6, 6);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }, []);
  const farGroundTex = useMemo(() => {
    if (graphicsStylePreset === "minecraft") {
      return makePixelTexture("#6b8f52", 0.34, 6, 26, true);
    }
    const t = makeTexture(graphicsStylePreset === "valorant" ? "concrete" : graphicsStylePreset === "sakura-blooms" ? "plaster" : "marble", graphicsStylePreset === "valorant" ? "#a98f74" : graphicsStylePreset === "sakura-blooms" ? "#cf9eb4" : "#6d8296");
    t.repeat.set(graphicsStylePreset === "valorant" ? 9 : graphicsStylePreset === "sakura-blooms" ? 10 : 8, graphicsStylePreset === "valorant" ? 9 : graphicsStylePreset === "sakura-blooms" ? 10 : 8);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    return t;
  }, [graphicsStylePreset]);
  const mountainTex = useMemo(() => {
    const t = makeTexture(
      graphicsStylePreset === "minecraft" ? "brick" : graphicsStylePreset === "valorant" ? "concrete" : graphicsStylePreset === "sakura-blooms" ? "plaster" : "marble",
      graphicsStylePreset === "minecraft" ? "#5f704a" : graphicsStylePreset === "valorant" ? "#7e6c5e" : graphicsStylePreset === "sakura-blooms" ? "#b28aa0" : "#58697a"
    );
    t.repeat.set(graphicsStylePreset === "minecraft" ? 6 : graphicsStylePreset === "sakura-blooms" ? 7 : 5, graphicsStylePreset === "minecraft" ? 6 : graphicsStylePreset === "sakura-blooms" ? 7 : 5);
    t.anisotropy = 8;
    if (graphicsStylePreset !== "minecraft") {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
    }
    return t;
  }, [graphicsStylePreset]);

  useEffect(() => {
    // Keep nearest filtering for Minecraft, smooth filtering for realistic profiles.
    if (grassTex) {
      grassTex.minFilter = blockyTex ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
      grassTex.magFilter = blockyTex ? THREE.NearestFilter : THREE.LinearFilter;
      grassTex.needsUpdate = true;
    }
    if (dirtTex) {
      dirtTex.minFilter = blockyTex ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
      dirtTex.magFilter = blockyTex ? THREE.NearestFilter : THREE.LinearFilter;
      dirtTex.needsUpdate = true;
    }
    if (barkTex) {
      barkTex.minFilter = blockyTex ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
      barkTex.magFilter = blockyTex ? THREE.NearestFilter : THREE.LinearFilter;
      barkTex.needsUpdate = true;
    }
    if (leafTex) {
      leafTex.minFilter = blockyTex ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
      leafTex.magFilter = blockyTex ? THREE.NearestFilter : THREE.LinearFilter;
      leafTex.needsUpdate = true;
    }
  }, [grassTex, dirtTex, barkTex, leafTex, blockyTex]);

  useEffect(() => {
    return () => {
      grassTex?.dispose();
      dirtTex?.dispose();
      barkTex?.dispose();
      leafTex?.dispose();
      valorantWallTex.dispose();
      valorantMetalTex.dispose();
      wutheringRockTex.dispose();
      wutheringRuinTex.dispose();
      farGroundTex?.dispose();
      mountainTex.dispose();
    };
  }, [grassTex, dirtTex, barkTex, leafTex, valorantWallTex, valorantMetalTex, wutheringRockTex, wutheringRuinTex, farGroundTex, mountainTex]);

  const terrain = useMemo(() => {
    const out: { x: number; y: number; z: number; h: number }[] = [];
    const step = graphicsStylePreset === "valorant" ? 8 : graphicsStylePreset === "sakura-blooms" ? 5 : 6;
    for (let x = -78; x <= 78; x += step) {
      for (let z = -78; z <= 78; z += step) {
        if (Math.abs(x) < 20 && Math.abs(z) < 20) continue;
        const n = graphicsStylePreset === "valorant"
          ? Math.sin(x * 0.05) * 0.4 + Math.cos(z * 0.04) * 0.35
          : graphicsStylePreset === "sakura-blooms"
            ? Math.sin(x * 0.06) * 0.95 + Math.cos(z * 0.065) * 1.05 + Math.sin((x + z) * 0.032) * 1.28
            : Math.sin(x * 0.08) * 0.8 + Math.cos(z * 0.06) * 0.9 + Math.sin((x + z) * 0.035) * 1.2;
        const h = graphicsStylePreset === "valorant"
          ? Math.max(1, Math.round(1.2 + n))
          : graphicsStylePreset === "sakura-blooms"
            ? Math.max(1, Math.round(2.2 + n))
            : Math.max(1, Math.round(2 + n));
        out.push({ x, z, h, y: -0.3 + h * 0.7 });
      }
    }
    return out;
  }, [graphicsStylePreset]);

  const trees = useMemo(() => (
    Array.from({ length: graphicsStylePreset === "valorant" ? 34 : graphicsStylePreset === "wuthering-waves" ? 96 : graphicsStylePreset === "sakura-blooms" ? 116 : 72 }, (_, i) => {
      const count = graphicsStylePreset === "valorant" ? 34 : graphicsStylePreset === "wuthering-waves" ? 96 : graphicsStylePreset === "sakura-blooms" ? 116 : 72;
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * (graphicsStylePreset === "valorant" ? 0.14 : 0.25);
      const r = 34 + Math.random() * 48;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < 20 && Math.abs(z) < 20) return null;
      const h = graphicsStylePreset === "wuthering-waves" ? 2.1 + Math.random() * 3.4 : graphicsStylePreset === "sakura-blooms" ? 2.2 + Math.random() * 2.4 : 2.5 + Math.random() * 2.8;
      const s = graphicsStylePreset === "valorant" ? 0.9 + Math.random() * 0.55 : graphicsStylePreset === "sakura-blooms" ? 1.55 + Math.random() * 1.2 : 1.1 + Math.random() * 0.9;
      return { x, z, h, s };
    }).filter(Boolean) as { x: number; z: number; h: number; s: number }[]
  ), [graphicsStylePreset]);

  const waterStrips = useMemo(() => ([
    { p: [0, -0.56, -64] as [number, number, number], s: [180, 1, 26] as [number, number, number] },
    { p: [0, -0.56, 64] as [number, number, number], s: [180, 1, 26] as [number, number, number] },
    { p: [-64, -0.56, 0] as [number, number, number], s: [26, 1, 180] as [number, number, number] },
    { p: [64, -0.56, 0] as [number, number, number], s: [26, 1, 180] as [number, number, number] },
  ]), []);

  const valorantStructures = useMemo(() => (
    Array.from({ length: 34 }, (_, i) => {
      const a = (i / 34) * Math.PI * 2;
      const r = 30 + (i % 5) * 7;
      const h = 6 + (i % 4) * 2.2;
      const w = 4.8 + (i % 3) * 1.1;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r, h, w };
    })
  ), []);

  const wutheringSpikes = useMemo(() => (
    Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const r = 36 + Math.random() * 50;
      return {
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        h: 8 + Math.random() * 18,
        s: 2.6 + Math.random() * 2.2,
      };
    })
  ), []);

  const valorantCrates = useMemo(() => (
    Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      const r = 24 + Math.random() * 28;
      return {
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        h: 1.8 + Math.random() * 1.8,
        w: 2.2 + Math.random() * 1.6,
      };
    })
  ), []);

  const wutheringRuins = useMemo(() => (
    Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
      const r = 28 + Math.random() * 34;
      return {
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        h: 6 + Math.random() * 8,
        w: 3.5 + Math.random() * 2.5,
      };
    })
  ), []);

  const farMountains = useMemo(() => (
    Array.from({ length: graphicsStylePreset === "minecraft" ? 28 : graphicsStylePreset === "sakura-blooms" ? 30 : 34 }, (_, i) => {
      const count = graphicsStylePreset === "minecraft" ? 28 : graphicsStylePreset === "sakura-blooms" ? 30 : 34;
      const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
      const r = 170 + Math.random() * 120;
      return {
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        h: graphicsStylePreset === "minecraft" ? 24 + Math.random() * 34 : graphicsStylePreset === "sakura-blooms" ? 26 + Math.random() * 22 : 20 + Math.random() * 28,
        s: graphicsStylePreset === "minecraft" ? 16 + Math.random() * 14 : graphicsStylePreset === "sakura-blooms" ? 15 + Math.random() * 11 : 18 + Math.random() * 18,
      };
    })
  ), [graphicsStylePreset]);

  const showBaseTerrain = graphicsStylePreset !== "default";

  return (
    <group>
      {showBaseTerrain && (
        <>
          {/* Far-distance land plane for game-like horizon continuity. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.34, 0]} raycast={NOOP_RAYCAST}>
            <planeGeometry args={[620, 620, 1, 1]} />
            <meshStandardMaterial
              color={graphicsStylePreset === "valorant" ? "#aa9077" : graphicsStylePreset === "wuthering-waves" ? "#72879b" : graphicsStylePreset === "sakura-blooms" ? "#cf9cb5" : "#6f9157"}
              map={farGroundTex ?? undefined}
              roughness={graphicsStylePreset === "minecraft" ? 0.94 : 0.88}
              metalness={graphicsStylePreset === "wuthering-waves" ? 0.08 : 0.03}
            />
          </mesh>

          <SakuraRainbow active={graphicsStylePreset === "sakura-blooms" && !nightMode} />

          {/* Mountain ring kept lightweight (no shadows/raycast) for FPS. */}
          {farMountains.map((m, i) => (
            <mesh key={`far-m-${i}`} position={[m.x, m.h * 0.5 - 0.34, m.z]} raycast={NOOP_RAYCAST}>
              <coneGeometry args={[m.s, m.h, graphicsStylePreset === "minecraft" ? 4 : 6]} />
              <meshStandardMaterial
                color={graphicsStylePreset === "valorant" ? "#7e6c5e" : graphicsStylePreset === "wuthering-waves" ? "#58697a" : graphicsStylePreset === "sakura-blooms" ? "#9f7a90" : "#567044"}
                map={mountainTex}
                roughness={graphicsStylePreset === "minecraft" ? 0.9 : 0.82}
                metalness={graphicsStylePreset === "wuthering-waves" ? 0.08 : 0.03}
              />
            </mesh>
          ))}
        </>
      )}

      {showBaseTerrain && terrain.map((b, i) => (
        <mesh key={`tb-${i}`} position={[b.x, b.y - b.h * 0.7, b.z]} castShadow receiveShadow raycast={NOOP_RAYCAST}>
          <boxGeometry args={[5.8, b.h * 1.4, 5.8]} />
          <meshStandardMaterial color={dirtTint} map={dirtTex ?? undefined} roughness={THREE.MathUtils.lerp(0.95, 0.78, blend)} metalness={0.0} />
        </mesh>
      ))}

      {showBaseTerrain && terrain.map((b, i) => (
        <mesh key={`tg-${i}`} position={[b.x, b.y + 0.04, b.z]} receiveShadow raycast={NOOP_RAYCAST}>
          <boxGeometry args={[5.7, 0.16, 5.7]} />
          <meshStandardMaterial color={darkGrassTint} map={grassTex ?? undefined} roughness={THREE.MathUtils.lerp(0.92, 0.7, blend)} metalness={0.0} />
        </mesh>
      ))}

      {false && waterStrips.map((w, i) => (
        <mesh key={`w-${i}`} position={w.p} scale={w.s} raycast={NOOP_RAYCAST}>
          <boxGeometry args={[1, 0.12, 1]} />
          <meshPhysicalMaterial color={nightMode ? "#1f3650" : graphicsStylePreset === "valorant" ? new THREE.Color("#6f7c86").lerp(new THREE.Color("#9eabb4"), waterBlend * 0.2).getStyle() : graphicsStylePreset === "wuthering-waves" ? new THREE.Color("#385163").lerp(new THREE.Color("#6b8196"), waterBlend * 0.42).getStyle() : graphicsStylePreset === "sakura-blooms" ? new THREE.Color("#7c8db8").lerp(new THREE.Color("#d3a0c6"), waterBlend * 0.55).getStyle() : new THREE.Color("#3d7eb5").lerp(new THREE.Color("#7db4de"), waterBlend * 0.35).getStyle()} roughness={nightMode ? THREE.MathUtils.lerp(0.2, 0.08, waterBlend) : graphicsStylePreset === "valorant" ? THREE.MathUtils.lerp(0.34, 0.2, waterBlend) : graphicsStylePreset === "sakura-blooms" ? THREE.MathUtils.lerp(0.2, 0.05, waterBlend) : THREE.MathUtils.lerp(0.18, 0.03, waterBlend)} metalness={THREE.MathUtils.lerp(0.04, graphicsStylePreset === "valorant" ? 0.11 : graphicsStylePreset === "sakura-blooms" ? 0.2 : 0.18, waterBlend)} transmission={THREE.MathUtils.lerp(0.02, graphicsStylePreset === "valorant" ? 0.06 : graphicsStylePreset === "sakura-blooms" ? 0.16 : 0.12, waterBlend)} reflectivity={THREE.MathUtils.lerp(0.74, graphicsStylePreset === "valorant" ? 0.86 : graphicsStylePreset === "sakura-blooms" ? 1.0 : 0.98, waterBlend)} clearcoat={THREE.MathUtils.lerp(0.65, 1.0, waterBlend)} clearcoatRoughness={THREE.MathUtils.lerp(0.22, graphicsStylePreset === "valorant" ? 0.14 : 0.06, waterBlend)} />
        </mesh>
      ))}

      {showBaseTerrain && trees.map((t, i) => (
        <group key={`tree-${i}`} position={[t.x, 0, t.z]} raycast={NOOP_RAYCAST}>
          <mesh position={[0, t.h * 0.28, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.72, t.h * 0.56, 0.72]} />
            <meshStandardMaterial color={nightMode ? "#3f2a1b" : graphicsStylePreset === "sakura-blooms" ? "#7a5564" : "#6f4a2a"} map={barkTex ?? undefined} roughness={THREE.MathUtils.lerp(0.9, 0.72, blend)} />
          </mesh>
          <mesh position={[0, t.h * 0.75, 0]} castShadow>
            <boxGeometry args={[t.s * 1.7, t.h * 0.34, t.s * 1.7]} />
            <meshStandardMaterial color={nightMode ? "#1f4f2f" : graphicsStylePreset === "sakura-blooms" ? "#f2b8d0" : "#2f7d3f"} map={leafTex ?? undefined} roughness={THREE.MathUtils.lerp(0.9, 0.72, blend)} />
          </mesh>
          <mesh position={[0, t.h * 1.03, 0]} castShadow>
            <boxGeometry args={[t.s * 1.25, t.h * 0.3, t.s * 1.25]} />
            <meshStandardMaterial color={nightMode ? "#225836" : graphicsStylePreset === "sakura-blooms" ? "#f6c9dc" : "#3b8f4d"} map={leafTex ?? undefined} roughness={THREE.MathUtils.lerp(0.88, 0.68, blend)} />
          </mesh>
          <mesh position={[0, t.h * 1.25, 0]} castShadow>
            <boxGeometry args={[t.s * 0.86, t.h * 0.24, t.s * 0.86]} />
            <meshStandardMaterial color={nightMode ? "#28643d" : graphicsStylePreset === "sakura-blooms" ? "#ffe0ef" : "#47a85a"} map={leafTex ?? undefined} roughness={THREE.MathUtils.lerp(0.88, 0.64, blend)} emissive={graphicsStylePreset === "sakura-blooms" ? new THREE.Color("#5f3145").lerp(new THREE.Color("#8f4e69"), stylized * 0.3).getStyle() : new THREE.Color("#0b1a0f").lerp(new THREE.Color("#143220"), stylized * 0.4).getStyle()} emissiveIntensity={nightMode ? 0.06 : graphicsStylePreset === "sakura-blooms" ? 0.03 : 0.0} />
          </mesh>
        </group>
      ))}

      {graphicsStylePreset === "valorant" && valorantStructures.map((s, i) => (
        <group key={`val-${i}`} position={[s.x, 0, s.z]} raycast={NOOP_RAYCAST}>
          <mesh position={[0, s.h * 0.5 - 0.3, 0]} castShadow receiveShadow>
            <boxGeometry args={[s.w, s.h, s.w * 0.85]} />
            <meshStandardMaterial color="#b49a83" map={valorantWallTex} roughness={0.8} metalness={0.04} />
          </mesh>
          <mesh position={[0, s.h + 0.2, 0]} castShadow>
            <boxGeometry args={[s.w * 0.9, 0.42, s.w * 0.76]} />
            <meshStandardMaterial color="#7d6e62" map={valorantMetalTex} roughness={0.66} metalness={0.1} />
          </mesh>
          <mesh position={[0, s.h * 0.5, s.w * 0.45]} castShadow>
            <boxGeometry args={[s.w * 0.7, s.h * 0.75, 0.12]} />
            <meshStandardMaterial color="#716358" map={valorantMetalTex} roughness={0.78} metalness={0.06} />
          </mesh>
        </group>
      ))}

      {graphicsStylePreset === "valorant" && valorantCrates.map((c, i) => (
        <group key={`vcrate-${i}`} position={[c.x, 0, c.z]} raycast={NOOP_RAYCAST}>
          <mesh position={[0, c.h * 0.5 - 0.25, 0]} castShadow receiveShadow>
            <boxGeometry args={[c.w, c.h, c.w]} />
            <meshStandardMaterial color="#c6a588" map={valorantWallTex} roughness={0.76} metalness={0.04} />
          </mesh>
          <mesh position={[0, c.h * 0.5 - 0.24, 0]} castShadow>
            <boxGeometry args={[c.w * 0.88, c.h * 0.84, c.w * 0.88]} />
            <meshStandardMaterial color="#6a5a50" map={valorantMetalTex} roughness={0.82} metalness={0.08} wireframe />
          </mesh>
        </group>
      ))}

      {graphicsStylePreset === "wuthering-waves" && wutheringSpikes.map((p, i) => (
        <group key={`wu-${i}`} position={[p.x, 0, p.z]} raycast={NOOP_RAYCAST}>
          <mesh position={[0, p.h * 0.48, 0]} castShadow receiveShadow>
            <coneGeometry args={[p.s, p.h, 5]} />
            <meshStandardMaterial color="#6f7f91" map={wutheringRockTex} roughness={0.68} metalness={0.12} />
          </mesh>
          <mesh position={[0, p.h * 0.08, 0]} castShadow>
            <boxGeometry args={[p.s * 1.25, p.h * 0.18, p.s * 1.25]} />
            <meshStandardMaterial color="#566577" map={wutheringRuinTex} roughness={0.76} metalness={0.08} />
          </mesh>
        </group>
      ))}

      {graphicsStylePreset === "wuthering-waves" && wutheringRuins.map((r, i) => (
        <group key={`wruin-${i}`} position={[r.x, 0, r.z]} raycast={NOOP_RAYCAST}>
          <mesh position={[0, r.h * 0.5 - 0.2, 0]} castShadow receiveShadow>
            <boxGeometry args={[r.w, r.h, 1.1]} />
            <meshStandardMaterial color="#8798ab" map={wutheringRuinTex} roughness={0.74} metalness={0.1} />
          </mesh>
          <mesh position={[0, r.h * 0.7, 0]} castShadow>
            <torusGeometry args={[r.w * 0.34, 0.2, 8, 22, Math.PI]} />
            <meshStandardMaterial color="#97a8bb" map={wutheringRockTex} roughness={0.66} metalness={0.16} />
          </mesh>
          <mesh position={[0, -0.48, 0]} receiveShadow>
            <cylinderGeometry args={[r.w * 0.42, r.w * 0.56, 0.16, 12]} />
            <meshPhysicalMaterial color="#617b93" map={wutheringRockTex} roughness={0.12} metalness={0.2} reflectivity={0.9} transmission={0.12} clearcoat={0.9} clearcoatRoughness={0.06} />
          </mesh>
        </group>
      ))}

      <SakuraPetals active={graphicsStylePreset === "sakura-blooms" && !nightMode} />
    </group>
  );
}

function BlenderSurroundingsModel({
  url,
  graphicsStylePreset,
  position = [0, -0.34, 0],
  rotationDeg = [0, 0, 0],
  scale = [1, 1, 1],
  castShadow = true,
  receiveShadow = true,
  textureMode = "auto",
  material,
}: {
  url: string;
  graphicsStylePreset: GraphicsStylePreset;
  position?: [number, number, number];
  rotationDeg?: [number, number, number];
  scale?: number | [number, number, number];
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureMode?: "auto" | "pixelated" | "smooth";
  material?: BlenderAssetEntry["material"];
}) {
  const { gl } = useThree();
  const gltf = useGLTF(url);
  const maxAniso = useMemo(() => Math.min(12, gl.capabilities.getMaxAnisotropy()), [gl]);
  const profilePreset = useMemo(() => {
    if (graphicsStylePreset === "default") return null;
    return PROFILE_ASSET_MATERIAL_PRESET[graphicsStylePreset];
  }, [graphicsStylePreset]);
  const tuning = useMemo(() => {
    const base = profilePreset ?? {
      roughnessMin: 0.3,
      roughnessMax: 0.9,
      metalnessMin: 0.0,
      metalnessMax: 0.3,
      envMapIntensity: 0.6,
      normalScale: 1.0,
      saturation: 1.0,
      brightness: 1.0,
    };
    const custom = material ?? {};
    return {
      roughnessMin: custom.roughnessMin ?? base.roughnessMin,
      roughnessMax: custom.roughnessMax ?? base.roughnessMax,
      metalnessMin: custom.metalnessMin ?? base.metalnessMin,
      metalnessMax: custom.metalnessMax ?? base.metalnessMax,
      envMapIntensity: custom.envMapIntensity ?? base.envMapIntensity,
      normalScale: custom.normalScale ?? base.normalScale,
      saturation: custom.saturation ?? base.saturation,
      brightness: custom.brightness ?? base.brightness,
    };
  }, [profilePreset, material]);
  const normalizedScale = useMemo<[number, number, number]>(() =>
    typeof scale === "number" ? [scale, scale, scale] : scale
  , [scale]);
  const rotation = useMemo<[number, number, number]>(() => [
    THREE.MathUtils.degToRad(rotationDeg[0]),
    THREE.MathUtils.degToRad(rotationDeg[1]),
    THREE.MathUtils.degToRad(rotationDeg[2]),
  ], [rotationDeg]);

  const model = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    cloned.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      const mat = mesh.material as THREE.Material | THREE.Material[];
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        if (!(m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhysicalMaterial)) continue;
        m.roughness = THREE.MathUtils.clamp(m.roughness, tuning.roughnessMin, tuning.roughnessMax);
        m.metalness = THREE.MathUtils.clamp(m.metalness, tuning.metalnessMin, tuning.metalnessMax);
        m.envMapIntensity = tuning.envMapIntensity;
        if (m.color) {
          m.color.multiplyScalar(tuning.brightness);
          m.color.lerp(new THREE.Color(0.5, 0.5, 0.5), 1 - tuning.saturation);
        }

        const pixelMode = textureMode === "pixelated" || (textureMode === "auto" && graphicsStylePreset === "minecraft");
        const textureList = [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap];
        for (const tex of textureList) {
          if (!tex) continue;
          tex.anisotropy = maxAniso;
          if (pixelMode) {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestMipmapNearestFilter;
          } else {
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
          }
          tex.needsUpdate = true;
        }

        if (m.map) {
          m.map.colorSpace = THREE.SRGBColorSpace;
        }
        if (m.normalScale) {
          m.normalScale.setScalar(tuning.normalScale);
        }
      }
    });
    return cloned;
  }, [gltf.scene, graphicsStylePreset, castShadow, receiveShadow, textureMode, maxAniso, tuning]);

  return (
    <group position={position} rotation={rotation} scale={normalizedScale} raycast={NOOP_RAYCAST}>
      <primitive object={model} />
    </group>
  );
}

function ProfileSurroundings({
  graphicsStylePreset,
  fallback,
  onStatusChange,
  forceProcedural,
}: {
  graphicsStylePreset: GraphicsStylePreset;
  fallback: ReactNode;
  onStatusChange?: (status: SurroundingsRuntimeStatus) => void;
  forceProcedural?: boolean;
}) {
  const [resolvedEntries, setResolvedEntries] = useState<BlenderAssetEntry[] | null>(null);

  useEffect(() => {
    if (!forceProcedural) return;
    setResolvedEntries([]);
    onStatusChange?.({ source: "procedural", loaded: 0, expected: 0 });
  }, [forceProcedural, onStatusChange]);

  useEffect(() => {
    if (forceProcedural) return;
    let cancelled = false;

    const resolveEntries = async () => {
      let entries: BlenderAssetEntry[] = [];

      try {
        const manifestRes = await fetch("/models/surroundings/manifest.json", { cache: "no-store" });
        if (manifestRes.ok) {
          const manifest = (await manifestRes.json()) as BlenderSurroundingsManifest;
          const fromManifest = manifest[graphicsStylePreset];
          if (Array.isArray(fromManifest) && fromManifest.length > 0) {
            entries = fromManifest.filter((e): e is BlenderAssetEntry => !!e?.url);
          }
        }
      } catch {
        // Fall back to legacy single-file mapping.
      }

      if (entries.length === 0) {
        const modelUrl = PROFILE_SURROUNDINGS_GLB[graphicsStylePreset];
        if (modelUrl) {
          entries = [{
            url: modelUrl,
            position: [0, -0.34, 0],
            rotationDeg: [0, 0, 0],
            scale: 1,
            castShadow: true,
            receiveShadow: true,
          }];
        }
      }

      if (entries.length === 0) {
        if (!cancelled) {
          setResolvedEntries([]);
          onStatusChange?.({ source: "procedural", loaded: 0, expected: 0 });
        }
        return;
      }

      const exists = await Promise.all(entries.map(async (entry) => {
        try {
          const res = await fetch(entry.url, { method: "HEAD" });
          return res.ok;
        } catch {
          return false;
        }
      }));

      if (!cancelled) {
        const resolved = entries.filter((_, i) => exists[i]);
        setResolvedEntries(resolved);
        onStatusChange?.({
          source: resolved.length > 0 ? "blender" : "procedural",
          loaded: resolved.length,
          expected: entries.length,
        });
      }
    };

    resolveEntries();

    return () => {
      cancelled = true;
    };
  }, [graphicsStylePreset, onStatusChange, forceProcedural]);

  if (forceProcedural || !resolvedEntries || resolvedEntries.length === 0) {
    return (
      <>
        {fallback}
      </>
    );
  }

  return (
    <Suspense fallback={fallback}>
      {resolvedEntries.map((entry, idx) => (
        <BlenderSurroundingsModel
          key={`${entry.url}-${idx}`}
          url={entry.url}
          graphicsStylePreset={graphicsStylePreset}
          position={entry.position}
          rotationDeg={entry.rotationDeg}
          scale={entry.scale}
          castShadow={entry.castShadow}
          receiveShadow={entry.receiveShadow}
          textureMode={entry.textureMode}
          material={entry.material}
        />
      ))}
    </Suspense>
  );
}

function RoamingMinecraftLife({ active }: { active: boolean }) {
  const refs = useRef<Array<THREE.Group | null>>([]);
  const cowHeadRefs = useRef<Array<THREE.Group | null>>([]);
  const cowLegRefs = useRef<Array<Array<THREE.Group | null>>>([]);
  const humanHeadRefs = useRef<Array<THREE.Group | null>>([]);
  const humanArmRefs = useRef<Array<Array<THREE.Group | null>>>([]);
  const humanLegRefs = useRef<Array<Array<THREE.Group | null>>>([]);

  const actors = useMemo(() => ([
    { kind: "cow" as const, cx: -18, cz: 12, rx: 10, rz: 7, speed: 0.08, phase: 0.3 },
    { kind: "cow" as const, cx: 14, cz: -16, rx: 11, rz: 8, speed: 0.07, phase: 1.7 },
    { kind: "character" as const, cx: -8, cz: -9, rx: 7, rz: 6, speed: 0.12, phase: 2.6 },
    { kind: "character" as const, cx: 10, cz: 9, rx: 8, rz: 5, speed: 0.11, phase: 4.2 },
  ]), []);

  useFrame(({ clock }) => {
    if (!active) return;
    const t = clock.elapsedTime;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      const ref = refs.current[i];
      if (!a || !ref) continue;
      const ang = a.phase + t * a.speed;
      const x = a.cx + Math.cos(ang) * a.rx;
      const z = a.cz + Math.sin(ang * 0.92) * a.rz;
      const locomotion = a.kind === "cow" ? 2.4 : 3.1;
      const gait = t * locomotion + a.phase * 2.0;
      ref.position.set(x, -0.02 + Math.sin(gait * 2.0) * (a.kind === "cow" ? 0.022 : 0.03), z);
      ref.rotation.y = Math.atan2(
        -Math.sin(ang) * a.rx,
        Math.cos(ang * 0.92) * a.rz * 0.92
      );

      if (a.kind === "cow") {
        const head = cowHeadRefs.current[i];
        if (head) {
          head.rotation.x = 0.05 + Math.sin(gait * 1.1) * 0.12;
          head.rotation.y = Math.sin(gait * 0.6) * 0.18;
        }
        const legs = cowLegRefs.current[i];
        if (legs?.length === 4) {
          const swingA = Math.sin(gait * 3.2) * 0.48;
          const swingB = Math.sin(gait * 3.2 + Math.PI) * 0.48;
          if (legs[0]) legs[0].rotation.x = swingA;
          if (legs[1]) legs[1].rotation.x = swingB;
          if (legs[2]) legs[2].rotation.x = swingB;
          if (legs[3]) legs[3].rotation.x = swingA;
        }
      } else {
        const head = humanHeadRefs.current[i];
        if (head) {
          head.rotation.x = Math.sin(gait * 1.6) * 0.06;
          head.rotation.y = Math.sin(gait * 0.8) * 0.12;
        }
        const arms = humanArmRefs.current[i];
        if (arms?.length === 2) {
          const armA = Math.sin(gait * 3.6) * 0.62;
          const armB = Math.sin(gait * 3.6 + Math.PI) * 0.62;
          if (arms[0]) arms[0].rotation.x = armA;
          if (arms[1]) arms[1].rotation.x = armB;
        }
        const legs = humanLegRefs.current[i];
        if (legs?.length === 2) {
          const legA = Math.sin(gait * 3.6 + Math.PI) * 0.7;
          const legB = Math.sin(gait * 3.6) * 0.7;
          if (legs[0]) legs[0].rotation.x = legA;
          if (legs[1]) legs[1].rotation.x = legB;
        }
      }
    }
  });

  if (!active) return null;

  return (
    <group>
      {actors.map((a, i) => (
        <group key={`life-${i}`} ref={(node) => { refs.current[i] = node; }} raycast={NOOP_RAYCAST}>
          {a.kind === "cow" ? (
            <group scale={[0.95, 0.95, 0.95]}>
              <mesh position={[0, 0.55, 0]}>
                <boxGeometry args={[1.25, 0.75, 0.72]} />
                <meshStandardMaterial color="#8b5f3b" roughness={0.9} />
              </mesh>
              <group ref={(node) => { cowHeadRefs.current[i] = node; }} position={[0.72, 0.63, 0]}>
                <mesh>
                  <boxGeometry args={[0.52, 0.52, 0.46]} />
                  <meshStandardMaterial color="#a3744a" roughness={0.88} />
                </mesh>
              </group>
              {[[-0.42, 0.36, -0.24], [-0.42, 0.36, 0.24], [0.25, 0.36, -0.24], [0.25, 0.36, 0.24]].map((p, k) => (
                <group key={k} ref={(node) => {
                  if (!cowLegRefs.current[i]) cowLegRefs.current[i] = [];
                  cowLegRefs.current[i][k] = node;
                }} position={[p[0], p[1], p[2]]}>
                  <mesh position={[0, -0.18, 0]}>
                    <boxGeometry args={[0.17, 0.36, 0.17]} />
                    <meshStandardMaterial color="#5f4028" roughness={0.92} />
                  </mesh>
                </group>
              ))}
            </group>
          ) : (
            <group>
              <mesh position={[0, 0.96, 0]}>
                <boxGeometry args={[0.45, 0.64, 0.3]} />
                <meshStandardMaterial color="#3b82f6" roughness={0.82} />
              </mesh>
              <group ref={(node) => { humanHeadRefs.current[i] = node; }} position={[0, 1.4, 0]}>
                <mesh>
                  <boxGeometry args={[0.38, 0.38, 0.38]} />
                  <meshStandardMaterial color="#f3c8a2" roughness={0.92} />
                </mesh>
              </group>
              {[-1, 1].map((s, k) => (
                <group key={`ha-${k}`} ref={(node) => {
                  if (!humanArmRefs.current[i]) humanArmRefs.current[i] = [];
                  humanArmRefs.current[i][k] = node;
                }} position={[s * 0.28, 1.16, 0]}>
                  <mesh position={[0, -0.24, 0]}>
                    <boxGeometry args={[0.12, 0.48, 0.12]} />
                    <meshStandardMaterial color="#274362" roughness={0.86} />
                  </mesh>
                </group>
              ))}
              {[-1, 1].map((s, k) => (
                <group key={`hl-${k}`} ref={(node) => {
                  if (!humanLegRefs.current[i]) humanLegRefs.current[i] = [];
                  humanLegRefs.current[i][k] = node;
                }} position={[s * 0.14, 0.74, 0]}>
                  <mesh position={[0, -0.29, 0]}>
                    <boxGeometry args={[0.14, 0.58, 0.14]} />
                    <meshStandardMaterial color="#2f3f56" roughness={0.86} />
                  </mesh>
                </group>
              ))}
            </group>
          )}
        </group>
      ))}
    </group>
  );
}


// ─── Furniture meshes ─────────────────────────────────────────────────────────
function FurnitureMesh({ type }: { type: string }) {
  const t = type.toLowerCase();
  const wood  = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#7c5a38", roughness:0.72, metalness:0.0, clearcoat:0.04, clearcoatRoughness:0.7 }), []);
  const soft  = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#3a5070", roughness:0.92, metalness:0.0 }), []);
  const metal = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#9ab0b8", metalness:0.85, roughness:0.22, reflectivity:0.9 }), []);
  const white = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#e8e4de", roughness:0.65, metalness:0.0, clearcoat:0.1, clearcoatRoughness:0.5 }), []);
  const dark  = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#1e2530", roughness:0.45, metalness:0.1, clearcoat:0.15, clearcoatRoughness:0.4 }), []);
  const glass = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#88bbdd", transparent:true, opacity:0.35, transmission:0.55, roughness:0.0, metalness:0.0, ior:1.45, reflectivity:0.85 }), []);
  const green = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#2a7a2a", roughness:0.88, metalness:0.0 }), []);
  const fab   = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#4a6080", roughness:0.94, metalness:0.0 }), []);
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
  const wood  = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#7c5a38", roughness:0.72, metalness:0.0, clearcoat:0.04 }), []);
  const soft  = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#3a5a70", roughness:0.94, metalness:0.0 }), []);
  const white = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#e8e4de", roughness:0.65, metalness:0.0, clearcoat:0.1 }), []);
  const dark  = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#252832", roughness:0.45, metalness:0.1, clearcoat:0.18 }), []);
  const metal = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#9aacb4", metalness:0.85, roughness:0.2, reflectivity:0.9 }), []);
  const glassMat = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#88bbdd", transparent:true, opacity:0.32, transmission:0.6, roughness:0.0, ior:1.45, reflectivity:0.88 }), []);
  const green = useMemo(() => new THREE.MeshPhysicalMaterial({ color:"#2a7a2a", roughness:0.88, metalness:0.0 }), []);
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
  { type: "Wall H", w: 3, h: 2.8, d: 0.28, color: "#bcc8d2" }, { type: "Wall V", w: 0.28, h: 2.8, d: 3, color: "#bcc8d2" },
  { type: "Short Wall", w: 1.5, h: 2.8, d: 0.28, color: "#bcc8d2" }, { type: "Half Wall", w: 2, h: 1.2, d: 0.28, color: "#aebbc8" },
  { type: "Thick Wall", w: 3, h: 2.8, d: 0.45, color: "#a6b4c2" }, { type: "Tall Wall", w: 3, h: 4.0, d: 0.28, color: "#bcc8d2" },
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
function buildInitialObjects(rooms: any[], walls: any[] = [], doors: any[] = []): SceneObj[] {
  const allRooms = rooms ?? [];
  if (!allRooms.length) return [];

  const FH = 3.2;
  const allX2 = allRooms.flatMap((r: any) => [r.x, r.x + r.width]);
  const allY2 = allRooms.flatMap((r: any) => [r.y, r.y + r.height]);
  const minX = Math.min(...allX2), maxX = Math.max(...allX2);
  const minY = Math.min(...allY2), maxY = Math.max(...allY2);
  const totalW = maxX - minX;
  const totalD = maxY - minY;
  const offX = -(totalW / 2) - minX;
  const offZ = -(totalD / 2) - minY;

  let id = 0;
  const objs: SceneObj[] = [];

  const ROOM_COLORS: Record<string, string> = {
    living: "#0a1e1e", bedroom: "#0a1422", kitchen: "#0a1c14",
    bathroom: "#160c26", office: "#1c160a", garage: "#161a1a",
    utility: "#1a100a", dining: "#1c0c0c", puja_room: "#18160a",
  };
  const getRoomColor = (type: string) => {
    const t = type.toLowerCase().replace("_", "");
    const k = Object.keys(ROOM_COLORS).find(key => t.includes(key.replace("_", "")));
    return k ? ROOM_COLORS[k] : "#101818";
  };

  allRooms.forEach((room: any) => {
    const floorOffset = ((room.floor ?? 1) - 1) * (FH + 0.25);
    objs.push({
      id: `room-${id++}`,
      kind: "room",
      type: room.type,
      x: offX + room.x + room.width / 2,
      y: floorOffset + FH / 2,
      z: offZ + room.y + room.height / 2,
      rotY: 0,
      w: room.width,
      h: FH,
      d: room.height,
      color: getRoomColor(room.type),
    });
  });

  walls.forEach((wall: any) => {
    const floorOffset = ((wall.floor ?? 1) - 1) * (FH + 0.25);
    const horizontal = wall.orientation === "horizontal";
    const wallHeight = wall.height ?? FH;
    const openings = doors
      .filter((door: any) => door.floor === wall.floor && ((horizontal && door.orientation === "horizontal") || (!horizontal && door.orientation === "vertical")))
      .filter((door: any) => Math.abs((horizontal ? door.y : door.x) - (horizontal ? wall.y : wall.x)) < 0.18)
      .sort((a: any, b: any) => (horizontal ? a.x - b.x : a.y - b.y));

    if (!openings.length) {
      objs.push({
        id: wall.id ?? `wall-${id++}`,
        kind: "wall",
        type: wall.type === "exterior" ? "Exterior Wall" : "Interior Wall",
        x: offX + wall.x,
        y: floorOffset + wallHeight / 2,
        z: offZ + wall.y,
        rotY: 0,
        w: horizontal ? wall.length : wall.thickness,
        h: wallHeight,
        d: horizontal ? wall.thickness : wall.length,
        color: wall.type === "exterior" ? "#d0dde4" : "#b8c8cc",
      });
      return;
    }

    const start = (horizontal ? wall.x : wall.y) - wall.length / 2;
    const end = (horizontal ? wall.x : wall.y) + wall.length / 2;
    let cursor = start;
    openings.forEach((door: any) => {
      const center = horizontal ? door.x : door.y;
      const gapHalf = door.width / 2;
      const gapStart = Math.max(start, center - gapHalf);
      const gapEnd = Math.min(end, center + gapHalf);
      const segLen = gapStart - cursor;
      if (segLen > 0.18) {
        objs.push({
          id: `${wall.id ?? `wall-${id++}`}-a-${cursor.toFixed(2)}`,
          kind: "wall",
          type: wall.type === "exterior" ? "Exterior Wall" : "Interior Wall",
          x: offX + (horizontal ? cursor + segLen / 2 : wall.x),
          y: floorOffset + wallHeight / 2,
          z: offZ + (horizontal ? wall.y : cursor + segLen / 2),
          rotY: 0,
          w: horizontal ? segLen : wall.thickness,
          h: wallHeight,
          d: horizontal ? wall.thickness : segLen,
          color: wall.type === "exterior" ? "#d0dde4" : "#b8c8cc",
        });
      }
      cursor = gapEnd;
    });
    const tail = end - cursor;
    if (tail > 0.18) {
      objs.push({
        id: `${wall.id ?? `wall-${id++}`}-b-${cursor.toFixed(2)}`,
        kind: "wall",
        type: wall.type === "exterior" ? "Exterior Wall" : "Interior Wall",
        x: offX + (horizontal ? cursor + tail / 2 : wall.x),
        y: floorOffset + wallHeight / 2,
        z: offZ + (horizontal ? wall.y : cursor + tail / 2),
        rotY: 0,
        w: horizontal ? tail : wall.thickness,
        h: wallHeight,
        d: horizontal ? wall.thickness : tail,
        color: wall.type === "exterior" ? "#d0dde4" : "#b8c8cc",
      });
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
  const { floorPlan, analysis, floorPlanVariants, activeVariantIndex, selectedLat, selectedLon } = useEco3DStore();
  const activeVariant = floorPlanVariants[activeVariantIndex] ?? null;
  const rooms = activeVariant?.layout ?? floorPlan?.layout ?? [];
  const walls = activeVariant?.walls ?? floorPlan?.walls ?? [];
  const doors = activeVariant?.doors ?? floorPlan?.doors ?? [];
  const lat = selectedLat ?? 34.0522;
  const lon = selectedLon ?? -118.2437;
  const [liveEnv, setLiveEnv] = useState<Awaited<ReturnType<typeof fetchLiveEnvironment>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;

    const refreshLiveEnv = async () => {
      try {
        const snapshot = await fetchLiveEnvironment(lat, lon);
        if (!cancelled) {
          setLiveEnv(snapshot);
        }
      } catch {
        // Keep the last known real snapshot if a refresh fails temporarily.
      }
    };

    void refreshLiveEnv();
    intervalId = window.setInterval(() => {
      void refreshLiveEnv();
    }, 45000);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [lat, lon]);

  const isLiveEnvReady = liveEnv !== null;
  const windDir = liveEnv?.windDirectionCardinal ?? "—";
  const windDirectionDeg = liveEnv?.windDirectionDeg ?? 0;
  const sunHours = analysis?.environmental?.sun_exposure_hours ?? 8.2;
  const fallbackSun = computeSunPosition(new Date(), lat, lon);
  const sunAzimuthDeg = liveEnv?.sunAzimuthDeg ?? fallbackSun.azimuthDeg;
  const sunElevationDeg = liveEnv?.sunElevationDeg ?? fallbackSun.elevationDeg;
  const sunDataSourceLabel = liveEnv ? "LIVE" : "LOCAL ESTIMATE";
  const sunVectorLabel = (liveEnv !== null || Number.isFinite(sunElevationDeg))
    ? `${Math.round(sunAzimuthDeg)}° az · ${sunElevationDeg.toFixed(1)}° el`
    : "UNAVAILABLE";
  const meteoBadgeLabel = liveEnv ? "LIVE FROM OPEN-METEO" : "LIVE MODE: WAITING FOR OPEN-METEO";

  const [objects, setObjects] = useState<SceneObj[]>(() => buildInitialObjects(rooms, walls, doors));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<"rooms" | "walls" | "objects" | "glass">("rooms");
  const [showGrid, setShowGrid] = useState(false);
  const [showSun, setShowSun] = useState(true);
  const [showWind, setShowWind] = useState(false);
  const [nightLight, setNightLight] = useState(false);
  const [showRain, setShowRain] = useState(false);
  const [showSnow, setShowSnow] = useState(false);
  const [showMoon, setShowMoon] = useState(false);
  const [showFlood, setShowFlood] = useState(false);
  const [showSolarSystem, setShowSolarSystem] = useState(false);
  const [musicEnabled, setMusicEnabled] = useState(false);
  const [musicPanelOpen, setMusicPanelOpen] = useState(false);
  const [musicTrackId, setMusicTrackId] = useState<MusicTrackId>("night-slow");
  const [musicVolume, setMusicVolume] = useState(0.42);
  const [musicPlaybackState, setMusicPlaybackState] = useState<MusicPlaybackState>("idle");
  const [timeOfDayMode, setTimeOfDayMode] = useState<TimeOfDayMode>("auto");
  const [renderQuality, setRenderQuality] = useState<RenderQuality>("high");
  const [showShaders, setShowShaders] = useState(true);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [leftSectionsOpen, setLeftSectionsOpen] = useState<Record<string, boolean>>({
    meteo: true,
    camera: true,
    time: true,
    overlays: true,
    graphics: true,
  });
  const [graphicsStylePreset, setGraphicsStylePreset] = useState<GraphicsStylePreset>("default");
  const [sunriseRaysIntensity, setSunriseRaysIntensity] = useState(0.78);
  const [cloudDensity, setCloudDensity] = useState(0.62);
  const [waterStyle, setWaterStyle] = useState(0.74);
  const [surroundingsBlend, setSurroundingsBlend] = useState(0.84);
  const [shaderLookPreset, setShaderLookPreset] = useState<ShaderLookPreset>("custom");
  const [surroundingsRuntimeStatus, setSurroundingsRuntimeStatus] = useState<SurroundingsRuntimeStatus>({ source: "procedural", loaded: 0, expected: 0 });
  const [surroundingsRenderMode, setSurroundingsRenderMode] = useState<SurroundingsRenderMode>("blender");
  const [sunsetCinematic, setSunsetCinematic] = useState(false);
  const [camMode, setCamMode] = useState<"iso" | "top" | "interior">("iso");
  const [fps, setFps] = useState(0);
  const [wallColor, setWallColor] = useState("#bcc8d2");
  const [texType, setTexType] = useState<TexType>("none");
  const [winColor, setWinColor] = useState("#1a90e8");
  const [winOpacity, setWinOpacity] = useState(0.5);
  const nid = useRef(5000);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const selected = objects.find(o => o.id === selectedId) ?? null;
  const activeMusicTrack = useMemo(() => BACKGROUND_TRACKS.find(t => t.id === musicTrackId) ?? BACKGROUND_TRACKS[0], [musicTrackId]);

  const shouldForceNightEffects = showSolarSystem;
  const isNightBySun = sunElevationDeg < -0.5;
  const isNightScene = timeOfDayMode === "night" || (timeOfDayMode === "auto" && (isNightBySun || shouldForceNightEffects));
  const styledSunAzimuthDeg = sunAzimuthDeg;
  const styledSunElevationDeg = sunElevationDeg;
  const cinematicSunAzimuthDeg = sunsetCinematic
    ? styledSunAzimuthDeg
    : styledSunAzimuthDeg;
  const cinematicSunElevationDeg = sunsetCinematic
    ? styledSunElevationDeg
    : styledSunElevationDeg;
  const visualSunAzimuthDeg = cinematicSunAzimuthDeg;
  const visualSunElevationDeg = (timeOfDayMode === "day" && graphicsStylePreset !== "default")
    ? Math.max(cinematicSunElevationDeg, 20)
    : cinematicSunElevationDeg;
  const effectiveShowSun = showSun && !isNightScene;
  const effectiveShowMoon = showMoon;
  const effectiveSunriseRays = sunsetCinematic ? Math.max(sunriseRaysIntensity, 0.82) : sunriseRaysIntensity;
  const effectiveCloudDensity = sunsetCinematic ? THREE.MathUtils.clamp(Math.max(cloudDensity, 0.45), 0.1, 0.86) : cloudDensity;
  const effectiveWaterStyle = waterStyle;
  const effectiveSurroundingsBlend = sunsetCinematic ? Math.max(surroundingsBlend, 0.72) : surroundingsBlend;
  const profileSupportsBlendToggle = graphicsStylePreset === "minecraft" || graphicsStylePreset === "sakura-blooms" || graphicsStylePreset === "valorant" || graphicsStylePreset === "wuthering-waves";
  const forceProceduralSurroundings = profileSupportsBlendToggle && surroundingsRenderMode === "normal";

  const applyGraphicsStylePreset = useCallback((preset: GraphicsStylePreset) => {
    if (preset === "default") {
      setSunsetCinematic(false);
      setShaderLookPreset("custom");
      setTimeOfDayMode("auto");
      setSunriseRaysIntensity(0.12);
      setCloudDensity(0.34);
      setWaterStyle(0.3);
      setSurroundingsBlend(0.35);
      setRenderQuality("high");
      return;
    }
    if (preset === "minecraft") {
      setTimeOfDayMode("day");
      setSunriseRaysIntensity(1.48);
      setCloudDensity(0.76);
      setWaterStyle(0.96);
      setSurroundingsBlend(1.0);
      setRenderQuality("ultra");
      return;
    }
    if (preset === "sakura-blooms") {
      setTimeOfDayMode("day");
      setSunriseRaysIntensity(1.08);
      setCloudDensity(0.74);
      setWaterStyle(0.72);
      setSurroundingsBlend(0.98);
      setRenderQuality("ultra");
      return;
    }
    if (preset === "valorant") {
      setTimeOfDayMode("day");
      setSunriseRaysIntensity(0.52);
      setCloudDensity(0.28);
      setWaterStyle(0.18);
      setSurroundingsBlend(0.42);
      setRenderQuality("high");
      return;
    }
    setTimeOfDayMode("day");
    setSunriseRaysIntensity(1.18);
    setCloudDensity(0.78);
    setWaterStyle(0.92);
    setSurroundingsBlend(0.95);
    setRenderQuality("ultra");
  }, [setRenderQuality, setSunsetCinematic, setTimeOfDayMode]);

  const applyShaderPreset = useCallback((preset: ShaderLookPreset) => {
    setShaderLookPreset(preset);
    if (preset === "golden-hour") {
      setTimeOfDayMode("day");
      setSunriseRaysIntensity(1.34);
      setCloudDensity(0.58);
      setWaterStyle(0.9);
      setSurroundingsBlend(0.9);
      setRenderQuality("ultra");
      return;
    }
    if (preset === "cinematic-day") {
      setTimeOfDayMode("day");
      setSunriseRaysIntensity(0.94);
      setCloudDensity(0.72);
      setWaterStyle(0.82);
      setSurroundingsBlend(0.86);
      setRenderQuality("ultra");
      return;
    }
    if (preset === "deep-night") {
      setTimeOfDayMode("night");
      setShowMoon(true);
      setSunriseRaysIntensity(0.22);
      setCloudDensity(0.42);
      setWaterStyle(0.78);
      setSurroundingsBlend(0.88);
      setRenderQuality("high");
    }
  }, [setTimeOfDayMode, setShowMoon, setRenderQuality]);

  useEffect(() => {
    applyGraphicsStylePreset(graphicsStylePreset);
  }, [graphicsStylePreset, applyGraphicsStylePreset]);

  useEffect(() => {
    if (graphicsStylePreset === "default") {
      setSurroundingsRuntimeStatus({ source: "procedural", loaded: 0, expected: 0 });
    }
  }, [graphicsStylePreset]);

  useEffect(() => {
    if (!sunsetCinematic) {
      applyGraphicsStylePreset(graphicsStylePreset);
      return;
    }
    setTimeOfDayMode("day");
    setShowSun(true);
    setShaderLookPreset("golden-hour");
    setSunriseRaysIntensity(v => Math.max(v, 0.82));
    setCloudDensity(v => Math.max(v, 0.45));
    setSurroundingsBlend(v => Math.max(v, 0.72));
    setRenderQuality("ultra");
  }, [sunsetCinematic, graphicsStylePreset, applyGraphicsStylePreset]);

  // Rebuild scene when floor plan data loads
  useEffect(() => {
    if (rooms.length > 0) {
      setObjects(buildInitialObjects(rooms, walls, doors));
    }
  }, [rooms, walls, doors, activeVariantIndex]);

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

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.loop = true;
    audio.volume = 0.42;
    musicAudioRef.current = audio;

    const onPlaying = () => setMusicPlaybackState("playing");
    const onPause = () => setMusicPlaybackState("paused");
    const onError = () => setMusicPlaybackState("error");
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);

    return () => {
      audio.pause();
      audio.src = "";
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
      musicAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!musicAudioRef.current) return;
    musicAudioRef.current.volume = musicVolume;
  }, [musicVolume]);

  useEffect(() => {
    const audio = musicAudioRef.current;
    if (!audio) return;
    if (audio.src !== window.location.origin + activeMusicTrack.src) {
      audio.src = activeMusicTrack.src;
    }
    if (musicEnabled) {
      audio.play().then(() => {
        setMusicPlaybackState("playing");
      }).catch(() => {
        // Browser autoplay policy or missing file; keep UI stable.
        setMusicPlaybackState("error");
      });
    } else {
      audio.pause();
      setMusicPlaybackState("paused");
    }
  }, [musicEnabled, activeMusicTrack]);

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
  const toggleLeftSection = useCallback((key: string) => {
    setLeftSectionsOpen(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const sectionCardStyle: React.CSSProperties = {
    background: "rgba(13,242,242,0.04)",
    border: "1px solid rgba(13,242,242,0.08)",
    borderRadius: 6,
    padding: "7px 9px",
  };

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
        <div style={{ width: leftSidebarCollapsed ? 48 : 196, flexShrink: 0, background: "rgba(5,9,9,0.98)", padding: "10px 9px", display: "flex", flexDirection: "column", gap: 7, borderRight: "1px solid rgba(255,255,255,0.05)", overflowY: "auto", transition: "width 0.24s" }}>
          <button
            onClick={() => setLeftSidebarCollapsed(v => !v)}
            style={{
              width: "100%",
              minHeight: 28,
              borderRadius: 6,
              border: "1px solid rgba(13,242,242,0.25)",
              background: "rgba(13,242,242,0.08)",
              color: "#0df2f2",
              display: "flex",
              alignItems: "center",
              justifyContent: leftSidebarCollapsed ? "center" : "space-between",
              cursor: "pointer",
              padding: leftSidebarCollapsed ? "0" : "0 8px",
              fontFamily: "'DM Mono',monospace",
              fontSize: 8,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {!leftSidebarCollapsed && <span>Controls</span>}
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{leftSidebarCollapsed ? "chevron_right" : "chevron_left"}</span>
          </button>

          {!leftSidebarCollapsed && <>
            <div style={sectionCardStyle}>
              <button onClick={() => toggleLeftSection("meteo")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: 0, marginBottom: leftSectionsOpen.meteo ? 5 : 0, cursor: "pointer" }}>
                <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Meteo</div>
                <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0df2f2" }}>{leftSectionsOpen.meteo ? "expand_less" : "expand_more"}</span>
              </button>
              {leftSectionsOpen.meteo && [{ l: "Live", v: meteoBadgeLabel }, { l: "Sun", v: `${sunVectorLabel} · ${sunHours.toFixed(1)}h` }, { l: "Wind", v: `Prevailing ${windDir}` }, { l: "Objects", v: `${objects.length} in scene` }].map(({ l, v }) => (
                <div key={l} style={{ padding: "4px 0", borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>{l}</div>
                  <div style={{ fontSize: 9.5, color: "white", fontWeight: 600, lineHeight: 1.35 }}>{v}</div>
                </div>
              ))}
            </div>

            <div style={sectionCardStyle}>
              <button onClick={() => toggleLeftSection("camera")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: 0, marginBottom: leftSectionsOpen.camera ? 5 : 0, cursor: "pointer" }}>
                <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Camera</div>
                <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0df2f2" }}>{leftSectionsOpen.camera ? "expand_less" : "expand_more"}</span>
              </button>
              {leftSectionsOpen.camera && ([["iso", "Isometric"], ["top", "Top-Down"], ["interior", "Interior"]] as const).map(([v, l]) => (
                <button key={v} onClick={() => setCamMode(v)} style={{ display: "block", width: "100%", padding: "4px 6px", marginBottom: 3, background: camMode === v ? "rgba(13,242,242,0.15)" : "transparent", border: `1px solid ${camMode === v ? "rgba(13,242,242,0.3)" : "rgba(255,255,255,0.05)"}`, borderRadius: 4, color: camMode === v ? "#0df2f2" : "#64748b", fontSize: 9, cursor: "pointer", textAlign: "left", fontFamily: "'DM Mono',monospace" }}>{l}</button>
              ))}
            </div>

            <div style={sectionCardStyle}>
              <button onClick={() => toggleLeftSection("time")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: 0, marginBottom: leftSectionsOpen.time ? 5 : 0, cursor: "pointer" }}>
                <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Time</div>
                <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0df2f2" }}>{leftSectionsOpen.time ? "expand_less" : "expand_more"}</span>
              </button>
              {leftSectionsOpen.time && ([ ["auto", "Auto"], ["day", "Day"], ["night", "Night"] ] as const).map(([mode, label]) => (
                <button key={mode} onClick={() => setTimeOfDayMode(mode)} style={{ display: "block", width: "100%", padding: "4px 6px", marginBottom: 3, background: timeOfDayMode === mode ? "rgba(13,242,242,0.15)" : "transparent", border: `1px solid ${timeOfDayMode === mode ? "rgba(13,242,242,0.3)" : "rgba(255,255,255,0.05)"}`, borderRadius: 4, color: timeOfDayMode === mode ? "#0df2f2" : "#64748b", fontSize: 9, cursor: "pointer", textAlign: "left", fontFamily: "'DM Mono',monospace" }}>{label}</button>
              ))}
            </div>

            <div style={sectionCardStyle}>
              <button onClick={() => toggleLeftSection("overlays")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: 0, marginBottom: leftSectionsOpen.overlays ? 5 : 0, cursor: "pointer" }}>
                <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Overlays</div>
                <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0df2f2" }}>{leftSectionsOpen.overlays ? "expand_less" : "expand_more"}</span>
              </button>
              {leftSectionsOpen.overlays && [{ l: "Sun", active: showSun, fn: () => setShowSun(v => !v) }, { l: "Grid", active: showGrid, fn: () => setShowGrid(v => !v) }].map(({ l, active, fn }) => (
                <button key={l} onClick={fn} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "4px 0", background: "none", border: "none", cursor: "pointer", marginBottom: 2 }}>
                  <span style={{ fontSize: 9, color: "#64748b", fontFamily: "'DM Mono',monospace" }}>{l}</span>
                  <span style={{ width: 24, height: 12, borderRadius: 6, background: active ? "#0df2f2" : "#1e2a2a", display: "block", position: "relative", transition: "background 0.2s" }}>
                    <span style={{ position: "absolute", top: 2, left: active ? 10 : 2, width: 8, height: 8, borderRadius: "50%", background: active ? "#060e0e" : "#475569", transition: "left 0.2s" }} />
                  </span>
                </button>
              ))}
            </div>

            <div style={sectionCardStyle}>
              <button onClick={() => toggleLeftSection("graphics")} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", padding: 0, marginBottom: leftSectionsOpen.graphics ? 6 : 0, cursor: "pointer" }}>
                <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.45)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Graphics</div>
                <span className="material-symbols-outlined" style={{ fontSize: 13, color: "#0df2f2" }}>{leftSectionsOpen.graphics ? "expand_less" : "expand_more"}</span>
              </button>
              {leftSectionsOpen.graphics && <>
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.56)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "'DM Mono',monospace" }}>Style Preset</div>
                  <select
                    value={graphicsStylePreset}
                    onChange={(e) => setGraphicsStylePreset(e.target.value as GraphicsStylePreset)}
                    style={{
                      width: "100%",
                      background: "rgba(0,0,0,0.35)",
                      border: "1px solid rgba(13,242,242,0.2)",
                      borderRadius: 4,
                      color: "#c9fbff",
                      padding: "5px 6px",
                      fontSize: 8.5,
                      fontFamily: "'DM Mono',monospace",
                      cursor: "pointer",
                    }}
                  >
                    <option value="default">Default 3D</option>
                    <option value="minecraft">Minecraft Inspired</option>
                    <option value="sakura-blooms">Sakura Blooms</option>
                    <option value="valorant">Valorant Inspired</option>
                    <option value="wuthering-waves">Wuthering Waves Inspired</option>
                  </select>
                </div>
                {graphicsStylePreset !== "default" && (
                  <div style={{ marginBottom: 7, padding: "6px 7px", borderRadius: 5, border: `1px solid ${surroundingsRuntimeStatus.source === "blender" ? "rgba(74,222,128,0.45)" : "rgba(248,113,113,0.45)"}`, background: surroundingsRuntimeStatus.source === "blender" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.1)" }}>
                    <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.56)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2, fontFamily: "'DM Mono',monospace" }}>Blender Assets</div>
                    <div style={{ fontSize: 8.2, color: surroundingsRuntimeStatus.source === "blender" ? "#86efac" : "#fca5a5", fontFamily: "'DM Mono',monospace" }}>
                      {surroundingsRuntimeStatus.source === "blender"
                        ? `Loaded ${surroundingsRuntimeStatus.loaded}/${surroundingsRuntimeStatus.expected} Blender assets`
                        : `Procedural fallback (${surroundingsRuntimeStatus.loaded}/${surroundingsRuntimeStatus.expected} asset files found)`}
                    </div>
                    {profileSupportsBlendToggle && (
                      <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
                        <button
                          onClick={() => setSurroundingsRenderMode("blender")}
                          style={{
                            flex: 1,
                            padding: "4px 6px",
                            borderRadius: 4,
                            border: `1px solid ${surroundingsRenderMode === "blender" ? "rgba(74,222,128,0.6)" : "rgba(255,255,255,0.1)"}`,
                            background: surroundingsRenderMode === "blender" ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.03)",
                            color: surroundingsRenderMode === "blender" ? "#86efac" : "#94a3b8",
                            cursor: "pointer",
                            fontSize: 8,
                            fontFamily: "'DM Mono',monospace",
                          }}
                        >
                          Blender
                        </button>
                        <button
                          onClick={() => setSurroundingsRenderMode("normal")}
                          style={{
                            flex: 1,
                            padding: "4px 6px",
                            borderRadius: 4,
                            border: `1px solid ${surroundingsRenderMode === "normal" ? "rgba(248,113,113,0.6)" : "rgba(255,255,255,0.1)"}`,
                            background: surroundingsRenderMode === "normal" ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.03)",
                            color: surroundingsRenderMode === "normal" ? "#fca5a5" : "#94a3b8",
                            cursor: "pointer",
                            fontSize: 8,
                            fontFamily: "'DM Mono',monospace",
                          }}
                        >
                          Normal 3D
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 7.5, color: "rgba(13,242,242,0.56)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3, fontFamily: "'DM Mono',monospace" }}>Reference Look</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 3 }}>
                    {[
                      { id: "golden-hour" as ShaderLookPreset, label: "Golden Hour" },
                      { id: "cinematic-day" as ShaderLookPreset, label: "Cinematic Day" },
                      { id: "deep-night" as ShaderLookPreset, label: "Deep Night" },
                    ].map((p) => (
                      <button
                        key={p.id}
                        onClick={() => applyShaderPreset(p.id)}
                        style={{
                          padding: "4px 6px",
                          borderRadius: 4,
                          border: `1px solid ${shaderLookPreset === p.id ? "rgba(13,242,242,0.46)" : "rgba(255,255,255,0.08)"}`,
                          background: shaderLookPreset === p.id ? "rgba(13,242,242,0.14)" : "rgba(255,255,255,0.03)",
                          color: shaderLookPreset === p.id ? "#b7feff" : "#7dd3fc",
                          cursor: "pointer",
                          textAlign: "left",
                          fontSize: 8,
                          fontFamily: "'DM Mono',monospace",
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 7, padding: "6px 7px", borderRadius: 5, border: `1px solid ${sunsetCinematic ? "rgba(251,146,60,0.55)" : "rgba(255,255,255,0.08)"}`, background: sunsetCinematic ? "linear-gradient(135deg, rgba(249,115,22,0.14), rgba(245,158,11,0.08))" : "rgba(255,255,255,0.02)" }}>
                  <button
                    onClick={() => setSunsetCinematic(v => !v)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ fontSize: 8, color: sunsetCinematic ? "#fdba74" : "#7dd3fc", fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.06em" }}>Sunset Cinematic Lock</span>
                    <span style={{ width: 24, height: 12, borderRadius: 6, background: sunsetCinematic ? "#fb923c" : "#1e2a2a", display: "block", position: "relative", transition: "background 0.2s" }}>
                      <span style={{ position: "absolute", top: 2, left: sunsetCinematic ? 10 : 2, width: 8, height: 8, borderRadius: "50%", background: sunsetCinematic ? "#3a1202" : "#475569", transition: "left 0.2s" }} />
                    </span>
                  </button>
                </div>
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 8, color: "#7dd3fc", fontFamily: "'DM Mono',monospace" }}>Sunrise Rays</span>
                    <span style={{ fontSize: 8, color: "#bae6fd", fontFamily: "'DM Mono',monospace" }}>{sunriseRaysIntensity.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={2.2} step={0.01} value={sunriseRaysIntensity} onChange={(e) => { setShaderLookPreset("custom"); setSunriseRaysIntensity(parseFloat(e.target.value)); }} style={{ width: "100%", accentColor: "#f59e0b", cursor: "pointer" }} />
                </div>
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 8, color: "#7dd3fc", fontFamily: "'DM Mono',monospace" }}>Cloud Density</span>
                    <span style={{ fontSize: 8, color: "#bae6fd", fontFamily: "'DM Mono',monospace" }}>{cloudDensity.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0.1} max={1} step={0.01} value={cloudDensity} onChange={(e) => { setShaderLookPreset("custom"); setCloudDensity(parseFloat(e.target.value)); }} style={{ width: "100%", accentColor: "#7dd3fc", cursor: "pointer" }} />
                </div>
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 8, color: "#7dd3fc", fontFamily: "'DM Mono',monospace" }}>Water Reflect/Wave</span>
                    <span style={{ fontSize: 8, color: "#bae6fd", fontFamily: "'DM Mono',monospace" }}>{waterStyle.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={waterStyle} onChange={(e) => { setShaderLookPreset("custom"); setWaterStyle(parseFloat(e.target.value)); }} style={{ width: "100%", accentColor: "#38bdf8", cursor: "pointer" }} />
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 8, color: "#7dd3fc", fontFamily: "'DM Mono',monospace" }}>Stylized ↔ Realistic</span>
                    <span style={{ fontSize: 8, color: "#bae6fd", fontFamily: "'DM Mono',monospace" }}>{surroundingsBlend.toFixed(2)}</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.01} value={surroundingsBlend} onChange={(e) => { setShaderLookPreset("custom"); setSurroundingsBlend(parseFloat(e.target.value)); }} style={{ width: "100%", accentColor: "#34d399", cursor: "pointer" }} />
                </div>
              </>}
            </div>
          </>}

          <div style={{ marginTop: "auto", textAlign: "center", borderTop: leftSidebarCollapsed ? "none" : "1px solid rgba(255,255,255,0.04)", paddingTop: leftSidebarCollapsed ? 0 : 8 }}>
            <div style={{ fontSize: leftSidebarCollapsed ? 9 : 11, color: "#0df2f2", fontFamily: "'DM Mono',monospace", fontWeight: 500 }}>{fps} FPS</div>
            {!leftSidebarCollapsed && <div style={{ fontSize: 8, color: "#334155", fontFamily: "'DM Mono',monospace" }}>{objects.length} objects</div>}
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
                toneMappingExposure: isNightScene
                  ? 0.66
                  : graphicsStylePreset === "default"
                    ? 0.72
                    : THREE.MathUtils.lerp(1.0, 1.16, effectiveSurroundingsBlend) * (0.92 + effectiveSunriseRays * 0.22) * (graphicsStylePreset === "valorant" ? 1.03 : graphicsStylePreset === "wuthering-waves" ? 1.0 : graphicsStylePreset === "minecraft" ? 1.05 : graphicsStylePreset === "sakura-blooms" ? 1.03 : 1.02),
              }}
              dpr={Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, renderQuality === "ultra" ? 2.5 : renderQuality === "high" ? 2 : renderQuality === "med" ? 1.5 : 1)}
              key={camMode}
              onPointerMissed={() => { if (editMode) setSelectedId(null); }}>
              <Suspense fallback={null}>
                {/* Visible sky dome for realistic daytime atmosphere. */}
                {graphicsStylePreset !== "default" && <RealisticSky nightMode={isNightScene} sunAzimuthDeg={visualSunAzimuthDeg} sunElevationDeg={visualSunElevationDeg} sunriseRaysIntensity={effectiveSunriseRays} surroundingsBlend={effectiveSurroundingsBlend} />}
                <VoxelClouds active={!isNightScene && graphicsStylePreset !== "default"} sunElevationDeg={visualSunElevationDeg} cloudDensity={effectiveCloudDensity} surroundingsBlend={effectiveSurroundingsBlend} />
                <NightStarfield active={isNightScene} />

                {/* PBR environment — IBL image-based lighting for all surfaces */}
                <PBREnvironment sunOn={effectiveShowSun} nightMode={isNightScene} graphicsStylePreset={graphicsStylePreset} />

                {/* Scene lights + weather effects */}
                <Lighting sunAzimuthDeg={visualSunAzimuthDeg} sunElevationDeg={visualSunElevationDeg} sunOn={effectiveShowSun} nightLightOn={nightLight} nightMode={isNightScene} sunriseRaysIntensity={effectiveSunriseRays} />
                <ArchitecturalNightFill nightMode={isNightScene} assistOn={nightLight} />
                <StylePresetFill graphicsStylePreset={graphicsStylePreset} nightMode={isNightScene} />

                {/* Shader ground replaces plain mesh ground */}
                <PBRGround showGrid={showGrid} wet={showFlood} nightMode={isNightScene} graphicsStylePreset={graphicsStylePreset} />

                {/* Natural surroundings for depth and color context */}
                {graphicsStylePreset !== "default" && (
                  <ProfileSurroundings
                    graphicsStylePreset={graphicsStylePreset}
                    fallback={<DistantScenery nightMode={isNightScene} sunElevationDeg={visualSunElevationDeg} surroundingsBlend={effectiveSurroundingsBlend} waterStyle={effectiveWaterStyle} graphicsStylePreset={graphicsStylePreset} />}
                    onStatusChange={setSurroundingsRuntimeStatus}
                    forceProcedural={forceProceduralSurroundings}
                  />
                )}
                {graphicsStylePreset === "minecraft" && <RoamingMinecraftLife active={!showFlood && !showSnow} />}

                {/* All scene objects */}
                {objects.map(obj => (
                  <SceneObject key={obj.id} obj={obj} selected={selectedId === obj.id}
                    editMode={editMode}
                    onSelect={id => setSelectedId(p => p === id ? null : id)}
                    onUpdate={updateObject}
                    onDragChange={handleDragChange} />
                ))}

                {/* Sky & environment overlays */}
                {graphicsStylePreset !== "default" && effectiveShowSun && <SunSphere sunAzimuthDeg={visualSunAzimuthDeg} sunElevationDeg={visualSunElevationDeg} sunriseRaysIntensity={effectiveSunriseRays} />}
                {graphicsStylePreset !== "default" && <SunRayBeams active={effectiveShowSun} sunAzimuthDeg={visualSunAzimuthDeg} sunElevationDeg={visualSunElevationDeg} strength={effectiveSunriseRays} />}
                {showWind && isLiveEnvReady && <WindSwirl windDirectionDeg={windDirectionDeg} modelW={modelBounds.w} modelD={modelBounds.d} />}
                {showRain && <Rain />}
                {showSnow && <Snow />}
                <AtmosphereDust active={graphicsStylePreset !== "default" && !showRain && !showSnow && !showFlood} />
                {effectiveShowMoon && <Moonlight />}
                {showFlood && <Flood waterStyle={effectiveWaterStyle} />}
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
                {showShaders && <RenderPipeline quality={renderQuality} cinematicBoost={effectiveSunriseRays} sunElevationDeg={visualSunElevationDeg} nightMode={isNightScene} graphicsStylePreset={graphicsStylePreset} />}
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
              { l: "MUSIC", i: "music_note",      active: musicEnabled, fn: () => { setMusicEnabled(v => !v); setMusicPanelOpen(true); }, color: "#22d3ee" },
              { l: "SHADER",i: "lens_blur",      active: showShaders,fn: () => setShowShaders(v=>!v),  color: "#e879f9" },
              { l: "GRID",  i: "grid_on",        active: showGrid,   fn: () => setShowGrid(v => !v),   color: "#0df2f2" },
            ].map(({ l, i, active, fn, color }) => (
              <button key={l} onClick={fn} style={{ width: 44, height: 44, background: active ? `${color}22` : "rgba(6,14,14,0.92)", border: `1px solid ${active ? `${color}88` : "rgba(255,255,255,0.06)"}`, borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, cursor: "pointer", transition: "all 0.2s" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: active ? color : "#475569" }}>{i}</span>
                <span style={{ fontSize: 6, color: active ? color : "#334155", fontFamily: "monospace", letterSpacing: "0.06em" }}>{l}</span>
              </button>
            ))}
          </div>

          {musicPanelOpen && (
            <div style={{
              position: "absolute",
              right: 62,
              top: 14,
              width: 242,
              background: "rgba(6,14,14,0.94)",
              border: "1px solid rgba(34,211,238,0.25)",
              borderRadius: 8,
              padding: "9px 10px",
              boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
              zIndex: 8,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 8, color: "#67e8f9", fontFamily: "'DM Mono',monospace", letterSpacing: "0.08em", textTransform: "uppercase" }}>Soundtrack</div>
                <button
                  onClick={() => setMusicPanelOpen(false)}
                  style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 12, lineHeight: 1 }}
                >✕</button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginBottom: 7 }}>
                <select
                  value={musicTrackId}
                  onChange={(e) => setMusicTrackId(e.target.value as MusicTrackId)}
                  style={{
                    width: "100%",
                    background: "rgba(0,0,0,0.35)",
                    border: "1px solid rgba(34,211,238,0.25)",
                    borderRadius: 5,
                    color: "#cffafe",
                    padding: "5px 6px",
                    fontSize: 8.5,
                    fontFamily: "'DM Mono',monospace",
                  }}
                >
                  {BACKGROUND_TRACKS.map(t => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => setMusicEnabled(v => !v)}
                  style={{
                    minWidth: 70,
                    background: musicEnabled ? "rgba(34,211,238,0.18)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${musicEnabled ? "rgba(34,211,238,0.45)" : "rgba(255,255,255,0.12)"}`,
                    borderRadius: 5,
                    color: musicEnabled ? "#67e8f9" : "#94a3b8",
                    fontSize: 8,
                    cursor: "pointer",
                    fontFamily: "'DM Mono',monospace",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                  }}
                >
                  {musicEnabled ? "Disable" : "Enable"}
                </button>
              </div>

              <div style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 8, color: "#7dd3fc", fontFamily: "'DM Mono',monospace" }}>Volume</span>
                  <span style={{ fontSize: 8, color: "#bae6fd", fontFamily: "'DM Mono',monospace" }}>{Math.round(musicVolume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={musicVolume}
                  onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
                  style={{ width: "100%", accentColor: "#22d3ee", cursor: "pointer" }}
                />
              </div>

              <div style={{ fontSize: 7.5, color: musicPlaybackState === "error" ? "#fca5a5" : "#94a3b8", fontFamily: "'DM Mono',monospace", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {musicPlaybackState === "error" ? "Audio unavailable: add local files under /public/audio" : `Status: ${musicPlaybackState}`}
              </div>
            </div>
          )}

          {/* Quality selector */}
          {showShaders && (
            <div style={{ position: "absolute", right: 62, bottom: 14, display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 7, color: "rgba(232,121,249,0.6)", fontFamily: "monospace", letterSpacing: "0.1em", marginRight: 2 }}>RENDER</span>
              {(["low", "med", "high", "ultra"] as const).map(q => (
                <button key={q} onClick={() => setRenderQuality(q)} style={{
                  padding: "3px 8px", fontSize: 7, fontFamily: "monospace", cursor: "pointer",
                  background: renderQuality===q ? "rgba(232,121,249,0.18)" : "rgba(6,14,14,0.9)",
                  border: `1px solid ${renderQuality===q ? "rgba(232,121,249,0.5)" : "rgba(255,255,255,0.07)"}`,
                  borderRadius: 4, color: renderQuality===q ? "#e879f9" : "#475569",
                  textTransform: "uppercase", letterSpacing: "0.08em",
                }}>
                  {q === "low" ? "PERF" : q === "med" ? "BALANCED" : q === "high" ? "HIGH" : "CINEMA"}
                </button>
              ))}
            </div>
          )}

          {/* HUD */}
          <div style={{ position: "absolute", top: 10, left: 10, display: "flex", flexDirection: "column", gap: 5, pointerEvents: "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: liveEnv ? "rgba(56,189,248,0.12)" : "rgba(71,85,105,0.16)", border: `1px solid ${liveEnv ? "rgba(56,189,248,0.28)" : "rgba(71,85,105,0.28)"}`, borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: liveEnv ? "#7dd3fc" : "#94a3b8" }}>cloud</span>
              <span style={{ fontSize: 8.5, color: liveEnv ? "#bae6fd" : "#cbd5e1", fontFamily: "'DM Mono',monospace" }}>{meteoBadgeLabel}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(16,185,129,0.09)", border: "1px solid rgba(16,185,129,0.24)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#34d399" }}>schedule</span>
              <span style={{ fontSize: 8.5, color: "#a7f3d0", fontFamily: "'DM Mono',monospace" }}>TIME MODE: {timeOfDayMode.toUpperCase()} · ACTIVE: {isNightScene ? "NIGHT" : "DAY"}</span>
            </div>
            {effectiveShowSun && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#f59e0b" }}>wb_sunny</span>
              <span style={{ fontSize: 8.5, color: "#fbbf24", fontFamily: "'DM Mono',monospace" }}>SUN {sunVectorLabel} · {sunHours.toFixed(1)}h/day</span>
            </div>}
            {showSun && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#fcd34d" }}>explore</span>
              <span style={{ fontSize: 8.5, color: "#fde68a", fontFamily: "'DM Mono',monospace" }}>SUN POSITION ({sunDataSourceLabel}): AZ {Math.round(sunAzimuthDeg)}° · EL {sunElevationDeg.toFixed(1)}°</span>
            </div>}
            {showWind && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#60a5fa" }}>air</span>
              <span style={{ fontSize: 8.5, color: "#93c5fd", fontFamily: "'DM Mono',monospace" }}>WIND: Prevailing {windDir}</span>
            </div>}
            {nightLight && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(250,230,50,0.10)", border: "1px solid rgba(250,230,50,0.25)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#fde047" }}>lightbulb</span>
              <span style={{ fontSize: 8.5, color: "#fef08a", fontFamily: "'DM Mono',monospace" }}>Studio Lighting ON</span>
            </div>}
            {effectiveShowMoon && <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.3)", borderRadius: 6 }}>
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
              <span style={{ fontSize: 8.5, color: "#d946ef", fontFamily: "'DM Mono',monospace" }}>PBR Shaders · {renderQuality.toUpperCase()} · RTAO · Bloom · DOF · Grain</span>
            </div>}
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", background: "rgba(13,242,242,0.08)", border: "1px solid rgba(13,242,242,0.24)", borderRadius: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 12, color: "#0df2f2" }}>auto_awesome</span>
              <span style={{ fontSize: 8.5, color: "#a5f3fc", fontFamily: "'DM Mono',monospace" }}>GRAPHICS STYLE: {graphicsStylePreset.replaceAll("-", " ").toUpperCase()} · REALISTIC BIAS {Math.round(effectiveSurroundingsBlend * 100)}%</span>
            </div>
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
