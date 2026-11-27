import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox, Text } from '@react-three/drei';
import * as THREE from 'three';
import { mix, stateHex } from './mix';
import { MAT } from './materials';
import { FONT } from './fonts';
import { NAMEPLATE_POS } from './layout';
import { useStore } from '../store';

/** Frosted acrylic stand showing the active project (cwd basename) as a hologram. */
export function Nameplate() {
  const project = useStore((s) => s.project);
  const state = useStore((s) => s.state);
  const tool = useStore((s) => s.tool);
  const hex = stateHex(state, tool);
  const holo = useRef<THREE.Group>(null!);
  const edgeMat = useRef<THREE.MeshStandardMaterial>(null!);

  const fontSize = Math.min(0.2, 2.3 / Math.max(8, project.length));

  useFrame((st) => {
    const t = st.clock.elapsedTime;
    // hologram shimmer
    holo.current.position.y = 0.4 + Math.sin(t * 1.7) * 0.008;
    holo.current.scale.y = 1 + (Math.random() < 0.02 * (1 - mix.offline) ? (Math.random() - 0.5) * 0.15 : 0);
    edgeMat.current.emissive.copy(mix.color);
    edgeMat.current.emissiveIntensity = 0.3 + 2 * (1 - mix.offline);
  });

  return (
    <group position={NAMEPLATE_POS as unknown as [number, number, number]} rotation={[0, Math.PI / 4 - 0.15, 0]}>
      <RoundedBox args={[1.6, 0.12, 0.34]} radius={0.04} position={[0, 0.06, 0]} material={MAT.orange} castShadow receiveShadow />
      <mesh position={[0, 0.125, 0.12]}>
        <boxGeometry args={[1.4, 0.012, 0.025]} />
        <meshStandardMaterial ref={edgeMat} color="#111" toneMapped={false} />
      </mesh>
      <RoundedBox args={[1.5, 0.56, 0.05]} radius={0.02} position={[0, 0.4, 0]} material={MAT.frost} castShadow />
      <group ref={holo} position={[0, 0.4, 0.04]}>
        <Text font={FONT.mono} position={[-0.66, 0.17, 0]} fontSize={0.06} letterSpacing={0.2} anchorX="left" anchorY="middle" color="#ffffff" fillOpacity={0.6}>
          {'PROJECT / CWD'}
        </Text>
        <Text font={FONT.sans} position={[0, -0.03, 0]} fontSize={fontSize} maxWidth={1.36} anchorX="center" anchorY="middle" letterSpacing={0.01} color={hex} outlineWidth={0.004} outlineColor="#000000" outlineOpacity={0.3}>
          {project}
        </Text>
      </group>
    </group>
  );
}
