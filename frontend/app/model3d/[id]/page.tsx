"use client";

import { useRef, useMemo, Suspense, useState, useEffect, Component } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Text, Environment } from "@react-three/drei";
import * as THREE from "three";
import { useEco3DStore } from "@/store/useEco3DStore";

class ThreeErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  constructor(props: any) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return (
      <div style={{ width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",background:"#060e0e" }}>
        <div style={{ textAlign:"center",color:"#0df2f2",fontFamily:"monospace" }}>
          <div style={{ fontSize:32,marginBottom:12 }}>⬡</div>
          <div style={{ fontSize:14,marginBottom:6 }}>3D Engine initializing...</div>
          <div style={{ fontSize:11,color:"#475569" }}>{this.state.error}</div>
        </div>
      </div>
    );
    return this.props.children;
  }
}

const ROOM_COLORS: Record<string, string> = {
  living: "#1a8a8a", kitchen: "#1a7a44", bedroom: "#1a4a8a",
  bathroom: "#5a2a7a", office: "#8a6a0a", garage: "#4a5a5a", utility: "#8a4a1a",
};
const getRoomColor = (type: string) => {
  const key = Object.keys(ROOM_COLORS).find(k => type.toLowerCase().includes(k));
  return key ? ROOM_COLORS[key] : "#1a8a8a";
};

// ── Scene lighting ────────────────────────────────────────────────────────────
function SceneLighting({ direction }: { direction: string }) {
  const posMap: Record<string, [number,number,number]> = {
    N:[0,12,-10],NE:[8,12,-8],E:[12,12,0],SE:[8,12,8],S:[0,12,10],SW:[-8,12,8],W:[-12,12,0],NW:[-8,12,-8],
  };
  const pos = posMap[direction] ?? [8,12,8];
  return (
    <>
      <ambientLight intensity={0.5} color="#d0e8ff" />
      <hemisphereLight args={["#a8d4ff","#1a3030",0.4]} />
      <directionalLight position={pos} intensity={2.2} castShadow color="#fff5e0"
        shadow-mapSize-width={2048} shadow-mapSize-height={2048}
        shadow-camera-near={0.5} shadow-camera-far={80}
        shadow-camera-left={-25} shadow-camera-right={25}
        shadow-camera-top={25} shadow-camera-bottom={-25} />
      <pointLight position={[-10,8,-10]} intensity={0.6} color="#0df2f2" distance={35} />
      <pointLight position={[10,6,10]} intensity={0.35} color="#0a9a9a" distance={28} />
    </>
  );
}

// ── Window component ──────────────────────────────────────────────────────────
function Window({ position, size, normal }: { position: [number,number,number]; size: [number,number]; normal: [number,number,number] }) {
  const [wx, wz] = size;
  const isNS = Math.abs(normal[2]) > 0.5;
  const args: [number,number,number] = isNS ? [wx, wz, 0.05] : [0.05, wz, wx];
  return (
    <group position={position}>
      {/* Frame */}
      <mesh>
        <boxGeometry args={args} />
        <meshStandardMaterial color="#c8d8e0" metalness={0.3} roughness={0.4} />
      </mesh>
      {/* Glass pane */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={isNS ? [wx - 0.08, wz - 0.08, 0.03] : [0.03, wz - 0.08, wx - 0.08]} />
        <meshStandardMaterial color="#88ccee" transparent opacity={0.35} metalness={0.8} roughness={0} />
      </mesh>
    </group>
  );
}

// ── Door component ────────────────────────────────────────────────────────────
function Door({ position, size, isExterior }: { position: [number,number,number]; size: [number,number,number]; isExterior: boolean }) {
  return (
    <mesh position={position} castShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={isExterior ? "#3d2b1a" : "#5a4a3a"} roughness={0.7} metalness={0.1} />
    </mesh>
  );
}

// ── Wall with opening cutouts ─────────────────────────────────────────────────
function Wall({ position, size, color, hasWindow, hasDoor }: {
  position: [number,number,number]; size: [number,number,number];
  color: string; hasWindow?: boolean; hasDoor?: boolean;
}) {
  const [wx, wy, wz] = size;
  const isNS = wz < wx; // longer in X = north/south facing wall

  return (
    <group position={position}>
      {hasDoor ? (
        // Wall with door: two sections left and right of door gap
        <>
          {isNS ? (
            <>
              <mesh castShadow receiveShadow position={[-(wx * 0.3), 0, 0]}>
                <boxGeometry args={[wx * 0.35, wy, wz]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
              <mesh castShadow receiveShadow position={[wx * 0.3, 0, 0]}>
                <boxGeometry args={[wx * 0.35, wy, wz]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
              {/* Top section above door */}
              <mesh castShadow receiveShadow position={[0, wy * 0.37, 0]}>
                <boxGeometry args={[wx * 0.3, wy * 0.26, wz]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
            </>
          ) : (
            <>
              <mesh castShadow receiveShadow position={[0, 0, -(wz * 0.3)]}>
                <boxGeometry args={[wx, wy, wz * 0.35]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
              <mesh castShadow receiveShadow position={[0, 0, wz * 0.3]}>
                <boxGeometry args={[wx, wy, wz * 0.35]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
              <mesh castShadow receiveShadow position={[0, wy * 0.37, 0]}>
                <boxGeometry args={[wx, wy * 0.26, wz * 0.3]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
            </>
          )}
          {/* Door panel */}
          <Door
            position={[0, -wy * 0.07, 0]}
            size={isNS ? [wx * 0.28, wy * 0.74, wz + 0.02] : [wx + 0.02, wy * 0.74, wz * 0.28]}
            isExterior={false}
          />
        </>
      ) : hasWindow ? (
        <>
          {/* Wall with window: below, left, right, above window */}
          <mesh castShadow receiveShadow position={[0, -wy * 0.3, 0]}>
            <boxGeometry args={[wx, wy * 0.3, wz]} />
            <meshStandardMaterial color={color} roughness={0.85} />
          </mesh>
          <mesh castShadow receiveShadow position={[0, wy * 0.35, 0]}>
            <boxGeometry args={[wx, wy * 0.3, wz]} />
            <meshStandardMaterial color={color} roughness={0.85} />
          </mesh>
          {isNS ? (
            <>
              <mesh castShadow receiveShadow position={[-(wx * 0.38), 0, 0]}>
                <boxGeometry args={[wx * 0.24, wy * 0.4, wz]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
              <mesh castShadow receiveShadow position={[wx * 0.38, 0, 0]}>
                <boxGeometry args={[wx * 0.24, wy * 0.4, wz]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
            </>
          ) : (
            <>
              <mesh castShadow receiveShadow position={[0, 0, -(wz * 0.38)]}>
                <boxGeometry args={[wx, wy * 0.4, wz * 0.24]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
              <mesh castShadow receiveShadow position={[0, 0, wz * 0.38]}>
                <boxGeometry args={[wx, wy * 0.4, wz * 0.24]} />
                <meshStandardMaterial color={color} roughness={0.85} />
              </mesh>
            </>
          )}
          {/* Window glass */}
          <Window
            position={[0, 0, 0]}
            size={isNS ? [wx * 0.48, wy * 0.38] : [wz * 0.48, wy * 0.38]}
            normal={isNS ? [0,0,1] : [1,0,0]}
          />
        </>
      ) : (
        <mesh castShadow receiveShadow>
          <boxGeometry args={size} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      )}
    </group>
  );
}

// ── Room with full walls, floor, ceiling, furniture ──────────────────────────
function Room3D({ room, idx, totalRooms }: { room: any; idx: number; totalRooms: number }) {
  const w = room.width ?? 4;
  const d = room.height ?? 4;  // depth in plan = Z in 3D
  const floorH = 3.0;
  const wallT = 0.22;
  const floorY = ((room.floor ?? 1) - 1) * floorH;

  const cx = (room.x ?? 0) + w / 2 - 8;
  const cz = (room.y ?? 0) + d / 2 - 8;
  const color = getRoomColor(room.type ?? "living");
  const roomType = room.type?.toLowerCase() ?? "living";

  // Is this an exterior room? (simplified: use index)
  const isEdge = true;

  return (
    <group position={[cx, floorY, cz]}>
      {/* Floor slab */}
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[w - wallT, 0.12, d - wallT]} />
        <meshStandardMaterial
          color={roomType.includes("bathroom") ? "#2a3a3a" : roomType.includes("kitchen") ? "#1e2e2e" : "#152525"}
          roughness={0.9}
        />
      </mesh>
      {/* Ceiling */}
      <mesh position={[0, floorH - 0.06, 0]}>
        <boxGeometry args={[w - wallT, 0.1, d - wallT]} />
        <meshStandardMaterial color="#e8ecec" roughness={0.8} />
      </mesh>

      {/* North wall (-Z) */}
      <Wall position={[0, floorH/2, -d/2]} size={[w, floorH, wallT]} color="#d4dde0" hasWindow={!roomType.includes("bathroom")} />
      {/* South wall (+Z) */}
      <Wall position={[0, floorH/2, d/2]} size={[w, floorH, wallT]} color="#d4dde0" hasDoor={idx % 3 !== 2} hasWindow={idx % 3 === 2 && !roomType.includes("bathroom")} />
      {/* West wall (-X) */}
      <Wall position={[-w/2, floorH/2, 0]} size={[wallT, floorH, d]} color="#ccd6da" hasWindow={w > 4.5 && !roomType.includes("bathroom")} />
      {/* East wall (+X) */}
      <Wall position={[w/2, floorH/2, 0]} size={[wallT, floorH, d]} color="#ccd6da" hasDoor={idx % 3 === 2} />

      {/* Room label floating above */}
      <Text
        position={[0, floorH * 0.5, 0]}
        color={color}
        fontSize={Math.min(0.35, w * 0.09)}
        font={undefined}
        anchorX="center"
        anchorY="middle"
      >
        {(room.type ?? "room").toUpperCase().replace(/_/g, " ")}
      </Text>

      {/* Furniture */}
      <RoomFurniture type={roomType} w={w} d={d} floorY={0.15} color={color} />

      {/* Glow floor tint */}
      <mesh position={[0, 0.14, 0]} rotation={[-Math.PI/2, 0, 0]}>
        <planeGeometry args={[w - wallT - 0.3, d - wallT - 0.3]} />
        <meshStandardMaterial color={color} transparent opacity={0.06} roughness={1} />
      </mesh>
    </group>
  );
}

// ── Furniture for each room type ─────────────────────────────────────────────
function RoomFurniture({ type, w, d, floorY, color }: { type: string; w: number; d: number; floorY: number; color: string }) {
  const mats = useMemo(() => ({
    wood:  new THREE.MeshStandardMaterial({ color: "#5c3d1e", roughness: 0.8 }),
    light: new THREE.MeshStandardMaterial({ color: "#d4c8b0", roughness: 0.7 }),
    dark:  new THREE.MeshStandardMaterial({ color: "#2a2a3a", roughness: 0.6 }),
    metal: new THREE.MeshStandardMaterial({ color: "#aab0b8", roughness: 0.3, metalness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: "#88bbdd", transparent: true, opacity: 0.5, roughness: 0 }),
    fabric:new THREE.MeshStandardMaterial({ color: "#3a5a6a", roughness: 0.95 }),
    white: new THREE.MeshStandardMaterial({ color: "#e8e8e0", roughness: 0.6 }),
  }), []);

  const y = floorY;
  const hw = w / 2 - 0.5;
  const hd = d / 2 - 0.5;

  if (type.includes("living")) return (
    <group>
      {/* Sofa */}
      <mesh position={[0, y + 0.25, hd - 0.8]} material={mats.fabric} castShadow>
        <boxGeometry args={[Math.min(w - 1.2, 3), 0.5, 0.9]} />
      </mesh>
      <mesh position={[0, y + 0.55, hd - 0.35]} material={mats.fabric} castShadow>
        <boxGeometry args={[Math.min(w - 1.2, 3), 0.6, 0.2]} />
      </mesh>
      {/* Coffee table */}
      <mesh position={[0, y + 0.25, 0.5]} material={mats.glass} castShadow>
        <boxGeometry args={[1.0, 0.05, 0.6]} />
      </mesh>
      <mesh position={[0, y + 0.12, 0.5]} material={mats.metal}>
        <boxGeometry args={[0.02, 0.28, 0.02]} />
      </mesh>
      {/* TV unit */}
      <mesh position={[0, y + 0.2, -hd + 0.5]} material={mats.dark} castShadow>
        <boxGeometry args={[Math.min(w - 1.5, 2.5), 0.4, 0.35]} />
      </mesh>
      <mesh position={[0, y + 0.42, -hd + 0.5]} material={mats.dark}>
        <boxGeometry args={[Math.min(w - 2, 2), 0.3, 0.05]} />
      </mesh>
      {/* Plant */}
      <mesh position={[hw - 0.3, y + 0.5, -hd + 0.5]} material={mats.metal} castShadow>
        <cylinderGeometry args={[0.1, 0.12, 0.3, 8]} />
      </mesh>
      <mesh position={[hw - 0.3, y + 0.8, -hd + 0.5]} castShadow>
        <sphereGeometry args={[0.22, 8, 8]} />
        <meshStandardMaterial color="#2a7a2a" roughness={0.9} />
      </mesh>
    </group>
  );

  if (type.includes("bedroom")) return (
    <group>
      {/* Bed frame */}
      <mesh position={[0, y + 0.25, 0.4]} material={mats.wood} castShadow>
        <boxGeometry args={[Math.min(w - 1.2, 2.0), 0.3, Math.min(d - 1.5, 2.2)]} />
      </mesh>
      {/* Mattress */}
      <mesh position={[0, y + 0.5, 0.4]} material={mats.white} castShadow>
        <boxGeometry args={[Math.min(w - 1.4, 1.8), 0.22, Math.min(d - 1.8, 2.0)]} />
      </mesh>
      {/* Pillow x2 */}
      {[-0.35, 0.35].map((px, pi) => (
        <mesh key={pi} position={[px, y + 0.64, -0.2]} material={mats.white} castShadow>
          <boxGeometry args={[0.55, 0.1, 0.38]} />
        </mesh>
      ))}
      {/* Headboard */}
      <mesh position={[0, y + 0.75, -0.55]} material={mats.wood} castShadow>
        <boxGeometry args={[Math.min(w - 1.2, 2.0), 0.9, 0.1]} />
      </mesh>
      {/* Bedside tables */}
      {[-1.1, 1.1].map((px, pi) => (
        <group key={pi}>
          <mesh position={[px, y + 0.28, 0.2]} material={mats.wood} castShadow>
            <boxGeometry args={[0.5, 0.45, 0.45]} />
          </mesh>
          <mesh position={[px, y + 0.54, 0.2]} material={mats.metal} castShadow>
            <cylinderGeometry args={[0.06, 0.06, 0.06, 8]} />
          </mesh>
        </group>
      ))}
      {/* Wardrobe */}
      <mesh position={[-hw + 0.4, y + 1.0, hd - 0.4]} material={mats.light} castShadow>
        <boxGeometry args={[0.65, 2.1, 0.55]} />
      </mesh>
    </group>
  );

  if (type.includes("kitchen")) return (
    <group>
      {/* Base cabinets along -Z wall */}
      <mesh position={[0, y + 0.45, -hd + 0.3]} material={mats.light} castShadow>
        <boxGeometry args={[w - 0.5, 0.9, 0.6]} />
      </mesh>
      {/* Counter top */}
      <mesh position={[0, y + 0.92, -hd + 0.3]} material={mats.metal} castShadow>
        <boxGeometry args={[w - 0.5, 0.04, 0.6]} />
      </mesh>
      {/* Wall cabinets */}
      <mesh position={[0, y + 1.8, -hd + 0.15]} material={mats.light} castShadow>
        <boxGeometry args={[w - 0.5, 0.7, 0.32]} />
      </mesh>
      {/* Sink */}
      <mesh position={[hw - 0.6, y + 0.96, -hd + 0.28]} material={mats.metal} castShadow>
        <boxGeometry args={[0.55, 0.04, 0.42]} />
      </mesh>
      {/* Stove */}
      <mesh position={[-0.3, y + 0.96, -hd + 0.28]} material={mats.dark} castShadow>
        <boxGeometry args={[0.6, 0.04, 0.55]} />
      </mesh>
      {[-0.15, 0.15].map((px, pi) => (
        <mesh key={pi} position={[-0.3 + px, y + 1.0, -hd + 0.26]} castShadow>
          <cylinderGeometry args={[0.08, 0.08, 0.02, 10]} />
          <meshStandardMaterial color="#cc3300" emissive="#cc3300" emissiveIntensity={0.3} />
        </mesh>
      ))}
      {/* Island / dining */}
      {d > 4 && <mesh position={[0, y + 0.9, 0.8]} material={mats.light} castShadow>
        <boxGeometry args={[1.2, 1.0, 0.65]} />
      </mesh>}
    </group>
  );

  if (type.includes("bathroom")) return (
    <group>
      {/* Bathtub */}
      <mesh position={[-hw + 0.55, y + 0.28, -hd + 0.65]} material={mats.white} castShadow>
        <boxGeometry args={[0.75, 0.55, 1.4]} />
      </mesh>
      <mesh position={[-hw + 0.55, y + 0.52, -hd + 0.65]} material={mats.glass} castShadow>
        <boxGeometry args={[0.65, 0.06, 1.3]} />
      </mesh>
      {/* Toilet */}
      <mesh position={[hw - 0.4, y + 0.3, hd - 0.6]} material={mats.white} castShadow>
        <boxGeometry args={[0.42, 0.55, 0.55]} />
      </mesh>
      <mesh position={[hw - 0.4, y + 0.58, hd - 0.85]} material={mats.white} castShadow>
        <boxGeometry args={[0.42, 0.12, 0.18]} />
      </mesh>
      {/* Vanity */}
      <mesh position={[-hw + 0.4, y + 0.4, hd - 0.4]} material={mats.light} castShadow>
        <boxGeometry args={[0.65, 0.8, 0.45]} />
      </mesh>
      <mesh position={[-hw + 0.4, y + 0.82, hd - 0.4]} material={mats.metal} castShadow>
        <boxGeometry args={[0.55, 0.04, 0.38]} />
      </mesh>
    </group>
  );

  if (type.includes("office")) return (
    <group>
      <mesh position={[0, y + 0.38, -hd + 0.45]} material={mats.light} castShadow>
        <boxGeometry args={[Math.min(w-1, 1.6), 0.04, 0.7]} />
      </mesh>
      <mesh position={[0, y + 0.1, -hd + 0.45]} material={mats.wood} castShadow>
        <boxGeometry args={[1.5, 0.2, 0.65]} />
      </mesh>
      {/* Chair */}
      <mesh position={[0, y + 0.22, 0]} material={mats.dark} castShadow>
        <cylinderGeometry args={[0.22, 0.22, 0.44, 8]} />
      </mesh>
      <mesh position={[0, y + 0.5, -0.06]} material={mats.dark} castShadow>
        <boxGeometry args={[0.44, 0.5, 0.07]} />
      </mesh>
    </group>
  );

  return null;
}

// ── Gabled roof ───────────────────────────────────────────────────────────────
function GabledRoof({ minX, maxX, minZ, maxZ }: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  const floorH = 3.0;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const bw = maxX - minX + 0.5;
  const bd = maxZ - minZ + 0.5;
  const roofH = 2.2;
  const roofY = floorH + roofH / 2;

  // Roof as pyramid/gable shape using custom geometry
  const shape = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const hw = bw / 2; const hd = bd / 2;
    // Gable: ridge runs along Z
    const vertices = new Float32Array([
      // Front face (-Z)
      -hw, 0, -hd, hw, 0, -hd, 0, roofH, 0,
      // Back face (+Z)
      -hw, 0, hd, 0, roofH, 0, hw, 0, hd,
      // Left slope
      -hw, 0, -hd, 0, roofH, 0, -hw, 0, hd,
      // Right slope
      hw, 0, -hd, hw, 0, hd, 0, roofH, 0,
      // Bottom
      -hw, 0, -hd, -hw, 0, hd, hw, 0, hd,
      -hw, 0, -hd, hw, 0, hd, hw, 0, -hd,
    ]);
    geo.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geo.computeVertexNormals();
    return geo;
  }, [bw, bd, roofH]);

  return (
    <group position={[cx, floorH + 0.02, cz]}>
      <mesh geometry={shape} castShadow receiveShadow>
        <meshStandardMaterial color="#8a5a3a" roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
      {/* Eaves */}
      <mesh position={[0, -0.1, 0]} receiveShadow>
        <boxGeometry args={[bw + 0.6, 0.18, bd + 0.6]} />
        <meshStandardMaterial color="#b87a50" roughness={0.75} />
      </mesh>
    </group>
  );
}

// ── Ground / plot ─────────────────────────────────────────────────────────────
function Ground() {
  return (
    <>
      {/* Lawn */}
      <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#0d2010" roughness={0.95} />
      </mesh>
      {/* Plot boundary (lighter) */}
      <mesh rotation={[-Math.PI/2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[22, 22]} />
        <meshStandardMaterial color="#122218" roughness={0.95} />
      </mesh>
      {/* Grid lines */}
      <gridHelper args={[60, 60, "#0a2020", "#0a2020"]} position={[0, 0, 0]} />
    </>
  );
}

// ── Main building scene ───────────────────────────────────────────────────────
function BuildingScene({ rooms, windDir }: { rooms: any[]; windDir: string }) {
  const groupRef = useRef<THREE.Group>(null);
  const [autoRotate, setAutoRotate] = useState(true);

  useFrame((_, delta) => {
    if (groupRef.current && autoRotate) {
      groupRef.current.rotation.y += delta * 0.08;
    }
  });

  const floor1 = rooms.filter(r => (r.floor ?? 1) === 1);
  if (floor1.length === 0) return null;

  const minX = Math.min(...floor1.map(r => r.x ?? 0)) - 8;
  const maxX = Math.max(...floor1.map(r => (r.x ?? 0) + (r.width ?? 4))) - 8;
  const minZ = Math.min(...floor1.map(r => r.y ?? 0)) - 8;
  const maxZ = Math.max(...floor1.map(r => (r.y ?? 0) + (r.height ?? 4))) - 8;

  return (
    <group ref={groupRef}>
      {rooms.map((room, idx) => (
        <Room3D key={idx} room={room} idx={idx} totalRooms={rooms.length} />
      ))}
      <GabledRoof minX={minX} maxX={maxX} minZ={minZ} maxZ={maxZ} />
      <Ground />
    </group>
  );
}

// ── Room info tooltip ─────────────────────────────────────────────────────────
function RoomLegend({ rooms }: { rooms: any[] }) {
  const counts: Record<string, number> = {};
  rooms.forEach(r => { const k = (r.type ?? "room").toLowerCase(); counts[k] = (counts[k] ?? 0) + 1; });
  const palette: Record<string, string> = {
    living: "#1a8a8a", bedroom: "#1a4a8a", kitchen: "#1a7a44",
    bathroom: "#5a2a7a", office: "#8a6a0a", garage: "#4a5a5a", utility: "#8a4a1a",
  };
  return (
    <div style={{ position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 12, padding: "8px 16px", background: "rgba(6,14,14,0.9)", borderRadius: 8, border: "1px solid rgba(13,242,242,0.1)" }}>
      <div style={{ color: "rgba(13,242,242,0.4)", fontSize: 9, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: "0.12em", alignSelf: "center" }}>ROOM LEGEND</div>
      {Object.entries(counts).map(([type, count]) => (
        <div key={type} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: palette[type] ?? "#0df2f2", display: "inline-block" }} />
          <span style={{ color: "#94a3b8", fontSize: 10, fontFamily: "monospace" }}>{type.charAt(0).toUpperCase() + type.slice(1)}{count > 1 ? ` ×${count}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

export default function Model3DPage() {
  const params = useParams();
  const plotId = params.id as string;

  const { floorPlan, analysis } = useEco3DStore();
  const rooms = floorPlan?.layout ?? [];
  const windDir = analysis?.environmental?.wind_direction ?? "NW";
  const sunDir = analysis?.environmental?.wind_direction ?? "S";

  const [showWind, setShowWind] = useState(false);
  const [showSun, setShowSun] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showDust, setShowDust] = useState(false);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let last = performance.now(); let frames = 0;
    const id = setInterval(() => {
      const now = performance.now(); frames++;
      if (now - last > 1000) { setFps(Math.round(frames * 1000 / (now - last))); frames = 0; last = now; }
    }, 100);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      <div style={{ width:"100vw",height:"100vh",background:"#060e0e",display:"flex",flexDirection:"column",fontFamily:"'Space Grotesk',sans-serif",overflow:"hidden" }}>

        {/* Nav */}
        <header style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 24px",background:"rgba(6,12,12,0.98)",borderBottom:"1px solid rgba(255,255,255,0.05)",flexShrink:0 }}>
          <Link href="/" style={{ display:"flex",alignItems:"center",gap:10,textDecoration:"none" }}>
            <span className="material-symbols-outlined" style={{ color:"#0df2f2",fontSize:22 }}>deployed_code</span>
            <div><div style={{ color:"white",fontWeight:700,fontSize:15 }}>ECO-3D <span style={{ color:"rgba(13,242,242,0.5)",fontWeight:300 }}>Studio</span></div>
              <div style={{ fontSize:9,color:"#475569",textTransform:"uppercase",letterSpacing:"0.15em" }}>AI GENERATIVE ARCHITECTURE</div></div>
          </Link>
          <nav style={{ display:"flex",gap:4 }}>
            {[
              { l:"Blueprint Generator", h:`/analysis/${plotId}` },
              { l:"Environmental Data", h:`/environment/${plotId}` },
              { l:"3D Model", h:`/model3d/${plotId}`, a:true },
              { l:"Export", h:`/report/${plotId}` },
            ].map(item => (
              <Link key={item.l} href={item.h} style={{ padding:"8px 16px",fontSize:12,fontWeight:500,textDecoration:"none",color:(item as any).a?"#0df2f2":"#64748b",borderBottom:(item as any).a?"2px solid #0df2f2":"2px solid transparent",transition:"all 0.2s" }}>
                {item.l}
              </Link>
            ))}
          </nav>
          <div style={{ display:"flex",gap:10 }}>
            <button style={{ display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:"rgba(13,242,242,0.06)",border:"1px solid rgba(13,242,242,0.15)",borderRadius:8,color:"#0df2f2",fontSize:11,fontWeight:700,cursor:"pointer" }}>
              <span className="material-symbols-outlined" style={{ fontSize:14 }}>upload</span>IMPORT BIM
            </button>
            <button style={{ display:"flex",alignItems:"center",gap:6,padding:"7px 14px",background:"#0df2f2",borderRadius:8,color:"#060e0e",fontSize:11,fontWeight:700,cursor:"pointer",border:"none" }}>
              <span className="material-symbols-outlined" style={{ fontSize:14 }}>download</span>EXPORT BIM
            </button>
          </div>
        </header>

        <div style={{ display:"flex",flex:1,overflow:"hidden" }}>
          {/* Left info panel */}
          <div style={{ width:140,flexShrink:0,background:"rgba(6,10,10,0.98)",padding:16,display:"flex",flexDirection:"column",gap:14,borderRight:"1px solid rgba(255,255,255,0.05)" }}>
            {[
              { l:"Sunlight Direction", v:`${windDir} — ${analysis?.environmental?.sun_exposure_hours?.toFixed(1) ?? "8.2"}h/day` },
              { l:"Wind Direction", v:`Prevailing ${windDir}` },
              { l:"Floor Plan", v:`${rooms.filter(r=>(r.floor??1)===1).length} Rooms • ${floorPlan?.total_area?.toFixed(0) ?? "—"}m²` },
            ].map(({ l, v }) => (
              <div key={l} style={{ background:"rgba(13,242,242,0.04)",border:"1px solid rgba(13,242,242,0.1)",borderRadius:8,padding:"10px 12px" }}>
                <div style={{ fontSize:9,color:"rgba(13,242,242,0.5)",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:4 }}>{l}</div>
                <div style={{ fontSize:12,color:"white",fontWeight:600,lineHeight:1.4 }}>{v}</div>
              </div>
            ))}
            <div style={{ marginTop:"auto",background:"rgba(13,242,242,0.04)",border:"1px solid rgba(13,242,242,0.1)",borderRadius:8,padding:"10px 12px" }}>
              <div style={{ fontSize:9,color:"rgba(13,242,242,0.5)",textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:4 }}>Rendering Engine</div>
              <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:4 }}>
                <span style={{ width:7,height:7,borderRadius:"50%",background:"#0df2f2",flexShrink:0 }} />
                <span style={{ fontSize:11,color:"white",fontWeight:600 }}>Three.js WebGL</span>
              </div>
              <div style={{ fontSize:10,color:"#64748b" }}>{fps} FPS</div>
              <div style={{ fontSize:10,color:"#64748b",marginTop:2 }}>{rooms.length} rooms • {(rooms.length * 4).toFixed(0)}k polys</div>
            </div>
          </div>

          {/* 3D Viewport */}
          <div style={{ flex:1,position:"relative" }}>
            <ThreeErrorBoundary>
              <Canvas
                shadows
                camera={{ position: [14, 10, 14], fov: 45, near: 0.1, far: 200 }}
                style={{ background: "linear-gradient(180deg,#0a1a1a 0%,#060e0e 100%)" }}
                gl={{ antialias: true, alpha: false }}
              >
                <Suspense fallback={null}>
                  <SceneLighting direction={windDir} />
                  {showGrid && <gridHelper args={[40, 40, "#0a2828", "#091a1a"]} />}
                  <BuildingScene rooms={rooms} windDir={windDir} />
                  <OrbitControls
                    enablePan={true} enableZoom={true} enableRotate={true}
                    minPolarAngle={0.1} maxPolarAngle={Math.PI / 2.1}
                    minDistance={4} maxDistance={60}
                    autoRotate={false}
                  />
                </Suspense>
              </Canvas>
            </ThreeErrorBoundary>

            {/* Right toolbar */}
            <div style={{ position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",display:"flex",flexDirection:"column",gap:6 }}>
              {[
                { l:"COMPASS", i:"explore" },
                { l:"WIND", i:"air", active: showWind, toggle: ()=>setShowWind(!showWind) },
                { l:"SUN", i:"wb_sunny", active: showSun, toggle: ()=>setShowSun(!showSun) },
                { l:"GRID", i:"grid_on", active: showGrid, toggle: ()=>setShowGrid(!showGrid) },
                { l:"DUST", i:"blur_on", active: showDust, toggle: ()=>setShowDust(!showDust) },
              ].map(({ l, i, active, toggle }) => (
                <button key={l} onClick={toggle} style={{ width:42,height:42,background:active?"rgba(13,242,242,0.15)":"rgba(6,14,14,0.9)",border:`1px solid ${active?"rgba(13,242,242,0.35)":"rgba(255,255,255,0.06)"}`,borderRadius:8,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,cursor:"pointer",transition:"all 0.2s" }}>
                  <span className="material-symbols-outlined" style={{ fontSize:16,color:active?"#0df2f2":"#475569" }}>{i}</span>
                  <span style={{ fontSize:6,color:active?"#0df2f2":"#334155",fontFamily:"monospace",letterSpacing:"0.06em" }}>{l}</span>
                </button>
              ))}
            </div>

            {/* Compass */}
            <div style={{ position:"absolute",top:12,right:68,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center" }}>
              <svg width="32" height="32">
                <circle cx="16" cy="16" r="14" fill="rgba(6,14,14,0.9)" stroke="rgba(13,242,242,0.2)" strokeWidth="1" />
                <polygon points="16,4 20,16 16,14 12,16" fill="#0df2f2" />
                <polygon points="16,28 12,16 16,18 20,16" fill="#334155" />
                <text x="16" y="10" textAnchor="middle" fill="#0df2f2" fontSize="6" fontFamily="monospace">N</text>
              </svg>
            </div>

            {/* Controls hint */}
            <div style={{ position:"absolute",bottom:8,right:68,fontSize:10,fontFamily:"monospace",color:"#334155",textAlign:"right" }}>
              Drag to orbit • Scroll to zoom<br/>Right-drag to pan
            </div>

            {/* Room legend */}
            <RoomLegend rooms={rooms} />
          </div>
        </div>
      </div>
    </>
  );
}
