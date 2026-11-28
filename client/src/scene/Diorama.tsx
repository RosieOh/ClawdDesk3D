import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { mix } from './mix';
import { MAT } from './materials';
import { DESK_TOP } from './layout';
import { Core } from './Core';
import { Keyboard } from './Keyboard';
import { ToolStation } from './ToolStation';
import { ServerRack } from './ServerRack';
import { Nameplate } from './Nameplate';
import { TokenFountain } from './Particles';
import { Satellites } from './Satellites';
import { Subagents } from './Subagents';

function Mug() {
  return (
    <group position={[-2.35, DESK_TOP, 1.45]} rotation={[0, 0.6, 0]}>
      <mesh material={MAT.bone} position={[0, 0.2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.17, 0.15, 0.4, 32]} />
      </mesh>
      <mesh material={MAT.charcoal} position={[0, 0.39, 0]}>
        <cylinderGeometry args={[0.145, 0.145, 0.02, 32]} />
      </mesh>
      <mesh material={MAT.bone} position={[0.19, 0.21, 0]} castShadow>
        <torusGeometry args={[0.09, 0.03, 12, 24, Math.PI]} />
      </mesh>
      <mesh material={MAT.orange} position={[0, 0.2, 0.152]}>
        <boxGeometry args={[0.12, 0.12, 0.01]} />
      </mesh>
    </group>
  );
}

function Plant() {
  return (
    <group position={[2.55, DESK_TOP, 0.45]}>
      <mesh material={MAT.terracotta2} position={[0, 0.17, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.22, 0.16, 0.34, 24]} />
      </mesh>
      <mesh material={MAT.sage} position={[0, 0.52, 0]} castShadow>
        <icosahedronGeometry args={[0.3, 0]} />
      </mesh>
      <mesh material={MAT.sage} position={[0.12, 0.78, 0.05]} rotation={[0.4, 0.3, 0]} castShadow>
        <icosahedronGeometry args={[0.18, 0]} />
      </mesh>
      <mesh material={MAT.sage} position={[-0.15, 0.7, -0.08]} rotation={[0.2, 1, 0.3]} castShadow>
        <icosahedronGeometry args={[0.15, 0]} />
      </mesh>
    </group>
  );
}

function Notes() {
  return (
    <group position={[-1.0, DESK_TOP, 1.55]} rotation={[0, 0.25, 0]}>
      <RoundedBox args={[0.42, 0.05, 0.42]} radius={0.01} position={[0, 0.025, 0]} material={MAT.orange} castShadow receiveShadow />
      <RoundedBox args={[0.4, 0.02, 0.4]} radius={0.008} position={[0.03, 0.06, -0.02]} rotation={[0, 0.2, 0]} material={MAT.bone} castShadow />
    </group>
  );
}

/** Glowing thrusters under the floating island. */
function Thrusters() {
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#111', toneMapped: false }), []);
  useFrame((st) => {
    mat.emissive.copy(mix.color);
    mat.emissiveIntensity = 0.3 + (1 - mix.offline) * (1.6 + Math.sin(st.clock.elapsedTime * 3) * 0.4) + mix.gen * 1.5;
  });
  const spots: [number, number][] = [
    [-2.1, -1.3],
    [2.1, -1.3],
    [-2.1, 1.3],
    [2.1, 1.3],
  ];
  return (
    <>
      {spots.map(([x, z]) => (
        <group key={`${x}${z}`} position={[x, -0.82, z]}>
          <mesh material={MAT.charcoal}>
            <cylinderGeometry args={[0.24, 0.3, 0.12, 24]} />
          </mesh>
          <mesh material={mat} position={[0, -0.07, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.17, 0.03, 10, 32]} />
          </mesh>
        </group>
      ))}
    </>
  );
}

export function Diorama() {
  const island = useRef<THREE.Group>(null!);

  useFrame((st) => {
    const t = st.clock.elapsedTime;
    const awake = 1 - mix.offline;
    island.current.position.y = Math.sin(t * 0.6) * 0.06 * (0.4 + awake) - 0.08 * mix.offline;
    island.current.rotation.z = Math.sin(t * 0.4) * 0.006 * awake;
    island.current.rotation.x = Math.cos(t * 0.33) * 0.005 * awake;
  });

  return (
    <group ref={island}>
      {/* Island body */}
      <RoundedBox args={[6.4, 0.16, 4.6]} radius={0.07} smoothness={4} position={[0, DESK_TOP - 0.08, 0]} material={MAT.deskTop} receiveShadow castShadow />
      <RoundedBox args={[6.2, 0.5, 4.4]} radius={0.16} smoothness={4} position={[0, -0.13, 0]} material={MAT.deskBase} castShadow receiveShadow />
      <RoundedBox args={[5.3, 0.45, 3.6]} radius={0.2} smoothness={4} position={[0, -0.55, 0]} material={MAT.deskUnder} castShadow />
      {/* front trim stripe, TE style */}
      <mesh material={MAT.charcoal} position={[0, -0.05, 2.205]}>
        <boxGeometry args={[5.6, 0.06, 0.01]} />
      </mesh>
      <mesh material={MAT.orange} position={[2.6, -0.05, 2.21]}>
        <boxGeometry args={[0.4, 0.06, 0.012]} />
      </mesh>

      <Thrusters />
      <Core />
      <TokenFountain />
      <Keyboard />
      <ToolStation />
      <ServerRack />
      <Nameplate />
      <Mug />
      <Plant />
      <Notes />
      <Satellites />
      <Subagents />
    </group>
  );
}
