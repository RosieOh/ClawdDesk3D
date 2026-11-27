import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { mix } from './mix';
import { MAT } from './materials';
import { RACK_POS } from './layout';

const SLOTS = 5;
const LEDS_PER_SLOT = 6;
const N = SLOTS * LEDS_PER_SLOT;
const W = 0.9;
const H = 1.65;
const D = 0.8;

const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

/** Mini server rack with pulsing status LEDs. */
export function ServerRack() {
  const leds = useRef<THREE.InstancedMesh>(null!);
  const fan = useRef<THREE.Group>(null!);
  const color = useMemo(() => new THREE.Color(), []);
  const standby = useMemo(() => new THREE.Color('#ff3b2f'), []);
  const ok = useMemo(() => new THREE.Color('#44ff9a'), []);

  const ledPositions = useMemo(() => {
    const out: [number, number, number][] = [];
    for (let s = 0; s < SLOTS; s++) {
      for (let l = 0; l < LEDS_PER_SLOT; l++) {
        out.push([-0.3 + l * 0.07, 0.25 + s * 0.29, D / 2 + 0.035]);
      }
    }
    return out;
  }, []);

  useFrame((st, dt) => {
    const t = st.clock.elapsedTime;
    const { offline, idle, gen, tool } = mix;
    const tick12 = Math.floor(t * 14);
    const chase = (t * 10) % N;

    for (let i = 0; i < N; i++) {
      // Each state contributes its own pattern, blended by the mix weights.
      const flicker = hash(i * 31 + tick12) > 0.45 ? 1 : 0.08;
      const d = Math.abs(i - chase);
      const chaseB = Math.max(0, 1 - Math.min(d, N - d) / 3);
      const breathe = (i % 3 === 0 ? 1 : 0.15) * (0.5 + 0.5 * Math.sin(t * 1.6 + i));
      const b = tool * flicker * 3.2 + gen * (0.25 + chaseB * 3) + idle * breathe * 1.4;
      color.copy(mix.color).multiplyScalar(b);
      if (i % LEDS_PER_SLOT === 0) color.lerp(ok, 0.5 * (1 - offline));
      if (i === 0) color.lerp(standby, offline).multiplyScalar(1 + offline * (0.8 + Math.sin(t * 2) * 0.6));
      leds.current.setColorAt(i, color);
    }
    if (leds.current.instanceColor) leds.current.instanceColor.needsUpdate = true;

    fan.current.rotation.z -= dt * (0.5 * idle + 14 * gen + 22 * tool);
  });

  return (
    <group position={RACK_POS as unknown as [number, number, number]} rotation={[0, -0.12, 0]}>
      <RoundedBox args={[W, H, D]} radius={0.06} smoothness={4} position={[0, H / 2, 0]} material={MAT.charcoal} castShadow receiveShadow />
      {Array.from({ length: SLOTS }, (_, s) => (
        <group key={s} position={[0, 0.25 + s * 0.29, D / 2]}>
          <RoundedBox args={[W - 0.1, 0.23, 0.04]} radius={0.015} material={MAT.graphite} castShadow />
          <mesh material={MAT.charcoal} position={[0.27, 0, 0.025]}>
            <boxGeometry args={[0.18, 0.04, 0.01]} />
          </mesh>
        </group>
      ))}
      {/* Status LEDs */}
      <instancedMesh
        ref={(m) => {
          if (!m) return;
          leds.current = m;
          const o = new THREE.Object3D();
          ledPositions.forEach((p, i) => {
            o.position.set(...p);
            o.updateMatrix();
            m.setMatrixAt(i, o.matrix);
            m.setColorAt(i, new THREE.Color('#000'));
          });
          m.instanceMatrix.needsUpdate = true;
        }}
        args={[undefined, undefined, N]}
      >
        <sphereGeometry args={[0.022, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      {/* Side fan */}
      <group position={[W / 2 + 0.01, H * 0.62, 0]} rotation={[0, Math.PI / 2, 0]}>
        <mesh material={MAT.orange}>
          <torusGeometry args={[0.22, 0.03, 12, 40]} />
        </mesh>
        <group ref={fan}>
          {[0, 1, 2, 3, 4].map((i) => (
            <mesh key={i} material={MAT.bone} rotation={[0, 0, (i / 5) * Math.PI * 2]} position={[0, 0, 0.01]}>
              <boxGeometry args={[0.36, 0.06, 0.01]} />
            </mesh>
          ))}
        </group>
      </group>
      {/* Little antenna */}
      <mesh material={MAT.bone} position={[0.3, H + 0.18, -0.2]}>
        <cylinderGeometry args={[0.012, 0.012, 0.36, 8]} />
      </mesh>
      <mesh material={MAT.orange} position={[0.3, H + 0.38, -0.2]}>
        <sphereGeometry args={[0.04, 16, 16]} />
      </mesh>
    </group>
  );
}
