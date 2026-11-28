import { create } from 'zustand';
import { setAudioEnabled } from './audio';
import type { Lang } from './voice/announcer';

export type AgentState = 'OFFLINE' | 'IDLE' | 'WAITING' | 'GENERATING' | 'TOOL_RUNNING';

export interface Session {
  id: string;
  cwd: string;
  project: string;
  source: string;
  state: AgentState;
  tool: string | null;
  /** tools currently in flight (parallel tool calls) */
  running?: number;
  lastTool?: string | null;
  /** last hook event name, e.g. `Stop` or `StopFailure` */
  lastEvent?: string;
  prompts?: number;
  startedAt: number;
  lastSeen: number;
  /** model id, e.g. `claude-opus-5-5` */
  model?: string | null;
  /** `default` | `plan` | `acceptEdits` | `auto` | `bypassPermissions` | … */
  permissionMode?: string | null;
  gitBranch?: string | null;
  /** Claude Code version */
  claudeVersion?: string | null;
  /** `startup` | `resume` | `clear` */
  startSource?: string | null;
}

/** A permission request the bridge is holding for an answer from the desk. */
export interface Approval {
  id: string;
  sessionId: string;
  project: string;
  tool: string;
  /** what the tool wants to do: command, file, URL… */
  summary: string;
  createdAt: number;
  expiresAt: number;
}

/** A task sent to Claude from the desk (spoken command), as the bridge reports it. */
export interface DeskCommand {
  id: string;
  prompt: string;
  project: string;
  status: 'running' | 'done' | 'failed';
  result: string | null;
  startedAt: number;
  finishedAt: number | null;
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
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  gitBranch: 'main',
  startSource: 'startup',
};

const SIM_PROJECTS = ['api-gateway', 'web-app', 'infra', 'docs-site', 'ml-pipeline', 'mobile'];
const SIM_STATES: AgentState[] = ['IDLE', 'WAITING', 'GENERATING', 'TOOL_RUNNING'];
const SIM_TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];
const SIM_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const SIM_MODES = ['default', 'acceptEdits', 'plan', 'auto'];

interface Derived {
  state: AgentState;
  tool: string | null;
  /** in-flight tool count of the primary session */
  running: number;
  project: string;
  primaryId: string | null;
  /** the session the desk is showing (pinned, else the most recently active) */
  primary: Session | null;
  /** every known session, most recent first (live ones, then simulated satellites) */
  sessions: Session[];
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
  /** permission requests waiting for Approve / Deny (live mode only) */
  approvals: Approval[];
  /** tasks sent to Claude from the desk */
  commands: DeskCommand[];
  /** the voice lab can transcribe spoken commands */
  sttAvailable: boolean;
  /** spoken command in progress */
  listening: 'idle' | 'listening' | 'thinking';
  /** session chosen in the HUD list; cleared automatically when that session disappears */
  pinnedId: string | null;

  combo: number;
  lastPromptAt: number;
  focusAccum: number;
  focusSince: number | null;
  muted: boolean;
  /** spoken announcements (JARVIS voice) */
  voiceOn: boolean;
  voiceLang: Lang;
  /** latest announcement, shown as a subtitle whether or not the voice is on */
  caption: { id: number; text: string } | null;
  /** name of the local voice pack, when one is installed */
  voicePack: string | null;
  /** voice-lab voice name, while the local voice lab is running */
  voiceLab: string | null;
  /** listen to the microphone for a double clap */
  clapOn: boolean;

  setConnected: (c: boolean) => void;
  applySnapshot: (sessions: Session[], reason: string, approvals?: Approval[], commands?: DeskCommand[]) => void;
  simulate: (state: AgentState, tool?: string | null) => void;
  addSatellite: () => void;
  clearSatellites: () => void;
  /** show this session on the desk (null: follow the most recently active one again) */
  pin: (id: string | null) => void;
  toggleMute: () => void;
  setVoice: (on: boolean) => void;
  setVoiceLang: (lang: Lang) => void;
  setCaption: (text: string) => void;
  setVoicePack: (name: string | null) => void;
  setVoiceLab: (name: string | null) => void;
  setClap: (on: boolean) => void;
  setStt: (on: boolean) => void;
  setListening: (l: 'idle' | 'listening' | 'thinking') => void;
}

// Voice preferences survive reloads (per browser). Storage can be unavailable; the defaults then apply.
const PREF_VOICE = 'clawddesk.voice';
const PREF_LANG = 'clawddesk.voiceLang';
const PREF_CLAP = 'clawddesk.clap';
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: keep it in memory only */
  }
}
/** English (the JARVIS voice) unless the viewer picked Korean before. */
const defaultLang = (): Lang => {
  const saved = typeof window === 'undefined' ? null : readPref(PREF_LANG);
  return saved === 'ko' ? 'ko' : 'en';
};

const isActive = (s: AgentState) => s === 'GENERATING' || s === 'TOOL_RUNNING';
const isResting = (s: AgentState) => s === 'IDLE' || s === 'OFFLINE';
/** Stats track real work only: the simulator demo counts, a manual override on top of live data doesn't. */
const isReal = (s: Pick<StoreState, 'connected' | 'override'>) => !s.connected || s.override == null;

type DeriveInput = Pick<StoreState, 'connected' | 'live' | 'simSats' | 'override' | 'pinnedId'>;

function derive(s: DeriveInput): Derived {
  const base = s.connected ? s.live : [SIM_MAIN];
  const byRecent = [...base].sort((a, b) => b.lastSeen - a.lastSeen);
  const active = byRecent.filter((x) => x.state !== 'OFFLINE');
  const all = [...byRecent, ...s.simSats];
  const pinned = s.pinnedId ? (all.find((x) => x.id === s.pinnedId) ?? null) : null;
  const primary = pinned ?? active[0] ?? byRecent[0] ?? null;

  let state: AgentState = primary?.state ?? 'OFFLINE';
  let tool = primary?.tool ?? null;
  let running = primary?.running ?? (tool ? 1 : 0);
  if (s.override) {
    state = s.override.state;
    tool = s.override.tool;
    running = tool ? 1 : 0;
  }

  const satellites = all.filter((x) => x.state !== 'OFFLINE' && x.id !== primary?.id);
  const sources = { vscode: 0, cli: 0, other: 0 };
  for (const x of s.connected ? active : []) {
    if (x.source === 'vscode') sources.vscode++;
    else if (x.source === 'cli') sources.cli++;
    else sources.other++;
  }

  return {
    state,
    tool,
    running,
    project: primary?.project ?? '—',
    primaryId: primary?.id ?? null,
    primary,
    sessions: all,
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
    // A pinned session that is gone (swept, or the simulator was reset) releases the pin.
    if (next.pinnedId && ![...(next.connected ? next.live : [SIM_MAIN]), ...next.simSats].some((x) => x.id === next.pinnedId)) {
      next.pinnedId = partial.pinnedId = null;
    }
    const d = derive(next);
    const stats: Partial<StoreState> = {};

    const now = Date.now();
    const wasReal = isReal(prev);
    const nowReal = isReal(next);
    // A new prompt = leaving rest. Resuming after a permission prompt (WAITING) is the same turn.
    // Switching the shown session isn't a new prompt either.
    if (nowReal && d.state === 'GENERATING' && isResting(prev.state) && d.primaryId === prev.primaryId) {
      const inWindow = prev.lastPromptAt > 0 && now - prev.lastPromptAt < COMBO_WINDOW_MS;
      stats.combo = inWindow ? prev.combo + 1 : 1;
      stats.lastPromptAt = now;
    }
    const wasFocused = wasReal && isActive(prev.state);
    const nowFocused = nowReal && isActive(d.state);
    if (wasFocused && !nowFocused && prev.focusSince != null) {
      stats.focusAccum = prev.focusAccum + (now - prev.focusSince);
      stats.focusSince = null;
    } else if (!wasFocused && nowFocused) {
      stats.focusSince = now;
    }
    set({ ...partial, ...d, ...stats });
  };

  return {
    connected: false,
    live: [],
    simSats: [],
    override: null,
    pinnedId: null,
    approvals: [],
    commands: [],
    sttAvailable: false,
    listening: 'idle',
    ...derive({ connected: false, live: [], simSats: [], override: null, pinnedId: null }),

    combo: 0,
    lastPromptAt: 0,
    focusAccum: 0,
    focusSince: null,
    muted: true,
    voiceOn: typeof window !== 'undefined' && readPref(PREF_VOICE) === 'on',
    voiceLang: defaultLang(),
    caption: null,
    voicePack: null,
    voiceLab: null,
    clapOn: typeof window !== 'undefined' && readPref(PREF_CLAP) === 'on',

    setConnected: (connected) => {
      if (connected === get().connected) return;
      // Dropping back to the simulator? Start from a calm idle desk.
      commit({ connected, override: null, live: connected ? get().live : [], approvals: connected ? get().approvals : [] });
    },

    applySnapshot: (sessions, reason, approvals = [], commands = []) => {
      commit({ live: sessions, approvals, commands, ...(reason === 'hook' ? { override: null } : {}) });
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
        model: SIM_MODELS[i % SIM_MODELS.length],
        permissionMode: SIM_MODES[i % SIM_MODES.length],
        gitBranch: i % 2 ? 'main' : `feat/${SIM_PROJECTS[i]}`,
        startSource: i % 3 ? 'startup' : 'resume',
      };
      commit({ simSats: [...sats, sat] });
    },

    clearSatellites: () => commit({ simSats: [] }),

    pin: (pinnedId) => commit({ pinnedId }),

    toggleMute: () => {
      const muted = !get().muted;
      setAudioEnabled(!muted);
      set({ muted });
    },

    setVoice: (voiceOn) => {
      writePref(PREF_VOICE, voiceOn ? 'on' : 'off');
      set({ voiceOn });
    },

    setVoiceLang: (voiceLang) => {
      writePref(PREF_LANG, voiceLang);
      set({ voiceLang });
    },

    setVoicePack: (voicePack) => set({ voicePack }),
    setStt: (sttAvailable) => {
      if (sttAvailable !== get().sttAvailable) set({ sttAvailable });
    },

    setListening: (listening) => set({ listening }),

    setClap: (clapOn) => {
      writePref(PREF_CLAP, clapOn ? 'on' : 'off');
      set({ clapOn });
    },

    setVoiceLab: (voiceLab) => {
      if (voiceLab !== get().voiceLab) set({ voiceLab });
    },

    setCaption: (text) => set({ caption: { id: (get().caption?.id ?? 0) + 1, text } }),
  };
});

export { isActive, MAX_SIM_SATELLITES };
