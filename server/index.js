// ClawdDesk 3D — Claude Code hook bridge
// Receives Claude Code hook POSTs and broadcasts normalized session state over WebSocket.

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { ROUTE_EVENTS, createSessionStore, isAllowedOrigin, parseOriginList } from './core.js';

const PORT = Number(process.env.CLAWDDESK_PORT || process.env.PORT) || 3001;
const HOST = process.env.CLAWDDESK_HOST || '127.0.0.1'; // loopback only
const EXTRA_ORIGINS = parseOriginList(process.env.CLAWDDESK_ALLOWED_ORIGINS);
const SWEEP_INTERVAL_MS = 15 * 1000;

const store = createSessionStore();

function snapshot(reason) {
  return { type: 'snapshot', reason, serverTime: Date.now(), sessions: store.list() };
}

const originOk = (origin) => isAllowedOrigin(origin, EXTRA_ORIGINS);

// ---------------------------------------------------------------- HTTP

const app = express();

// Reject foreign browser origins *before* anything is parsed or processed.
// Hooks and curl send no Origin header, so they always pass.
app.use((req, res, next) => {
  if (originOk(req.get('origin'))) return next();
  console.warn(`[http] blocked origin ${req.get('origin')} ${req.method} ${req.path}`);
  res.status(403).end();
});
app.use(cors({ origin: (origin, cb) => cb(null, originOk(origin)) }));
app.use(express.json({ limit: '10mb', type: () => true }));

function handle(defaultEvent, req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const event = body.hook_event_name || defaultEvent;
  if (!event) return;
  const sessionId = req.get('x-session-id');
  const prev = store.get(body.session_id || sessionId || 'default')?.state;
  const s = store.apply(event, body, { entrypoint: req.get('x-claude-entrypoint'), sessionId });
  if (!s) return;
  const toolTag = s.tool ? ` (${s.tool}${s.running > 1 ? ` +${s.running - 1}` : ''})` : '';
  console.log(
    `[hook] ${event.padEnd(18)} ${s.project.padEnd(20)} ${prev ?? 'NEW'} -> ${s.state}${toolTag}  [${s.source}] ${s.id.slice(0, 8)}`,
  );
  broadcast(snapshot('hook'));
}

/**
 * Respond 200 with an empty body *first* (empty 2xx = "success, no decision"),
 * then process — Claude Code is never blocked by the visualizer.
 * The payload's hook_event_name wins over the route, so e.g. Notification posted to /hook/idle is handled correctly.
 */
const hook = (defaultEvent) => (req, res) => {
  res.status(200).end();
  try {
    handle(defaultEvent, req);
  } catch (err) {
    console.error('[hook] failed to process payload:', err);
  }
};

for (const [route, event] of Object.entries(ROUTE_EVENTS)) app.post(`/hook/${route}`, hook(event));
app.post('/hook', hook(undefined)); // generic: dispatch on hook_event_name only

app.get('/state', (_req, res) => res.json(snapshot('poll')));
app.get('/', (_req, res) =>
  res.json({ name: 'clawddesk-bridge', ok: true, sessions: store.size, ws: `ws://${HOST}:${PORT}` }),
);

// Malformed JSON or anything else: still 200 so hooks never error out.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.warn('[http] bad request ignored:', err?.message);
  if (!res.headersSent) res.status(200).end();
});

// ---------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => {
    if (originOk(origin)) return true;
    console.warn(`[ws] blocked origin ${origin}`);
    return false;
  },
});
wss.on('error', () => {}); // listen errors are reported by server.on('error') below

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});
  ws.send(JSON.stringify(snapshot('hello')));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

const sweeper = setInterval(() => {
  const removed = store.sweep();
  for (const s of removed) console.log(`[sweep] expired ${s.project} ${s.id.slice(0, 8)}`);
  if (removed.length) broadcast(snapshot('sweep'));
}, SWEEP_INTERVAL_MS);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  ✖ ${HOST}:${PORT} is already in use by another process.\n` +
        `    Free it, or run with CLAWDDESK_PORT=<port> and point your hook URLs + VITE_BRIDGE_URL at it.\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🦀 ClawdDesk bridge  http://${HOST}:${PORT}   ws://${HOST}:${PORT}\n`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
