import { create } from 'zustand';

export type AgentState = 'OFFLINE' | 'IDLE' | 'WAITING' | 'GENERATING' | 'TOOL_RUNNING';

export interface Session {
  id: string;
  cwd: string;
  project: string;
  source: string;
  state: AgentState;
  tool: string | null;
  lastTool?: string | null;
  prompts?: number;
  startedAt: number;
  lastSeen: number;
}

export const COMBO_WINDOW_MS = 5 * 60 * 1000;
const MAX_SIM_SATELLITES = 6;

const SIM_MAIN: Session = {
  id: 'sim-main',
  cwd: '~/dev/clawd-desk',
  project: 'clawd-desk',
  source: 'sim',
  state: 'IDLE',
  tool: null,
  startedAt: 0,
  lastSeen: 0,
};

const SIM_PROJECTS = ['api-gateway', 'web-app', 'infra', 'docs-site', 'ml-pipeline', 'mobile'];
const SIM_STATES: AgentState[] = ['IDLE', 'WAITING', 'GENERATING', 'TOOL_RUNNING'];
const SIM_TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];

interface Derived {
  state: AgentState;
  tool: string | null;
  project: string;
  primaryId: string | null;
  satellites: Session[];
  sessionCount: number;
  sources: { vscode: number; cli: number; other: number };
}

interface StoreState extends Derived {
  connected: boolean;
  live: Session[];
  simSats: Session[];
  /** Dock override. In live mode it's cleared by the next real hook event. */
  override: { state: AgentState; tool: string | null } | null;

  combo: number;
  lastPromptAt: number;
  focusAccum: number;
  focusSince: number | null;
  muted: boolean;

  setConnected: (c: boolean) => void;
  applySnapshot: (sessions: Session[], reason: string) => void;
  simulate: (state: AgentState, tool?: string | null) => void;
  addSatellite: () => void;
  clearSatellites: () => void;
  setMuted: (m: boolean) => void;
}

const isActive = (s: AgentState) => s === 'GENERATING' || s === 'TOOL_RUNNING';

function derive(s: Pick<StoreState, 'connected' | 'live' | 'simSats' | 'override'>): Derived {
  const base = s.connected ? s.live : [SIM_MAIN];
  const byRecent = [...base].sort((a, b) => b.lastSeen - a.lastSeen);
  const active = byRecent.filter((x) => x.state !== 'OFFLINE');
  const primary = active[0] ?? byRecent[0] ?? null;

  let state: AgentState = primary?.state ?? 'OFFLINE';
  let tool = primary?.tool ?? null;
  if (s.override) {
    state = s.override.state;
    tool = s.override.tool;
  }

  const satellites = [...active.filter((x) => x.id !== primary?.id), ...s.simSats];
  const sources = { vscode: 0, cli: 0, other: 0 };
  for (const x of s.connected ? active : []) {
    if (x.source === 'vscode') sources.vscode++;
    else if (x.source === 'cli') sources.cli++;
    else sources.other++;
  }

  return {
    state,
    tool,
    project: primary?.project ?? '—',
    primaryId: primary?.id ?? null,
    satellites,
    sessionCount: (s.connected ? active.length : 1) + s.simSats.length,
    sources,
  };
}

export const useStore = create<StoreState>((set, get) => {
  /** Merge a partial update, re-derive the view, and track combo / focus stats on transitions. */
  const commit = (partial: Partial<StoreState>) => {
    const prev = get();
    const next = { ...prev, ...partial };
    const d = derive(next);
    const stats: Partial<StoreState> = {};

    if (d.state !== prev.state) {
      const now = Date.now();
      if (d.state === 'GENERATING' && !isActive(prev.state)) {
        const inWindow = prev.lastPromptAt > 0 && now - prev.lastPromptAt < COMBO_WINDOW_MS;
        stats.combo = inWindow ? prev.combo + 1 : 1;
        stats.lastPromptAt = now;
      }
      if (isActive(prev.state) && !isActive(d.state) && prev.focusSince != null) {
        stats.focusAccum = prev.focusAccum + (now - prev.focusSince);
        stats.focusSince = null;
      } else if (!isActive(prev.state) && isActive(d.state)) {
        stats.focusSince = now;
      }
    }
    set({ ...partial, ...d, ...stats });
  };

  return {
    connected: false,
    live: [],
    simSats: [],
    override: null,
    ...derive({ connected: false, live: [], simSats: [], override: null }),

    combo: 0,
    lastPromptAt: 0,
    focusAccum: 0,
    focusSince: null,
    muted: true,

    setConnected: (connected) => {
      if (connected === get().connected) return;
      // Dropping back to the simulator? Start from a calm idle desk.
      commit({ connected, override: null, live: connected ? get().live : [] });
    },

    applySnapshot: (sessions, reason) => {
      commit({ live: sessions, ...(reason === 'hook' ? { override: null } : {}) });
    },

    simulate: (state, tool = null) => commit({ override: { state, tool: state === 'TOOL_RUNNING' ? tool : null } }),

    addSatellite: () => {
      const sats = get().simSats;
      if (sats.length >= MAX_SIM_SATELLITES) return;
      const i = sats.length;
      const state = SIM_STATES[Math.floor(Math.random() * SIM_STATES.length)];
      const sat: Session = {
        id: `sim-sat-${Date.now()}-${i}`,
        cwd: `~/dev/${SIM_PROJECTS[i]}`,
        project: SIM_PROJECTS[i],
        source: i % 2 ? 'cli' : 'vscode',
        state,
        tool: state === 'TOOL_RUNNING' ? SIM_TOOLS[i % SIM_TOOLS.length] : null,
        startedAt: Date.now(),
        lastSeen: Date.now(),
      };
      commit({ simSats: [...sats, sat] });
    },

    clearSatellites: () => commit({ simSats: [] }),

    setMuted: (muted) => set({ muted }),
  };
});

export { isActive, MAX_SIM_SATELLITES };
