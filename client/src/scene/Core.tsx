import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mix } from './mix';
import { MAT, PALETTE } from './materials';
import { CORE_POS } from './layout';

const REST_Y = 0.62; // resting on the dock
const HOVER_Y = 1.85;

/** The Clawd Core: glowing icosahedron in a frosted shell, wrapped in gyroscopic rings. */
export function Core() {
  const root = useRef<THREE.Group>(null!);
  const inner = useRef<THREE.Mesh>(null!);
  const innerMat = useRef<THREE.MeshStandardMaterial>(null!);
  const shell = useRef<THREE.Mesh>(null!);
  const visorMat = useRef<THREE.MeshStandardMaterial>(null!);
  const visor = useRef<THREE.Mesh>(null!);
  const ringA = useRef<THREE.Group>(null!);
  const ringB = useRef<THREE.Group>(null!);
  const ringC = useRef<THREE.Group>(null!);
  const glowRingMat = useRef<THREE.MeshStandardMaterial>(null!);
  const light = useRef<THREE.PointLight>(null!);
  const dockMat = useRef<THREE.MeshStandardMaterial>(null!);
  const spin = useRef({ a: 0, b: 0, c: 0, inner: 0 });

  useFrame((st, dt) => {
    const t = st.clock.elapsedTime;
    const { offline, idle, gen, tool, wait } = mix;
    // Attention blink while waiting for permission: sharp on/off at ~1.25 Hz
    const blink = wait * (Math.sin(t * 7.85) > 0 ? 1 : 0);
    const awake = 1 - offline;

    // Float / breathe
    const bob = Math.sin(t * 1.3) * (0.12 * idle + 0.05 * tool + 0.07 * gen);
    const y = REST_Y + awake * (HOVER_Y - REST_Y) + bob;
    root.current.position.y = y;
    mix.coreY = CORE_POS[1] + y;

    const breath = 1 + Math.sin(t * 2.1) * 0.05 * idle + Math.sin(t * 17) * 0.035 * gen + Math.sin(t * 9) * 0.02 * tool;
    inner.current.scale.setScalar(breath);
    spin.current.inner += dt * (0.25 * idle + 2.2 * gen + 0.9 * tool);
    inner.current.rotation.set(spin.current.inner * 0.6, spin.current.inner, 0);
    shell.current.rotation.y = -spin.current.inner * 0.3;

    innerMat.current.emissive.copy(mix.color);
    innerMat.current.emissiveIntensity =
      0.25 * offline + (1.6 + 0.5 * Math.sin(t * 2.1)) * idle + (5 + Math.sin(t * 23) * 1.2) * gen + (3.2 + Math.sin(t * 8) * 0.6) * tool;

    // Visor: soft pulse
    visorMat.current.emissive.copy(mix.color);
    visorMat.current.emissiveIntensity =
      0.1 * offline + (1.2 + Math.sin(t * 2.2) * 0.9) * idle * (1 - wait) + 3.5 * gen + (2 + Math.sin(t * 10) * 1.2) * tool + 5 * blink;
    visor.current.rotation.z = Math.sin(t * 0.7) * 0.08 * awake;

    // Gyroscope: counter-rotating rings (static when offline)
    const s = spin.current;
    s.a += dt * (0.22 * idle + 3.4 * gen + 0.8 * tool);
    s.b -= dt * (0.16 * idle + 2.7 * gen + 0.55 * tool);
    s.c += dt * (0.3 * idle + 4.1 * gen + 1.2 * tool);
    // Asleep, the rings fold flat (coplanar) around the docked core.
    const L = THREE.MathUtils.lerp;
    ringA.current.rotation.set((Math.PI / 2) * offline, s.a, 0);
    ringB.current.rotation.set(L(s.b + Math.PI / 2, 0, offline), 0, 0);
    ringC.current.rotation.set(0, L(s.c, 0, offline), L(Math.PI / 2, 0, offline));
    glowRingMat.current.emissive.copy(mix.color);
    glowRingMat.current.emissiveIntensity = 0.15 * offline + 1.5 * idle + 4 * gen + 2.5 * tool;

    light.current.color.copy(mix.color);
    light.current.intensity = 0.4 * offline + 7 * idle + (18 + Math.sin(t * 20) * 3) * gen + 11 * tool + 6 * blink;

    // Dock "charging" glow is strongest while asleep
    dockMat.current.emissive.copy(mix.color);
    dockMat.current.emissiveIntensity = (0.6 + Math.sin(t * 1.5) * 0.4) * offline * 2 + awake * 0.6;
  });

  return (
    <group position={CORE_POS as unknown as [number, number, number]}>
      {/* Dock */}
      <mesh material={MAT.charcoal} position={[0, 0.06, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.78, 0.86, 0.12, 48]} />
      </mesh>
      <mesh position={[0, 0.125, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.6, 0.025, 12, 64]} />
        <meshStandardMaterial ref={dockMat} color="#111" toneMapped={false} />
      </mesh>
      <mesh material={MAT.graphite} position={[0, 0.14, 0]} receiveShadow>
        <cylinderGeometry args={[0.5, 0.5, 0.04, 40]} />
      </mesh>

      <group ref={root}>
        {/* Inner glowing core */}
        <mesh ref={inner} castShadow>
          <icosahedronGeometry args={[0.36, 1]} />
          <meshStandardMaterial ref={innerMat} color="#1a1a1a" roughness={0.35} flatShading toneMapped={false} />
        </mesh>
        {/* Frosted shell */}
        <mesh ref={shell} material={MAT.frost} castShadow>
          <icosahedronGeometry args={[0.55, 0]} />
        </mesh>
        {/* Visor band */}
        <mesh ref={visor} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.6, 0.028, 12, 72]} />
          <meshStandardMaterial ref={visorMat} color="#111" toneMapped={false} />
        </mesh>

        {/* Gyroscopic rings: A (outer, Y) > B (mid, X) > C (inner) */}
        {/* YXZ: tilt flat first, then spin about world Y */}
        <group ref={ringA} rotation-order="YXZ">
          <mesh material={MAT.bone} castShadow>
            <torusGeometry args={[1.12, 0.045, 16, 96]} />
          </mesh>
          {[0, Math.PI].map((r) => (
            <mesh key={r} material={MAT.orange} position={[Math.cos(r) * 1.12, 0, Math.sin(r) * 1.12]}>
              <sphereGeometry args={[0.07, 16, 16]} />
            </mesh>
          ))}
          <group ref={ringB}>
            <mesh castShadow>
              <torusGeometry args={[0.95, 0.04, 16, 96]} />
              <meshPhysicalMaterial color={PALETTE.terracotta} roughness={0.75} />
            </mesh>
            <group ref={ringC}>
              <mesh>
                <torusGeometry args={[0.8, 0.018, 12, 96]} />
                <meshStandardMaterial ref={glowRingMat} color="#111" toneMapped={false} />
              </mesh>
            </group>
          </group>
        </group>

        <pointLight ref={light} distance={7} decay={2} position={[0, 0, 0]} />
      </group>
    </group>
  );
}
