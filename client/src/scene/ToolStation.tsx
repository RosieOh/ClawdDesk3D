import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, RoundedBox, Text } from '@react-three/drei';
import * as THREE from 'three';
import { mix, toolHex } from './mix';
import { MAT } from './materials';
import { TOOL_POS } from './layout';
import { useStore } from '../store';

const CUBE_Y = 1.35;

/** Holographic code cube + projector laser that scans it while a tool runs. */
export function ToolStation() {
  const tool = useStore((s) => s.tool);
  const lastTool = useRef('Tool');
  if (tool) lastTool.current = tool;
  const label = tool ?? lastTool.current;
  const beamHex = toolHex(label);

  const cube = useRef<THREE.Group>(null!);
  const beam = useRef<THREE.Mesh>(null!);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null!);
  const scan = useRef<THREE.Mesh>(null!);
  const scanMat = useRef<THREE.MeshBasicMaterial>(null!);
  const codeMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0b0b0b', toneMapped: false }), []);
  const lensMat = useRef<THREE.MeshStandardMaterial>(null!);
  const badge = useRef<THREE.Group>(null!);
  const beamColor = useMemo(() => new THREE.Color(), []);

  // Fake "lines of code" floating inside the cube
  const lines = useMemo(() => {
    const out: { x: number; y: number; z: number; w: number }[] = [];
    for (let layer = 0; layer < 3; layer++) {
      for (let i = 0; i < 7; i++) {
        const indent = [0, 0.06, 0.12, 0.06, 0.12, 0.18, 0][i];
        const w = 0.12 + ((i * 7 + layer * 3) % 5) * 0.05;
        out.push({ x: -0.2 + indent + w / 2, y: 0.21 - i * 0.07, z: -0.14 + layer * 0.14, w });
      }
    }
    return out;
  }, []);

  useFrame((st, dt) => {
    const t = st.clock.elapsedTime;
    const { tool: k, idle, gen, offline } = mix;
    const awake = 1 - offline;
    beamColor.set(beamHex);

    cube.current.rotation.y += dt * (0.25 * awake + 1.4 * k);
    cube.current.rotation.x = Math.sin(t * 0.6) * 0.15 * awake;
    cube.current.position.y = CUBE_Y - 0.5 * offline + Math.sin(t * 1.1 + 1) * 0.06 * awake;

    codeMat.emissive.copy(beamColor);
    codeMat.emissiveIntensity = 0.05 + 0.5 * idle + 0.8 * gen + (2.6 + Math.sin(t * 14) * 0.8) * k;

    beam.current.scale.set(k, 1, k);
    beam.current.visible = k > 0.01;
    beamMat.current.color.copy(beamColor).multiplyScalar(1.6);
    beamMat.current.opacity = 0.22 * k * (0.85 + Math.sin(t * 30) * 0.15);

    const sy = cube.current.position.y + Math.sin(t * 4.2) * 0.32;
    scan.current.position.y = sy;
    scan.current.visible = k > 0.01;
    scan.current.scale.setScalar(0.4 + 0.6 * k);
    scanMat.current.color.copy(beamColor).multiplyScalar(4);
    scanMat.current.opacity = 0.9 * k;

    lensMat.current.emissive.copy(beamColor);
    lensMat.current.emissiveIntensity = 0.1 + 4 * k + 0.4 * idle;

    const pop = THREE.MathUtils.clamp(k * 1.15, 0, 1);
    badge.current.scale.setScalar(0.001 + pop);
    badge.current.position.y = cube.current.position.y + 0.75 + Math.sin(t * 2) * 0.04;
  });

  return (
    <group position={TOOL_POS as unknown as [number, number, number]}>
      {/* Projector */}
      <mesh material={MAT.charcoal} position={[0, 0.07, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.32, 0.36, 0.14, 32]} />
      </mesh>
      <mesh material={MAT.orange} position={[0, 0.16, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.2, 0.06, 32]} />
      </mesh>
      <mesh position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.07, 0.07, 0.03, 24]} />
        <meshStandardMaterial ref={lensMat} color="#111" toneMapped={false} />
      </mesh>

      {/* Laser cone from lens to cube */}
      <mesh ref={beam} position={[0, 0.2 + (CUBE_Y - 0.2) / 2, 0]}>
        <cylinderGeometry args={[0.42, 0.05, CUBE_Y - 0.2, 32, 1, true]} />
        <meshBasicMaterial ref={beamMat} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>

      {/* Scanning plane */}
      <mesh ref={scan} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.02, 0.62, 4, 1]} />
        <meshBasicMaterial ref={scanMat} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>

      {/* Holographic code cube */}
      <group ref={cube} position={[0, CUBE_Y, 0]}>
        <RoundedBox args={[0.72, 0.72, 0.72]} radius={0.08} smoothness={4} material={MAT.frost} castShadow />
        {lines.map((l, i) => (
          <mesh key={i} position={[l.x, l.y, l.z]} material={codeMat}>
            <boxGeometry args={[l.w, 0.025, 0.012]} />
          </mesh>
        ))}
      </group>

      {/* Floating tool badge */}
      <group ref={badge}>
        <Billboard>
          <RoundedBox args={[0.32 + label.length * 0.085, 0.3, 0.05]} radius={0.06} material={MAT.charcoal} />
          <mesh position={[-(0.32 + label.length * 0.085) / 2 + 0.11, 0, 0.03]}>
            <circleGeometry args={[0.035, 16]} />
            <meshBasicMaterial color={beamHex} toneMapped={false} />
          </mesh>
          <Text position={[0.04, -0.005, 0.03]} fontSize={0.15} letterSpacing={0.02} anchorX="center" anchorY="middle" color={beamHex}>
            {label}
          </Text>
        </Billboard>
      </group>
    </group>
  );
}
