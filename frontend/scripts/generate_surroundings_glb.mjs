import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

class NodeFileReader {
  constructor() {
    this.result = null;
    this.onload = null;
    this.onloadend = null;
    this.onerror = null;
    this._listeners = { load: [], loadend: [], error: [] };
  }

  addEventListener(type, handler) {
    if (!this._listeners[type]) return;
    this._listeners[type].push(handler);
  }

  removeEventListener(type, handler) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((h) => h !== handler);
  }

  _emit(type, payload) {
    if (type === "load" && typeof this.onload === "function") this.onload(payload);
    if (type === "loadend" && typeof this.onloadend === "function") this.onloadend(payload);
    if (type === "error" && typeof this.onerror === "function") this.onerror(payload);
    for (const handler of this._listeners[type] ?? []) {
      try { handler(payload); } catch {}
    }
  }

  readAsArrayBuffer(blob) {
    Promise.resolve(blob.arrayBuffer())
      .then((ab) => {
        this.result = ab;
        const evt = { target: this };
        this._emit("load", evt);
        this._emit("loadend", evt);
      })
      .catch((error) => {
        this._emit("error", error);
        this._emit("loadend", { target: this, error });
      });
  }

  readAsDataURL(blob) {
    Promise.resolve(blob.arrayBuffer())
      .then((ab) => {
        const type = blob.type && blob.type.length ? blob.type : "application/octet-stream";
        const base64 = Buffer.from(ab).toString("base64");
        this.result = `data:${type};base64,${base64}`;
        const evt = { target: this };
        this._emit("load", evt);
        this._emit("loadend", evt);
      })
      .catch((error) => {
        this._emit("error", error);
        this._emit("loadend", { target: this, error });
      });
  }
}

if (!globalThis.FileReader) {
  globalThis.FileReader = NodeFileReader;
}
const OUT_DIR = path.resolve("public/models/surroundings");
fs.mkdirSync(OUT_DIR, { recursive: true });

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function fbm2(x, y, oct = 5) {
  let v = 0;
  let amp = 0.55;
  let fx = x;
  let fy = y;
  for (let i = 0; i < oct; i++) {
    const n = Math.sin(fx * 12.9898 + fy * 78.233 + i * 17.123) * 43758.5453;
    v += (n - Math.floor(n)) * amp;
    fx *= 2.04;
    fy *= 2.11;
    amp *= 0.52;
  }
  return v;
}

function addTerrain(scene, palette, random) {
  const terrainGeo = new THREE.PlaneGeometry(240, 240, 96, 96);
  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    const d = Math.sqrt(x * x + z * z);
    const basin = Math.max(0, 1 - d / 130);
    const h = (fbm2(x * 0.02, z * 0.02, 6) - 0.5) * 7.5 + (fbm2(x * 0.007, z * 0.007, 4) - 0.5) * 12.0;
    pos.setZ(i, h - basin * 3.2);
  }
  pos.needsUpdate = true;
  terrainGeo.computeVertexNormals();

  const ground = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ color: palette.ground, roughness: 0.9, metalness: 0.02 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.25;
  scene.add(ground);

  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r = 110 + random() * 70;
    const h = 22 + random() * 36;
    const s = 8 + random() * 20;
    const jag = new THREE.IcosahedronGeometry(s * (0.65 + random() * 0.65), 1);
    const p = jag.attributes.position;
    for (let j = 0; j < p.count; j++) {
      const vx = p.getX(j);
      const vy = p.getY(j);
      const vz = p.getZ(j);
      const n = (fbm2(vx * 0.3, vz * 0.3, 3) - 0.5) * 0.35;
      p.setXYZ(j, vx * (1 + n), vy * (1 + n * 0.7), vz * (1 + n));
    }
    p.needsUpdate = true;
    jag.computeVertexNormals();

    const m = new THREE.Mesh(
      jag,
      new THREE.MeshStandardMaterial({ color: palette.mountain, roughness: 0.84, metalness: 0.03 })
    );
    m.position.set(Math.cos(a) * r, h * 0.28 - 1.25, Math.sin(a) * r);
    m.scale.set(1.2, h / 22, 1.2);
    scene.add(m);
  }
}

function addTrees(scene, palette, random, count = 80, sakura = false, blocky = false) {
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2;
    const r = 28 + random() * 76;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const trunkH = 2.4 + random() * 3.2;
    const crownS = 1.4 + random() * 2.1;

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.34, trunkH, blocky ? 6 : 12),
      new THREE.MeshStandardMaterial({ color: palette.trunk, roughness: 0.84, metalness: 0.0 })
    );
    trunk.position.set(x, trunkH * 0.5 - 1.0, z);
    scene.add(trunk);

    const crownGeo = blocky
      ? new THREE.BoxGeometry(crownS, crownS * 0.75, crownS)
      : new THREE.IcosahedronGeometry(crownS * 0.55, 1);
    const crown = new THREE.Mesh(
      crownGeo,
      new THREE.MeshStandardMaterial({ color: sakura ? palette.flower : palette.leaf, roughness: 0.76, metalness: 0.0 })
    );
    crown.position.set(x, trunkH + crownS * 0.22 - 1.0, z);
    scene.add(crown);

    if (!blocky) {
      const crownTop = new THREE.Mesh(
        new THREE.IcosahedronGeometry(crownS * 0.36, 1),
        new THREE.MeshStandardMaterial({ color: sakura ? palette.flowerHi : palette.leafHi, roughness: 0.72, metalness: 0.0 })
      );
      crownTop.position.set(x, trunkH + crownS * 0.6 - 1.0, z);
      scene.add(crownTop);
    }
  }
}

function addProps(scene, palette, random, kind) {
  const n = kind === "minecraft" ? 30 : kind === "sakura" ? 34 : 26;
  for (let i = 0; i < n; i++) {
    const a = random() * Math.PI * 2;
    const r = 22 + random() * 62;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 1.8 + random() * 5.6;
    const w = 1.6 + random() * 4.8;

    const g = kind === "wuthering"
      ? new THREE.CylinderGeometry(w * 0.3, w * 0.85, h * 2.0, 7)
      : kind === "valorant"
        ? new THREE.BoxGeometry(w, h, w * (0.7 + random() * 0.4))
        : new THREE.DodecahedronGeometry(w * 0.45, 0);
    const c = kind === "valorant" ? palette.structure : kind === "wuthering" ? palette.rock : palette.structure;
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: kind === "valorant" ? 0.16 : 0.05 }));
    m.position.set(x, h * 0.5 - 1.0, z);
    scene.add(m);
  }
}

function buildScene(style, part) {
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight(0xffefd6, 1.3);
  key.position.set(24, 36, 16);
  key.target.position.set(0, 0, -1);
  key.add(key.target);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xd7e7ff, 0.4);
  fill.position.set(-18, 22, -14);
  fill.target.position.set(0, 0, -1);
  fill.add(fill.target);
  scene.add(fill);

  const palette = style === "minecraft"
    ? { ground: 0x567a4d, mountain: 0x5c6450, trunk: 0x6d4e31, leaf: 0x4f8150, leafHi: 0x69986a, flower: 0xf3cfd8, flowerHi: 0xf7dfe7, structure: 0x877055, rock: 0x727364 }
    : style === "sakura"
      ? { ground: 0xb89bad, mountain: 0x897587, trunk: 0x6f5a63, leaf: 0x8ea283, leafHi: 0xb2c3a5, flower: 0xe8c4d3, flowerHi: 0xf2dce6, structure: 0xa1899a, rock: 0x7f7380 }
      : style === "valorant"
        ? { ground: 0x9f8b79, mountain: 0x7a6a5e, trunk: 0x62564d, leaf: 0x7f8d77, leafHi: 0x98a589, flower: 0xd1c8bc, flowerHi: 0xe0d9d0, structure: 0xa98f79, rock: 0x81766c }
        : { ground: 0x748093, mountain: 0x5f6979, trunk: 0x4d5a66, leaf: 0x72877e, leafHi: 0x8fa39b, flower: 0xc8cad9, flowerHi: 0xdfe2ed, structure: 0x8090a0, rock: 0x626f7d };

  const seedMap = { minecraft: 177, sakura: 291, valorant: 413, wuthering: 577 };
  const random = rng(seedMap[style] + (part === "props" ? 999 : part === "full" ? 333 : 0));

  addTerrain(scene, palette, random);

  if (part !== "props") {
    addTrees(scene, palette, random, style === "sakura" ? 130 : style === "wuthering" ? 95 : 80, style === "sakura", style === "minecraft");
  }

  if (part !== "terrain") {
    addProps(scene, palette, random, style);
  }

  return scene;
}

function exportGLTF(scene, outFile) {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          reject(new Error("Unexpected binary output while exporting glTF JSON"));
          return;
        }
        fs.writeFileSync(outFile, JSON.stringify(result));
        resolve();
      },
      (err) => reject(err),
      { binary: false, onlyVisible: true, trs: false }
    );
  });
}

async function main() {
  const jobs = [
    { style: "minecraft", part: "terrain", file: "minecraft_terrain.gltf" },
    { style: "minecraft", part: "props", file: "minecraft_props.gltf" },
    { style: "minecraft", part: "full", file: "minecraft.gltf" },
    { style: "sakura", part: "terrain", file: "sakura_terrain.gltf" },
    { style: "sakura", part: "props", file: "sakura_foliage.gltf" },
    { style: "sakura", part: "full", file: "sakura-blooms.gltf" },
    { style: "valorant", part: "terrain", file: "valorant_terrain.gltf" },
    { style: "valorant", part: "props", file: "valorant_props.gltf" },
    { style: "valorant", part: "full", file: "valorant.gltf" },
    { style: "wuthering", part: "terrain", file: "wuthering_terrain.gltf" },
    { style: "wuthering", part: "props", file: "wuthering_props.gltf" },
    { style: "wuthering", part: "full", file: "wuthering-waves.gltf" },
  ];

  for (const job of jobs) {
    const scene = buildScene(job.style, job.part);
    const outFile = path.join(OUT_DIR, job.file);
    await exportGLTF(scene, outFile);
    console.log(`Generated ${outFile}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
