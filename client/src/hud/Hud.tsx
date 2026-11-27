import { useEffect, useState, type ReactNode } from 'react';
import { COMBO_WINDOW_MS, MAX_SIM_SATELLITES, useStore, type AgentState } from '../store';
import { STATE_HEX, stateHex } from '../scene/mix';
import { playUiClick, setAudioEnabled } from '../audio';

const glass = 'bg-white/[0.07] backdrop-blur-md border border-white/[0.12] shadow-[0_8px_32px_rgba(0,0,0,0.35)] rounded-2xl';

const STATE_LABEL: Record<AgentState, string> = {
  OFFLINE: 'OFFLINE',
  IDLE: 'IDLE',
  GENERATING: 'GENERATING',
  TOOL_RUNNING: 'TOOL RUNNING',
};

function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [interval]);
  return now;
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h, m, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-mono tracking-[0.18em] text-white/45 uppercase">{children}</div>;
}

function StatusPanel() {
  const connected = useStore((s) => s.connected);
  const state = useStore((s) => s.state);
  const tool = useStore((s) => s.tool);
  const project = useStore((s) => s.project);
  const overridden = useStore((s) => s.override != null);
  const color = stateHex(state, tool);

  return (
    <div className={`${glass} p-4 w-[min(300px,calc(100vw-32px))] pointer-events-auto`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] font-bold tracking-[0.2em] text-white/85">CLAWDDESK·3D</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${
            connected ? 'bg-emerald-400/15 text-emerald-300' : 'bg-amber-400/15 text-amber-300'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          {connected ? 'WS CONNECTED' : 'SIMULATOR MODE'}
        </span>
      </div>

      <div className="mt-4">
        <Label>State{overridden && connected ? ' · manual' : ''}</Label>
        <div className="mt-1 flex items-center gap-2 font-mono text-lg font-bold tracking-wide" style={{ color }}>
          <span className="relative flex h-2.5 w-2.5">
            {state !== 'OFFLINE' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: color }} />}
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          </span>
          {STATE_LABEL[state]}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
        <div className="min-w-0">
          <Label>Project</Label>
          <div className="mt-0.5 truncate font-mono text-sm text-white/90" title={project}>
            {project}
          </div>
        </div>
        <div className="text-right">
          <Label>Tool</Label>
          <div
            className={`mt-0.5 inline-block rounded-md px-2 py-0.5 font-mono text-xs font-semibold transition-opacity ${tool ? 'opacity-100' : 'opacity-30'}`}
            style={{ background: tool ? `${color}22` : 'rgba(255,255,255,0.06)', color: tool ? color : '#fff' }}
          >
            {tool ?? '—'}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatsPanel() {
  const now = useNow();
  const count = useStore((s) => s.sessionCount);
  const sources = useStore((s) => s.sources);
  const connected = useStore((s) => s.connected);
  const focusAccum = useStore((s) => s.focusAccum);
  const focusSince = useStore((s) => s.focusSince);
  const combo = useStore((s) => s.combo);
  const lastPromptAt = useStore((s) => s.lastPromptAt);
  const muted = useStore((s) => s.muted);
  const setMuted = useStore((s) => s.setMuted);

  const focus = focusAccum + (focusSince ? now - focusSince : 0);
  const comboLive = lastPromptAt > 0 && now - lastPromptAt < COMBO_WINDOW_MS ? combo : 0;
  const comboLeft = comboLive ? 1 - (now - lastPromptAt) / COMBO_WINDOW_MS : 0;

  const toggleMute = () => {
    setAudioEnabled(muted);
    setMuted(!muted);
  };

  return (
    <div className={`${glass} p-4 w-[min(240px,calc(100vw-32px))] pointer-events-auto`}>
      <div className="flex items-start justify-between">
        <div>
          <Label>Sessions</Label>
          <div className="mt-0.5 font-mono text-2xl font-bold text-white">{count}</div>
        </div>
        <button
          onClick={toggleMute}
          className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 font-mono text-[10px] tracking-wider text-white/70 hover:bg-white/10"
          title="Toggle sound (M)"
        >
          {muted ? '🔇 MUTED' : '🔊 SOUND'}
        </button>
      </div>
      <div className="mt-1 font-mono text-[11px] text-white/55">
        {connected ? (
          <>
            VSCode {sources.vscode} · CLI {sources.cli}
            {sources.other ? ` · other ${sources.other}` : ''}
          </>
        ) : (
          'simulated'
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <Label>Focus</Label>
          <div className="mt-0.5 font-mono text-sm tabular-nums text-white/90">{fmt(focus)}</div>
        </div>
        <div>
          <Label>Combo</Label>
          <div className="mt-0.5 font-mono text-sm font-bold" style={{ color: comboLive >= 3 ? '#ff7a2f' : 'rgba(255,255,255,0.9)' }}>
            ×{comboLive}
            {comboLive >= 5 ? ' 🔥' : ''}
          </div>
        </div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-orange-500 transition-[width] duration-1000" style={{ width: `${comboLeft * 100}%` }} />
      </div>
    </div>
  );
}

interface DockAction {
  label: string;
  key: string;
  run: () => void;
  active: boolean;
  color: string;
}

function Dock() {
  const state = useStore((s) => s.state);
  const tool = useStore((s) => s.tool);
  const simulate = useStore((s) => s.simulate);
  const addSatellite = useStore((s) => s.addSatellite);
  const clearSatellites = useStore((s) => s.clearSatellites);
  const satCount = useStore((s) => s.simSats.length);

  const actions: DockAction[] = [
    { label: 'Offline', key: '1', run: () => simulate('OFFLINE'), active: state === 'OFFLINE', color: STATE_HEX.OFFLINE },
    { label: 'Idle', key: '2', run: () => simulate('IDLE'), active: state === 'IDLE', color: STATE_HEX.IDLE },
    { label: 'Generating', key: '3', run: () => simulate('GENERATING'), active: state === 'GENERATING', color: STATE_HEX.GENERATING },
    { label: 'Tool: Edit', key: '4', run: () => simulate('TOOL_RUNNING', 'Edit'), active: state === 'TOOL_RUNNING' && tool === 'Edit', color: stateHex('TOOL_RUNNING', 'Edit') },
    { label: 'Tool: Bash', key: '5', run: () => simulate('TOOL_RUNNING', 'Bash'), active: state === 'TOOL_RUNNING' && tool === 'Bash', color: stateHex('TOOL_RUNNING', 'Bash') },
    {
      label: satCount >= MAX_SIM_SATELLITES ? 'Satellites full' : '+ Add Satellite',
      key: '6',
      run: addSatellite,
      active: false,
      color: '#ffffff',
    },
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      const a = actions.find((x) => x.key === e.key);
      if (a) {
        playUiClick();
        a.run();
      }
      if (e.key === '0') clearSatellites();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className={`${glass} pointer-events-auto flex max-w-[calc(100vw-32px)] flex-wrap items-center justify-center gap-1.5 p-2`}>
      {actions.map((a) => (
        <button
          key={a.label}
          onClick={() => {
            playUiClick();
            a.run();
          }}
          className={`group relative rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold tracking-wide transition-all active:translate-y-px ${
            a.active ? 'border-transparent text-black shadow-[0_0_18px_var(--c)]' : 'border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/10'
          }`}
          style={{ ['--c' as string]: `${a.color}88`, background: a.active ? a.color : undefined }}
        >
          <span className="mr-1.5 hidden rounded bg-black/20 px-1 text-[9px] text-current opacity-60 sm:inline">{a.key}</span>
          {a.label}
        </button>
      ))}
      {satCount > 0 && (
        <button
          onClick={() => {
            playUiClick();
            clearSatellites();
          }}
          className="rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-2 font-mono text-[11px] text-white/60 hover:bg-white/10"
          title="Remove simulated satellites (0)"
        >
          ✕ {satCount}
        </button>
      )}
    </div>
  );
}

export function Hud() {
  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StatusPanel />
        <StatsPanel />
      </div>
      <div className="flex flex-col items-center gap-2">
        <div className="hidden font-mono text-[10px] tracking-widest text-white/30 sm:block">DRAG TO ORBIT · SCROLL TO ZOOM · 1–6 TO PLAY · M TO MUTE</div>
        <Dock />
      </div>
    </div>
  );
}
