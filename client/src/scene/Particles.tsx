import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mix } from './mix';
import { CORE_POS } from './layout';

const COUNT = 260;

/** Upward fountain of "token" particles while generating. */
export function TokenFountain() {
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  const sim = useMemo(
    () => ({
      pos: new Float32Array(COUNT * 3),
      vel: new Float32Array(COUNT * 3),
      life: new Float32Array(COUNT),
      maxLife: new Float32Array(COUNT),
      spin: new Float32Array(COUNT),
      cursor: 0,
      acc: 0,
    }),
    [],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tint = useMemo(() => new THREE.Color(), []);

  useFrame((_, dt) => {
    const d = sim;
    // Spawn
    d.acc += (mix.gen * 110 + mix.tool * 10) * dt;
    while (d.acc >= 1) {
      d.acc -= 1;
      const i = d.cursor;
      d.cursor = (d.cursor + 1) % COUNT;
      const a = Math.random() * Math.PI * 2;
      const r = 0.15 + Math.random() * 0.2;
      d.pos[i * 3] = CORE_POS[0] + Math.cos(a) * r;
      d.pos[i * 3 + 1] = mix.coreY + 0.25;
      d.pos[i * 3 + 2] = CORE_POS[2] + Math.sin(a) * r;
      const spread = 0.35 + Math.random() * 0.55;
      d.vel[i * 3] = Math.cos(a) * spread;
      d.vel[i * 3 + 1] = 2.4 + Math.random() * 1.8;
      d.vel[i * 3 + 2] = Math.sin(a) * spread;
      d.maxLife[i] = d.life[i] = 1.4 + Math.random() * 1.1;
      d.spin[i] = (Math.random() - 0.5) * 8;
    }

    // Integrate
    for (let i = 0; i < COUNT; i++) {
      if (d.life[i] > 0) {
        d.life[i] -= dt;
        d.vel[i * 3 + 1] -= 1.6 * dt;
        d.vel[i * 3] *= 1 - 0.4 * dt;
        d.vel[i * 3 + 2] *= 1 - 0.4 * dt;
        d.pos[i * 3] += d.vel[i * 3] * dt;
        d.pos[i * 3 + 1] += d.vel[i * 3 + 1] * dt;
        d.pos[i * 3 + 2] += d.vel[i * 3 + 2] * dt;
      }
      const k = Math.max(0, d.life[i]) / (d.maxLife[i] || 1);
      const s = k > 0 ? Math.min(1, k * 3) * Math.min(1, (1 - k) * 8 + 0.2) * 0.07 : 0;
      dummy.position.set(d.pos[i * 3], d.pos[i * 3 + 1], d.pos[i * 3 + 2]);
      dummy.rotation.set(d.spin[i] * k, d.spin[i] * k * 0.7, 0);
      dummy.scale.set(s * 1.6, s, s * 0.35);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
    mat.current.color.copy(tint.copy(mix.color).multiplyScalar(3.2));
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, COUNT]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial ref={mat} toneMapped={false} />
    </instancedMesh>
  );
}
