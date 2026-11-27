import * as THREE from 'three';
import type { AgentState } from '../store';

/** Hex palette per state (UI + 3D share this). */
export const STATE_HEX: Record<AgentState, string> = {
  OFFLINE: '#7d8fa8',
  IDLE: '#ff9a4d',
  GENERATING: '#ffb35c',
  TOOL_RUNNING: '#2ee6c5',
};

const BG_HEX: Record<AgentState, string> = {
  OFFLINE: '#151a22',
  IDLE: '#231916',
  GENERATING: '#2a1711',
  TOOL_RUNNING: '#0d1e1d',
};

const EMERALD_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function toolHex(tool: string | null | undefined): string {
  return tool && EMERALD_TOOLS.has(tool) ? '#34f5a4' : '#36d7ff';
}

export function stateHex(state: AgentState, tool?: string | null): string {
  return state === 'TOOL_RUNNING' ? toolHex(tool) : STATE_HEX[state];
}

/**
 * Shared, frame-damped animation state. Written once per frame by <StateDriver/>,
 * read by every animated component inside useFrame (no React re-renders).
 */
export const mix = {
  offline: 1,
  idle: 0,
  gen: 0,
  tool: 0,
  /** current smoothed accent color */
  color: new THREE.Color(STATE_HEX.OFFLINE),
  bg: new THREE.Color(BG_HEX.OFFLINE),
  /** world-space Y of the core (written by <Core/>) */
  coreY: 1,
};

const tmp = new THREE.Color();

export function stepMix(state: AgentState, tool: string | null, dt: number) {
  const k = 3.2;
  mix.offline = THREE.MathUtils.damp(mix.offline, state === 'OFFLINE' ? 1 : 0, k, dt);
  mix.idle = THREE.MathUtils.damp(mix.idle, state === 'IDLE' ? 1 : 0, k, dt);
  mix.gen = THREE.MathUtils.damp(mix.gen, state === 'GENERATING' ? 1 : 0, k, dt);
  mix.tool = THREE.MathUtils.damp(mix.tool, state === 'TOOL_RUNNING' ? 1 : 0, k, dt);

  const a = 1 - Math.exp(-k * dt);
  mix.color.lerp(tmp.set(stateHex(state, tool)), a);
  mix.bg.lerp(tmp.set(BG_HEX[state]), a * 0.8);
}

/** 0 when offline, 1 when awake. */
export const awake = () => 1 - mix.offline;
