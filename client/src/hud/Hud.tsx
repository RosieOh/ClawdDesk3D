import { useEffect, useRef, useState, type ReactNode } from 'react';
import { COMBO_WINDOW_MS, MAX_SIM_SATELLITES, useStore, type AgentState, type Session } from '../store';
import { branchLabel, permissionMode, prettyModel, shortId, sourceLabel, startLabel } from '../format';
import { STATE_HEX, stateHex } from '../scene/mix';
import { playUiClick } from '../audio';
import { cycleVoiceLang, toggleVoice } from '../voice/controls';
import { speech, speechSupported } from '../voice/speech';

const glass = 'bg-white/[0.07] backdrop-blur-md border border-white/[0.12] shadow-[0_8px_32px_rgba(0,0,0,0.35)] rounded-2xl';

const STATE_LABEL: Record<AgentState, string> = {
  OFFLINE: 'OFFLINE',
  IDLE: 'IDLE',
  WAITING: 'NEEDS YOU',
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

function Chip({ children, color, title }: { children: ReactNode; color?: string; title?: string }) {
  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-px font-mono text-[10px] leading-4"
      style={{ color: color ?? 'rgba(255,255,255,0.6)', borderColor: color ? `${color}55` : 'rgba(255,255,255,0.12)', background: color ? `${color}14` : 'transparent' }}
      title={title}
    >
      {children}
    </span>
  );
}

/** Which Claude Code session the desk is showing: id (click to copy), entrypoint, model, mode, branch. */
function SessionInfo({ session, pinned }: { session: Session; pinned: boolean }) {
  const pin = useStore((s) => s.pin);
  const [copied, setCopied] = useState(false);
  const model = prettyModel(session.model);
  const mode = permissionMode(session.permissionMode);
  const branch = branchLabel(session.gitBranch);
  const start = startLabel(session.startSource);

  const copy = () => {
    navigator.clipboard?.writeText(session.id).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-2.5" data-testid="session-info">
      <div className="flex items-center justify-between gap-2">
        <Label>Session{pinned ? ' · pinned' : ''}</Label>
        {pinned && (
          <button onClick={() => pin(null)} className="font-mono text-[10px] text-white/50 hover:text-white/90" title="Follow the most recently active session again">
            unpin ✕
          </button>
        )}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[13px]">
        <button onClick={copy} className="text-white/90 hover:text-white" title={`${session.id}\nclick to copy (claude --resume <id>)`}>
          {copied ? 'copied ✓' : shortId(session.id)}
        </button>
        <span className="text-white/30">·</span>
        <span className="text-white/70">{sourceLabel(session.source)}</span>
        {model && (
          <>
            <span className="text-white/30">·</span>
            <span className="truncate font-semibold text-white/90" title={session.model ?? undefined}>
              {model}
            </span>
          </>
        )}
      </div>
      {(mode || branch || start || session.claudeVersion) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {mode && (
            <Chip color={mode.color} title={`permission mode: ${session.permissionMode}`}>
              {mode.label}
            </Chip>
          )}
          {branch && <Chip title="git branch">⎇ {branch}</Chip>}
          {start && <Chip title="how the session began">{start}</Chip>}
          {session.claudeVersion && <Chip title="Claude Code version">v{session.claudeVersion}</Chip>}
        </div>
      )}
    </div>
  );
}

function StatusPanel() {
  const connected = useStore((s) => s.connected);
  const state = useStore((s) => s.state);
  const tool = useStore((s) => s.tool);
  const running = useStore((s) => s.running);
  const project = useStore((s) => s.project);
  const overridden = useStore((s) => s.override != null);
  const primary = useStore((s) => s.primary);
  const pinned = useStore((s) => s.pinnedId != null);
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

      {primary && <SessionInfo session={primary} pinned={pinned} />}

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
            {tool && running > 1 ? <span className="ml-1 opacity-70">+{running - 1}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Every known session; click one to pin it to the desk, click it again to unpin. */
function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const primaryId = useStore((s) => s.primaryId);
  const pinnedId = useStore((s) => s.pinnedId);
  const pin = useStore((s) => s.pin);
  if (sessions.length < 2) return null;

  return (
    <div className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-0.5" data-testid="session-list">
      {sessions.map((x) => {
        const shown = x.id === primaryId;
        const model = prettyModel(x.model);
        return (
          <button
            key={x.id}
            onClick={() => {
              playUiClick();
              pin(pinnedId === x.id ? null : x.id);
            }}
            className={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors ${shown ? 'bg-white/10 ring-1 ring-white/20' : 'hover:bg-white/5'}`}
            title={`${x.id}\n${x.cwd}\n${pinnedId === x.id ? 'click to unpin' : 'click to show on the desk'}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: stateHex(x.state, x.tool) }} />
              <span className={`truncate font-mono text-[11px] ${x.state === 'OFFLINE' ? 'text-white/40' : 'text-white/90'}`}>{x.project}</span>
              {pinnedId === x.id && <span className="ml-auto text-[10px]">📌</span>}
            </div>
            <div className="mt-0.5 truncate pl-3 font-mono text-[10px] text-white/45">
              {shortId(x.id)} · {sourceLabel(x.source)}
              {model ? ` · ${model}` : ''}
            </div>
          </button>
        );
      })}
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
  const toggleMute = useStore((s) => s.toggleMute);
  const voiceOn = useStore((s) => s.voiceOn);
  const voiceLang = useStore((s) => s.voiceLang);
  const voicePack = useStore((s) => s.voicePack);
  const canSpeak = speechSupported();

  const focus = focusAccum + (focusSince ? now - focusSince : 0);
  const comboLive = lastPromptAt > 0 && now - lastPromptAt < COMBO_WINDOW_MS ? combo : 0;
  const comboLeft = comboLive ? 1 - (now - lastPromptAt) / COMBO_WINDOW_MS : 0;

  return (
    <div className={`${glass} p-4 w-[min(260px,calc(100vw-32px))] pointer-events-auto`}>
      <div className="flex items-start justify-between">
        <div>
          <Label>Sessions</Label>
          <div className="mt-0.5 font-mono text-2xl font-bold text-white">{count}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={toggleMute}
            className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 font-mono text-[10px] tracking-wider text-white/70 hover:bg-white/10"
            title="Toggle sound effects (M)"
          >
            {muted ? '🔇 MUTED' : '🔊 SOUND'}
          </button>
          {canSpeak && (
            <div className="flex gap-1">
              <button
                onClick={toggleVoice}
                className={`rounded-lg border px-2 py-1 font-mono text-[10px] tracking-wider ${
                  voiceOn ? 'border-sky-300/40 bg-sky-300/15 text-sky-200' : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10'
                }`}
                title={voicePack ? `Spoken announcements (V) · voice pack: ${voicePack}` : 'Spoken announcements (V)'}
                data-testid="voice-toggle"
              >
                {voiceOn ? '🗣' : '🤐'} {voicePack ? voicePack.toUpperCase() : 'VOICE'}
              </button>
              <button
                onClick={cycleVoiceLang}
                className="rounded-lg border border-white/15 bg-white/5 px-1.5 py-1 font-mono text-[10px] tracking-wider text-white/70 hover:bg-white/10"
                title="Voice language"
              >
                {voiceLang.toUpperCase()}
              </button>
            </div>
          )}
        </div>
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
      <SessionList />
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
    { label: 'Waiting', key: '3', run: () => simulate('WAITING'), active: state === 'WAITING', color: STATE_HEX.WAITING },
    { label: 'Generating', key: '4', run: () => simulate('GENERATING'), active: state === 'GENERATING', color: STATE_HEX.GENERATING },
    { label: 'Tool: Edit', key: '5', run: () => simulate('TOOL_RUNNING', 'Edit'), active: state === 'TOOL_RUNNING' && tool === 'Edit', color: stateHex('TOOL_RUNNING', 'Edit') },
    { label: 'Tool: Bash', key: '6', run: () => simulate('TOOL_RUNNING', 'Bash'), active: state === 'TOOL_RUNNING' && tool === 'Bash', color: stateHex('TOOL_RUNNING', 'Bash') },
    {
      label: satCount >= MAX_SIM_SATELLITES ? 'Satellites full' : '+ Add Satellite',
      key: '7',
      run: addSatellite,
      active: false,
      color: '#ffffff',
    },
  ];

  // Register the shortcut listener once; it reads the latest actions through a ref.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      const a = actionsRef.current.find((x) => x.key === e.key);
      if (a) {
        playUiClick();
        a.run();
      }
      if (e.key === '0') clearSatellites();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSatellites]);

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

const CAPTION_MS = 6_000;

/** Subtitle for the latest announcement: always shown, spoken or not. */
function Caption() {
  const caption = useStore((s) => s.caption);
  const voiceOn = useStore((s) => s.voiceOn);
  const [visible, setVisible] = useState(false);
  const [talking, setTalking] = useState(false);

  useEffect(() => {
    if (!caption) return;
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), CAPTION_MS);
    return () => window.clearTimeout(id);
  }, [caption]);

  // Mirror the speech engine's state for the equaliser bars (cheap poll; the engine has no React binding).
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setTalking(speech.speaking > 0), 120);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!caption) return null;
  return (
    <div
      className={`${glass} pointer-events-none flex max-w-[min(560px,calc(100vw-32px))] items-center gap-2.5 px-3.5 py-2 transition-all duration-500 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      }`}
      role="status"
      aria-live="polite"
      data-testid="caption"
    >
      <span className="flex h-3 items-end gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`w-[3px] rounded-sm bg-sky-300 ${talking && voiceOn ? 'animate-pulse' : ''}`}
            style={{ height: talking && voiceOn ? `${[60, 100, 75][i]}%` : '35%', animationDelay: `${i * 120}ms` }}
          />
        ))}
      </span>
      <span className="font-mono text-[10px] font-bold tracking-[0.2em] text-sky-200/80">JARVIS</span>
      <span className="text-[13px] text-white/90">{caption.text}</span>
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
        <Caption />
        <div className="hidden font-mono text-[10px] tracking-widest text-white/30 sm:block">DRAG TO ORBIT · SCROLL TO ZOOM · 1–7 TO PLAY · M SOUND · V VOICE</div>
        <Dock />
      </div>
    </div>
  );
}
