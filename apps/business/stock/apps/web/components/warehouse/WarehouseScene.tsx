'use client';

import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';

function Rack({ x, z, color, active }: { x: number; z: number; color: string; active?: boolean }) {
  return (
    <group position={[x, 1.2, z]}>
      {[0, 1, 2].map((level) => (
        <mesh key={level} position={[0, level * 0.75, 0]}>
          <boxGeometry args={[2.5, 0.16, 0.85]} />
          <meshStandardMaterial color={active ? '#43eaff' : color} emissive={active ? '#0b82ff' : '#000000'} emissiveIntensity={active ? 0.45 : 0.08} />
        </mesh>
      ))}
      {[-1.1, 1.1].map((side) => (
        <mesh key={side} position={[side, 0.75, 0]}>
          <boxGeometry args={[0.12, 1.8, 0.9]} />
          <meshStandardMaterial color="#334155" />
        </mesh>
      ))}
    </group>
  );
}

export function WarehouseScene() {
  return (
    <div className="scene-frame">
      <Canvas shadows dpr={[1, 1.5]}>
        <PerspectiveCamera makeDefault position={[5.4, 5.2, 7.2]} fov={48} />
        <ambientLight intensity={0.7} />
        <directionalLight position={[5, 8, 4]} intensity={1.2} castShadow />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
          <planeGeometry args={[14, 9]} />
          <meshStandardMaterial color="#0b1220" />
        </mesh>
        <gridHelper args={[14, 14, '#1f8bff', '#16324a']} position={[0, 0, 0]} />
        <Rack x={-3.6} z={-1.8} color="#0b82ff" />
        <Rack x={0} z={-1.8} color="#00c98e" active />
        <Rack x={3.6} z={-1.8} color="#0b82ff" />
        <Rack x={-3.6} z={1.8} color="#64748b" />
        <Rack x={0} z={1.8} color="#ffc96e" />
        <Rack x={3.6} z={1.8} color="#22f078" />
        <mesh position={[0, 0.05, 3.55]}>
          <boxGeometry args={[5.2, 0.1, 0.55]} />
          <meshStandardMaterial color="#12243a" emissive="#0b82ff" emissiveIntensity={0.16} />
        </mesh>
        <OrbitControls enablePan={false} minDistance={5} maxDistance={11} />
      </Canvas>
    </div>
  );
}
