import { useStore, type Session } from './store';

const BRIDGE_URL: string =
  (import.meta.env.VITE_BRIDGE_URL as string | undefined) ?? 'ws://127.0.0.1:3001';

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
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; reason: string; sessions: Session[] };
        if (msg.type === 'snapshot') useStore.getState().applySnapshot(msg.sessions, msg.reason);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      schedule();
    };
    ws.onerror = () => ws?.close();
  };

  const schedule = () => {
    if (disposed) return;
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    timer = window.setTimeout(open, delay);
  };

  open();
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  };
}
