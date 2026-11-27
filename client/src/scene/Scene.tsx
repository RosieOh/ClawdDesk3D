import { useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls, Sparkles } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode, type BloomEffect } from 'postprocessing';
import * as THREE from 'three';
import { mix, stepMix } from './mix';
import { useStore } from '../store';
import { Diorama } from './Diorama';

/** Advances the shared state mix once per frame; also drives background + fog. */
function StateDriver() {
  const scene = useThree((s) => s.scene);
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const { state, tool } = useStore.getState();
    stepMix(state, tool, dt);
    if (scene.background instanceof THREE.Color) scene.background.copy(mix.bg);
    if (scene.fog) scene.fog.color.copy(mix.bg);
  });
  return null;
}

function Lights() {
  const hemi = useRef<THREE.HemisphereLight>(null!);
  const key = useRef<THREE.DirectionalLight>(null!);
  const rim = useRef<THREE.DirectionalLight>(null!);
  const warm = new THREE.Color('#ffe2c4');
  const slate = new THREE.Color('#9fb3cc');

  useFrame(() => {
    const awake = 1 - mix.offline;
    hemi.current.intensity = 0.3 + 0.2 * awake;
    key.current.intensity = 0.9 + 0.55 * awake;
    key.current.color.copy(slate).lerp(warm, awake);
    rim.current.color.copy(mix.color);
    rim.current.intensity = 0.4 + 1.2 * awake;
  });

  return (
    <>
      <hemisphereLight ref={hemi} args={['#fff1e0', '#2a2220', 0.7]} />
      <directionalLight
        ref={key}
        position={[5, 9, 4]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={1}
        shadow-camera-far={25}
      />
      <directionalLight ref={rim} position={[-6, 4, -6]} />
    </>
  );
}

function Post() {
  const bloom = useRef<BloomEffect>(null!);
  useFrame(() => {
    if (bloom.current) bloom.current.intensity = 0.55 + 0.35 * mix.idle + 0.9 * mix.gen + 0.6 * mix.tool;
  });
  return (
    <EffectComposer multisampling={4}>
      {/* lib typings declare the ref as the class itself; cast to the instance type */}
      <Bloom ref={bloom as never} mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.25} radius={0.72} intensity={0.8} />
      <Vignette offset={0.28} darkness={0.62} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}

function Ambience() {
  const ref = useRef<THREE.Group>(null!);
  useFrame(() => {
    ref.current.visible = mix.offline < 0.95;
  });
  return (
    <group ref={ref}>
      <Sparkles count={60} scale={[12, 6, 12]} position={[0, 2, 0]} size={2.2} speed={0.25} opacity={0.35} color="#ffd9b0" />
    </group>
  );
}

export function Scene() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [8.6, 7.4, 8.6], fov: 32, near: 0.1, far: 100 }}
      gl={{ antialias: false, powerPreference: 'high-performance' }}
    >
      <color attach="background" args={['#151a22']} />
      <fog attach="fog" args={['#151a22', 16, 38]} />
      <StateDriver />
      <Lights />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={1.1} position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} color="#fff4e6" />
        <Lightformer form="rect" intensity={1.2} position={[-6, 2, 3]} rotation-y={Math.PI / 2} scale={[6, 3, 1]} color="#ffd2b0" />
        <Lightformer form="rect" intensity={0.8} position={[6, 2, -3]} rotation-y={-Math.PI / 2} scale={[6, 3, 1]} color="#bcd4ff" />
        <Lightformer form="ring" intensity={1.5} position={[3, 3, 6]} scale={2} color="#ffffff" />
      </Environment>

      <Diorama />
      <Ambience />

      <OrbitControls
        makeDefault
        target={[0, 1.1, 0]}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={7}
        maxDistance={24}
        minPolarAngle={0.35}
        maxPolarAngle={1.4}
      />
      <Post />
    </Canvas>
  );
}
