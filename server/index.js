// ClawdDesk 3D — Claude Code hook bridge
// Receives Claude Code hook POSTs and broadcasts normalized session state over WebSocket.

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.CLAWDDESK_PORT || process.env.PORT) || 3001;
const HOST = process.env.CLAWDDESK_HOST || '127.0.0.1'; // loopback only
const STALE_MS = 10 * 60 * 1000; // drop sessions after 10 min of silence
const OFFLINE_LINGER_MS = 60 * 1000; // keep ended sessions visible for 1 min
const SWEEP_INTERVAL_MS = 15 * 1000;

/** @typedef {'OFFLINE'|'IDLE'|'GENERATING'|'TOOL_RUNNING'} AgentState */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} cwd
 * @property {string} project
 * @property {string} source        'vscode' | 'cli' | other entrypoint | 'unknown'
 * @property {AgentState} state
 * @property {string|null} tool     tool currently running (TOOL_RUNNING only)
 * @property {string|null} lastTool most recent tool seen
 * @property {string} lastEvent
 * @property {number} prompts
 * @property {number} startedAt
 * @property {number} lastSeen
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

// ---------------------------------------------------------------- helpers

function projectFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function normalizeSource(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (!v) return 'unknown';
  if (v.includes('vscode') || v.includes('cursor') || v.includes('windsurf')) return 'vscode';
  if (v.includes('jetbrains')) return 'jetbrains';
  if (v === 'cli') return 'cli';
  return v;
}

function shortToolName(name) {
  if (!name || typeof name !== 'string') return 'Tool';
  // mcp__server__tool_name -> tool_name
  if (name.startsWith('mcp__')) return name.split('__').pop() || name;
  return name;
}

function snapshot(reason) {
  return {
    type: 'snapshot',
    reason,
    serverTime: Date.now(),
    sessions: [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen),
  };
}

// ---------------------------------------------------------------- state transitions

/**
 * @param {AgentState} state
 * @param {any} body hook JSON payload
 * @param {import('express').Request} req
 */
function applyHook(state, body, req) {
  const payload = body && typeof body === 'object' ? body : {};
  const rawId = payload.session_id || req.get('x-session-id');
  if (!rawId && !payload.cwd) return; // nothing to attribute this to
  const id = String(rawId || 'default');
  const now = Date.now();

  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      cwd: '',
      project: 'unknown',
      source: 'unknown',
      state: 'IDLE',
      tool: null,
      lastTool: null,
      lastEvent: '',
      prompts: 0,
      startedAt: now,
      lastSeen: now,
    };
    sessions.set(id, s);
  }

  if (payload.cwd) {
    s.cwd = payload.cwd;
    s.project = projectFromCwd(payload.cwd);
  }
  const src = normalizeSource(req.get('x-claude-entrypoint') || payload.entrypoint);
  if (src !== 'unknown') s.source = src;

  const prev = s.state;
  s.state = state;
  s.lastSeen = now;
  s.lastEvent = payload.hook_event_name || state;

  if (state === 'TOOL_RUNNING') {
    s.tool = shortToolName(payload.tool_name);
    s.lastTool = s.tool;
  } else {
    s.tool = null;
  }

  if (state === 'GENERATING' && payload.hook_event_name !== 'PostToolUse' && prev !== 'GENERATING') {
    s.prompts += 1;
  }

  const toolTag = s.tool ? ` (${s.tool})` : '';
  console.log(
    `[hook] ${s.lastEvent.padEnd(16)} ${s.project.padEnd(20)} ${prev} -> ${state}${toolTag}  [${s.source}] ${id.slice(0, 8)}`,
  );

  broadcast(snapshot('hook'));
}

function sweep() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    const age = now - s.lastSeen;
    if (age > STALE_MS || (s.state === 'OFFLINE' && age > OFFLINE_LINGER_MS)) {
      sessions.delete(id);
      changed = true;
      console.log(`[sweep] expired ${s.project} ${id.slice(0, 8)}`);
    }
  }
  if (changed) broadcast(snapshot('sweep'));
}

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb', type: () => true }));

/**
 * Respond 200 with an empty body *first* (empty 2xx = "success, no decision"),
 * then process — Claude Code is never blocked by the visualizer.
 */
const hook = (state) => (req, res) => {
  res.status(200).end();
  try {
    applyHook(state, req.body, req);
  } catch (err) {
    console.error('[hook] failed to process payload:', err);
  }
};

app.post('/hook/session-start', hook('IDLE'));
app.post('/hook/generating', hook('GENERATING'));
app.post('/hook/tool-use', hook('TOOL_RUNNING'));
app.post('/hook/tool-done', hook('GENERATING')); // PostToolUse: back to thinking
app.post('/hook/idle', hook('IDLE'));
app.post('/hook/offline', hook('OFFLINE'));

// Generic endpoint: dispatch on hook_event_name.
const EVENT_MAP = {
  SessionStart: 'IDLE',
  UserPromptSubmit: 'GENERATING',
  PreToolUse: 'TOOL_RUNNING',
  PostToolUse: 'GENERATING',
  PostToolUseFailure: 'GENERATING',
  Stop: 'IDLE',
  StopFailure: 'IDLE',
  Notification: 'IDLE',
  SessionEnd: 'OFFLINE',
};
app.post('/hook', (req, res) => {
  res.status(200).end();
  try {
    const state = EVENT_MAP[req.body?.hook_event_name];
    if (state) applyHook(state, req.body, req);
  } catch (err) {
    console.error('[hook] failed to process payload:', err);
  }
});

app.get('/state', (_req, res) => res.json(snapshot('poll')));
app.get('/', (_req, res) =>
  res.json({ name: 'clawddesk-bridge', ok: true, sessions: sessions.size, ws: `ws://${HOST}:${PORT}` }),
);

// Malformed JSON or anything else: still 200 so hooks never error out.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.warn('[http] bad request ignored:', err?.message);
  if (!res.headersSent) res.status(200).end();
});

// ---------------------------------------------------------------- WebSocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
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

const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);

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
