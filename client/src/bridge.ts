import { useStore, type Approval, type Session } from './store';

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'ws://127.0.0.1:3001';
/** Same server over HTTP (ws → http, wss → https). */
export const BRIDGE_HTTP = BRIDGE_URL.replace(/^ws/, 'http');

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
          voiceLab?: { voice: string; ready: boolean } | null;
        };
        if (msg.type !== 'snapshot') return;
        const s = useStore.getState();
        s.applySnapshot(msg.sessions, msg.reason, msg.approvals ?? []);
        // The bridge watches the local voice lab, so the page never probes it (and logs no refused connections).
        s.setVoiceLab(msg.voiceLab?.ready ? msg.voiceLab.voice : null);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      useStore.getState().setVoiceLab(null);
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
  const sendPresence = () => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'presence', approvals: document.visibilityState === 'visible' }));
    }
  };
  document.addEventListener('visibilitychange', sendPresence);

  open();
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', sendPresence);
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
