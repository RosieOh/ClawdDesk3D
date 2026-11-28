import { useStore, type Approval, type DeskCommand, type Session } from './store';

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'ws://127.0.0.1:3001';
/** Same server over HTTP (ws → http, wss → https). */
export const BRIDGE_HTTP = BRIDGE_URL.replace(/^ws/, 'http');

/** Ask the bridge to run a task for Claude in a session's project folder. */
export async function sendCommand(
  text: string,
  sessionId: string,
): Promise<{ ok: true; id: string } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    });
    if (!res.ok) return { ok: false, status: res.status, message: await res.text() };
    return { ok: true, id: ((await res.json()) as { id: string }).id };
  } catch {
    return { ok: false, status: 0, message: 'bridge unreachable' };
  }
}

/** Answer a permission request held by the bridge. Resolves false if it already expired or failed. */
export async function decideApproval(id: string, behavior: 'allow' | 'deny'): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ behavior }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Connects to the hook bridge with exponential-backoff reconnect. Returns a disposer. */
export function connectBridge(): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: number | undefined;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    try {
      ws = new WebSocket(BRIDGE_URL);
    } catch {
      schedule();
      return;
    }

    ws.onopen = () => {
      retry = 0;
      useStore.getState().setConnected(true);
      sendPresence();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          reason: string;
          sessions: Session[];
          approvals?: Approval[];
          commands?: DeskCommand[];
          voiceLab?: { voice: string | null; ready: boolean; tts?: boolean; stt?: boolean } | null;
          user?: { present: boolean; since: number } | null;
        };
        if (msg.type !== 'snapshot') return;
        const s = useStore.getState();
        s.applySnapshot(msg.sessions, msg.reason, msg.approvals ?? [], msg.commands ?? []);
        // The bridge watches the local voice lab, so the page never probes it (and logs no refused connections).
        const lab = msg.voiceLab;
        s.setVoiceLab(lab?.ready && lab.tts !== false ? (lab.voice ?? 'my voice') : null);
        s.setStt(Boolean(lab?.stt));
        s.setUserPresent(msg.user ? msg.user.present : null);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      useStore.getState().setVoiceLab(null);
      useStore.getState().setStt(false);
      useStore.getState().setUserPresent(null);
      schedule();
    };
    ws.onerror = () => ws?.close();
  };

  const schedule = () => {
    if (disposed) return;
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    timer = window.setTimeout(open, delay);
  };

  // Tell the bridge whether this desk can answer permission requests right now: only while it's on screen,
  // so a forgotten background tab never makes Claude Code wait.
  // …and only while you're there: when the camera says you've stepped away, it stops taking them.
  const sendPresence = () => {
    if (ws?.readyState === WebSocket.OPEN) {
      const approvals = document.visibilityState === 'visible' && useStore.getState().userPresent !== false;
      ws.send(JSON.stringify({ type: 'presence', approvals }));
    }
  };
  document.addEventListener('visibilitychange', sendPresence);
  const unsubscribePresence = useStore.subscribe((s, prev) => {
    if (s.userPresent !== prev.userPresent) sendPresence();
  });

  open();
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', sendPresence);
    unsubscribePresence();
    window.clearTimeout(timer);
    if (ws) {
      const sock = ws;
      sock.onclose = null;
      sock.onmessage = null;
      sock.onerror = null;
      // Closing a socket that is still connecting logs a browser warning (React StrictMode mounts twice in dev),
      // so let it finish the handshake and close it then.
      if (sock.readyState === WebSocket.CONNECTING) sock.onopen = () => sock.close();
      else sock.close();
    }
  };
}
