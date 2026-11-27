import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import * as THREE from 'three';
import { stateHex } from './mix';
import { MAT } from './materials';
import { CORE_POS } from './layout';
import { useStore, type Session } from '../store';

/** Mini-drone orbiting the core: one per additional active session. */
function Drone({ session, index, total }: { session: Session; index: number; total: number }) {
  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const ring = useRef<THREE.Mesh>(null!);
  const orbMat = useRef<THREE.MeshStandardMaterial>(null!);
  const st8 = useRef({ angle: (index / Math.max(1, total)) * Math.PI * 2, grow: 0 });
  const target = useMemo(() => new THREE.Color(stateHex(session.state, session.tool)), [session.state, session.tool]);

  const speed = session.state === 'GENERATING' ? 1.1 : session.state === 'TOOL_RUNNING' ? 0.7 : 0.35;
  const radius = 2.15 + (index % 3) * 0.32;
  const tilt = 0.18 + (index % 2) * 0.22;

  useFrame((s, dt) => {
    const t = s.clock.elapsedTime;
    const d = st8.current;
    d.grow = THREE.MathUtils.damp(d.grow, 1, 3, dt);
    d.angle += dt * speed * (index % 2 ? -1 : 1);
    const x = Math.cos(d.angle) * radius;
    const z = Math.sin(d.angle) * radius;
    const y = 1.9 + Math.sin(d.angle) * radius * tilt * 0.4 + Math.sin(t * 2 + index) * 0.06;
    root.current.position.set(CORE_POS[0] + x, CORE_POS[1] + y, CORE_POS[2] + z);
    root.current.scale.setScalar(d.grow);
    body.current.rotation.y += dt * (1 + speed * 2);
    ring.current.rotation.x = Math.PI / 2 + Math.sin(t * 1.3 + index) * 0.3;

    orbMat.current.emissive.lerp(target, 1 - Math.exp(-4 * dt));
    const pulse = session.state === 'GENERATING' ? 3 + Math.sin(t * 18) : session.state === 'TOOL_RUNNING' ? 2.2 + Math.sin(t * 9) * 0.6 : 1.2 + Math.sin(t * 2) * 0.4;
    orbMat.current.emissiveIntensity = pulse;
  });

  return (
    <group ref={root}>
      <group ref={body}>
        <mesh>
          <icosahedronGeometry args={[0.11, 1]} />
          <meshStandardMaterial ref={orbMat} color="#151515" flatShading toneMapped={false} />
        </mesh>
        <mesh material={MAT.frost}>
          <icosahedronGeometry args={[0.17, 0]} />
        </mesh>
        {[0, 1, 2, 3].map((i) => {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          return (
            <group key={i} position={[Math.cos(a) * 0.24, 0.02, Math.sin(a) * 0.24]}>
              <mesh material={MAT.charcoal}>
                <cylinderGeometry args={[0.045, 0.045, 0.02, 16]} />
              </mesh>
              <mesh material={i % 2 ? MAT.orange : MAT.bone} position={[-Math.cos(a) * 0.1, 0, -Math.sin(a) * 0.1]} rotation={[0, -a, Math.PI / 2]}>
                <cylinderGeometry args={[0.012, 0.012, 0.18, 6]} />
              </mesh>
            </group>
          );
        })}
      </group>
      <mesh ref={ring} material={MAT.bone}>
        <torusGeometry args={[0.2, 0.012, 8, 40]} />
      </mesh>
      <Billboard position={[0, 0.32, 0]}>
        <Text fontSize={0.085} anchorX="center" anchorY="bottom" color="#ffffff" outlineWidth={0.006} outlineColor="#000000">
          {session.project}
        </Text>
        <Text position={[0, -0.02, 0]} fontSize={0.055} anchorX="center" anchorY="top" color={stateHex(session.state, session.tool)} letterSpacing={0.12}>
          {`${session.source.toUpperCase()} · ${session.state === 'TOOL_RUNNING' ? session.tool ?? 'TOOL' : session.state}`}
        </Text>
      </Billboard>
    </group>
  );
}

export function Satellites() {
  const sats = useStore((s) => s.satellites);
  return (
    <>
      {sats.map((s, i) => (
        <Drone key={s.id} session={s} index={i} total={sats.length} />
      ))}
    </>
  );
}
