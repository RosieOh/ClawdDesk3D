import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { RoundedBoxGeometry } from 'three-stdlib';
import * as THREE from 'three';
import { mix } from './mix';
import { MAT } from './materials';
import { KEYBOARD_POS } from './layout';

const PITCH = 0.19;
const KEY_Y = 0.15;

interface Key {
  x: number;
  z: number;
  w: number;
  mat: THREE.Material;
}

function buildLayout(): Key[] {
  const keys: Key[] = [];
  const cols = 12;
  const x0 = -((cols - 1) * PITCH) / 2;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < cols; c++) {
      const accent = (r === 0 && c === 0) || (r === 1 && c === cols - 1);
      const dark = c === 0 || c === cols - 1;
      keys.push({ x: x0 + c * PITCH, z: -0.24 + r * PITCH, w: 1, mat: accent ? MAT.orange : dark ? MAT.keycapDark : MAT.keycap });
    }
  }
  // Bottom row: 3 mods, spacebar, 3 mods
  const zB = -0.24 + 3 * PITCH;
  for (const c of [0, 1, 2, 9, 10, 11]) keys.push({ x: x0 + c * PITCH, z: zB, w: 1, mat: MAT.keycapDark });
  keys.push({ x: x0 + 5.5 * PITCH, z: zB, w: 6 * PITCH / 0.165 - 0.15, mat: MAT.keycap });
  return keys;
}

/** Miniature mechanical keyboard whose keycaps clack while generating. */
export function Keyboard() {
  const keys = useMemo(buildLayout, []);
  const geo = useMemo(() => new RoundedBoxGeometry(0.165, 0.09, 0.165, 2, 0.03), []);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const press = useMemo(() => new Float32Array(keys.length), [keys]);
  const acc = useRef(0);
  const ledMat = useRef<THREE.MeshStandardMaterial>(null!);

  useFrame((st, dt) => {
    // Rhythmic typing: bursts synced to a soft beat
    const beat = 0.6 + 0.4 * Math.sin(st.clock.elapsedTime * 9);
    acc.current += (mix.gen * 26 * beat + mix.tool * 2.5 + mix.idle * 0.15) * dt;
    while (acc.current >= 1) {
      acc.current -= 1;
      press[Math.floor(Math.random() * keys.length)] = 1;
    }
    for (let i = 0; i < keys.length; i++) {
      press[i] = Math.max(0, press[i] - dt * 7);
      const m = refs.current[i];
      if (m) m.position.y = KEY_Y - Math.sin(press[i] * Math.PI * 0.5) * 0.05;
    }
    ledMat.current.emissive.copy(mix.color);
    ledMat.current.emissiveIntensity = 0.2 * mix.offline + 1.4 * mix.idle + 3 * mix.gen + 2 * mix.tool;
  });

  return (
    <group position={KEYBOARD_POS as unknown as [number, number, number]} rotation={[0, -0.04, 0]}>
      <RoundedBox args={[2.55, 0.14, 1.05]} radius={0.05} smoothness={4} position={[0, 0.07, 0.04]} material={MAT.bone} castShadow receiveShadow />
      <RoundedBox args={[2.42, 0.05, 0.9]} radius={0.02} position={[0, 0.13, 0.04]} material={MAT.graphite} receiveShadow />
      {/* status LED strip */}
      <mesh position={[0.95, 0.145, -0.43]}>
        <boxGeometry args={[0.38, 0.02, 0.03]} />
        <meshStandardMaterial ref={ledMat} color="#111" toneMapped={false} />
      </mesh>
      {keys.map((k, i) => (
        <mesh
          key={i}
          ref={(m) => (refs.current[i] = m)}
          geometry={geo}
          material={k.mat}
          position={[k.x, KEY_Y, k.z + 0.04]}
          scale={[k.w, 1, 1]}
          castShadow
        />
      ))}
    </group>
  );
}
