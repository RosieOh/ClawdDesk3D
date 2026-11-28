import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Web Audio doesn't exist under Node; the store only needs to call it.
vi.mock('./audio', () => ({ setAudioEnabled: vi.fn() }));

import { setAudioEnabled } from './audio';
import { COMBO_WINDOW_MS, useStore, type AgentState, type Session } from './store';

const initial = useStore.getState();
const T0 = 1_800_000_000_000;

function session(id: string, state: AgentState, lastSeen: number, extra: Partial<Session> = {}): Session {
  return { id, cwd: `/dev/${id}`, project: id, source: 'cli', state, tool: null, startedAt: 0, lastSeen, ...extra };
}

/** Go live and push one hook snapshot with the primary session in `state`. */
function live(state: AgentState, extra: Partial<Session> = {}) {
  const s = useStore.getState();
  if (!s.connected) s.setConnected(true);
  useStore.getState().applySnapshot([session('main', state, Date.now(), extra)], 'hook');
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useStore.setState(initial, true);
});
afterEach(() => vi.useRealTimers());

describe('derived view', () => {
  it('starts in simulator mode with one idle session', () => {
    const s = useStore.getState();
    expect(s.connected).toBe(false);
    expect(s.state).toBe('IDLE');
    expect(s.sessionCount).toBe(1);
  });

  it('picks the most recent non-offline session as primary, the rest become satellites', () => {
    useStore.getState().setConnected(true);
    useStore.getState().applySnapshot(
      [
        session('ended', 'OFFLINE', 300),
        session('busy', 'TOOL_RUNNING', 200, { tool: 'Bash', running: 2, source: 'vscode' }),
        session('quiet', 'IDLE', 100),
      ],
      'hook',
    );
    const s = useStore.getState();
    expect(s.primaryId).toBe('busy');
    expect(s.state).toBe('TOOL_RUNNING');
    expect(s.tool).toBe('Bash');
    expect(s.running).toBe(2);
    expect(s.satellites.map((x) => x.id)).toEqual(['quiet']);
    expect(s.sessionCount).toBe(2);
    expect(s.sources).toEqual({ vscode: 1, cli: 1, other: 0 });
  });

  it('shows OFFLINE when every session has ended', () => {
    useStore.getState().setConnected(true);
    useStore.getState().applySnapshot([session('a', 'OFFLINE', 1)], 'hook');
    expect(useStore.getState().state).toBe('OFFLINE');
  });

  it('a dock override wins until the next hook, but survives polls and sweeps', () => {
    live('GENERATING');
    useStore.getState().simulate('TOOL_RUNNING', 'Edit');
    expect(useStore.getState().state).toBe('TOOL_RUNNING');
    useStore.getState().applySnapshot(useStore.getState().live, 'sweep');
    expect(useStore.getState().tool).toBe('Edit');
    useStore.getState().applySnapshot(useStore.getState().live, 'hook');
    expect(useStore.getState().state).toBe('GENERATING');
  });

  it('dropping the connection returns to a calm simulator desk', () => {
    live('GENERATING');
    useStore.getState().setConnected(false);
    const s = useStore.getState();
    expect(s.live).toEqual([]);
    expect(s.state).toBe('IDLE');
  });
});

describe('combo', () => {
  it('counts prompts that start from rest within the window', () => {
    live('IDLE');
    live('GENERATING');
    expect(useStore.getState().combo).toBe(1);
    live('IDLE');
    advance(60_000);
    live('GENERATING');
    expect(useStore.getState().combo).toBe(2);
  });

  it('resets after the window expires', () => {
    live('IDLE');
    live('GENERATING');
    live('IDLE');
    advance(COMBO_WINDOW_MS + 1);
    live('GENERATING');
    expect(useStore.getState().combo).toBe(1);
  });

  it('resuming after a permission prompt is the same turn', () => {
    live('IDLE');
    live('GENERATING');
    live('WAITING');
    live('GENERATING');
    expect(useStore.getState().combo).toBe(1);
  });

  it('a manual override in live mode does not count', () => {
    live('IDLE');
    useStore.getState().simulate('GENERATING');
    expect(useStore.getState().combo).toBe(0);
  });
});

describe('focus time', () => {
  it('accumulates while generating or running tools, not while waiting', () => {
    live('IDLE');
    live('GENERATING');
    advance(10_000);
    live('TOOL_RUNNING', { tool: 'Read' });
    advance(5_000);
    live('WAITING');
    advance(60_000);
    live('GENERATING');
    advance(1_000);
    live('IDLE');
    expect(useStore.getState().focusAccum).toBe(16_000);
    expect(useStore.getState().focusSince).toBeNull();
  });

  it('ignores a manual override in live mode', () => {
    live('IDLE');
    useStore.getState().simulate('GENERATING');
    advance(30_000);
    useStore.getState().simulate('IDLE');
    expect(useStore.getState().focusAccum).toBe(0);
  });

  it('counts in simulator mode so the demo shows numbers', () => {
    useStore.getState().simulate('GENERATING');
    advance(4_000);
    useStore.getState().simulate('IDLE');
    expect(useStore.getState().focusAccum).toBe(4_000);
  });
});

describe('satellites and sound', () => {
  it('caps simulated satellites', () => {
    for (let i = 0; i < 10; i++) useStore.getState().addSatellite();
    expect(useStore.getState().simSats).toHaveLength(6);
    useStore.getState().clearSatellites();
    expect(useStore.getState().simSats).toHaveLength(0);
  });

  it('toggleMute flips the flag and the audio output together', () => {
    expect(useStore.getState().muted).toBe(true);
    useStore.getState().toggleMute();
    expect(useStore.getState().muted).toBe(false);
    expect(setAudioEnabled).toHaveBeenLastCalledWith(true);
    useStore.getState().toggleMute();
    expect(setAudioEnabled).toHaveBeenLastCalledWith(false);
  });
});
