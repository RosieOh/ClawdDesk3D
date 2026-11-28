import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mix } from './mix';
import { CORE_POS } from './layout';
import { useStore } from '../store';

const MAX = 8;

/** Small sparks orbiting close to the core: one per subagent the shown session is running. */
export function Subagents() {
  const count = useStore((s) => Math.min(MAX, s.primary?.subagents ?? 0));
  const group = useRef<THREE.Group>(null!);
  const mats = useRef<THREE.MeshBasicMaterial[]>([]);

  useFrame((st) => {
    const t = st.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      const a = t * (1.6 + i * 0.07) + (i / Math.max(1, count)) * Math.PI * 2;
      const r = 0.78 + (i % 2) * 0.12;
      const tilt = 0.5 + (i % 3) * 0.35;
      child.position.set(Math.cos(a) * r, mix.coreY - CORE_POS[1] + Math.sin(a * 1.3) * r * tilt * 0.35, Math.sin(a) * r);
    });
    for (const m of mats.current) if (m) m.color.copy(mix.color).multiplyScalar(2.5);
  });

  return (
    <group ref={group} position={CORE_POS as unknown as [number, number, number]}>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i}>
          <icosahedronGeometry args={[0.045, 0]} />
          <meshBasicMaterial ref={(m) => void (m && (mats.current[i] = m))} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
