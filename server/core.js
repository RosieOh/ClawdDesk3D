// ClawdDesk 3D — pure session state machine + origin policy (no I/O, unit-tested).

/** @typedef {'OFFLINE'|'IDLE'|'WAITING'|'GENERATING'|'TOOL_RUNNING'} AgentState */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} cwd
 * @property {string} project
 * @property {string} source        'vscode' | 'cli' | other entrypoint | 'unknown'
 * @property {AgentState} state
 * @property {string|null} tool     most recently started tool still running (TOOL_RUNNING only)
 * @property {number} running       number of tools currently in flight
 * @property {string|null} lastTool most recent tool seen
 * @property {string} lastEvent
 * @property {number} prompts
 * @property {number} startedAt
 * @property {number} lastSeen
 */

export const STALE_MS = 10 * 60 * 1000; // drop sessions after 10 min of silence
export const OFFLINE_LINGER_MS = 60 * 1000; // keep ended sessions visible for 1 min

/** Default event for each legacy route, used when the payload has no hook_event_name. */
export const ROUTE_EVENTS = {
  'session-start': 'SessionStart',
  generating: 'UserPromptSubmit',
  'tool-use': 'PreToolUse',
  'tool-done': 'PostToolUse',
  idle: 'Stop',
  offline: 'SessionEnd',
};

export const KNOWN_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
]);

// ---------------------------------------------------------------- helpers

export function projectFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function normalizeSource(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (!v) return 'unknown';
  if (v.includes('vscode') || v.includes('cursor') || v.includes('windsurf')) return 'vscode';
  if (v.includes('jetbrains')) return 'jetbrains';
  if (v === 'cli') return 'cli';
  return v;
}

export function shortToolName(name) {
  if (!name || typeof name !== 'string') return 'Tool';
  // mcp__server__tool_name -> tool_name
  if (name.startsWith('mcp__')) return name.split('__').pop() || name;
  return name;
}

/** Notifications that mean "Claude is blocked on the human" rather than "done". */
export function isAttentionNotification(payload) {
  const type = String(payload.notification_type || '');
  if (type === 'permission_prompt' || type === 'elicitation_dialog') return true;
  if (type) return false; // e.g. idle_prompt, auth_success
  return /permission|approve|approval/i.test(String(payload.message || ''));
}

// ---------------------------------------------------------------- origin policy

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Browser requests carry an Origin; Claude Code hooks and curl don't.
 * Only loopback pages (the dev client, any port) plus explicitly listed origins may talk to the bridge,
 * so an arbitrary website can neither read session paths over WebSocket nor fake hook events.
 * @param {string|undefined} origin
 * @param {string[]} [extra] additional exact origins allowed
 */
export function isAllowedOrigin(origin, extra = []) {
  if (origin === undefined || origin === '') return true;
  if (extra.includes(origin)) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal "null" origin
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname);
}

export function parseOriginList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- state machine

export function createSessionStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  /** per-session in-flight tools: tool_use_id -> short name (insertion-ordered) */
  /** @type {Map<string, Map<string, string>>} */
  const inflight = new Map();
  /** per-session pending compaction trigger ('auto' | 'manual') */
  const compacting = new Map();
  let seq = 0; // fallback keys for tool events that lack tool_use_id

  function getOrCreate(id, t) {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        cwd: '',
        project: 'unknown',
        source: 'unknown',
        state: 'IDLE',
        tool: null,
        running: 0,
        lastTool: null,
        lastEvent: '',
        prompts: 0,
        startedAt: t,
        lastSeen: t,
      };
      sessions.set(id, s);
      inflight.set(id, new Map());
    }
    return s;
  }

  function settleTools(s) {
    const tools = inflight.get(s.id);
    s.running = tools.size;
    if (tools.size > 0) {
      s.state = 'TOOL_RUNNING';
      s.tool = [...tools.values()].pop();
    } else {
      s.tool = null;
    }
  }

  /**
   * Apply one hook event. Returns the updated session, or null if the event was ignored.
   * @param {string} event hook_event_name
   * @param {any} payload hook JSON
   * @param {{ entrypoint?: string, sessionId?: string }} [meta] header-derived info
   */
  function apply(event, payload, meta = {}) {
    if (!KNOWN_EVENTS.has(event)) return null;
    const p = payload && typeof payload === 'object' ? payload : {};
    const rawId = p.session_id || meta.sessionId;
    if (!rawId && !p.cwd) return null; // nothing to attribute this to
    const id = String(rawId || 'default');
    const t = now();

    const s = getOrCreate(id, t);
    const tools = inflight.get(id);
    const prev = s.state;

    if (p.cwd) {
      s.cwd = p.cwd;
      s.project = projectFromCwd(p.cwd);
    }
    const src = normalizeSource(meta.entrypoint || p.entrypoint);
    if (src !== 'unknown') s.source = src;
    s.lastSeen = t;
    s.lastEvent = event;

    switch (event) {
      case 'SessionStart': {
        tools.clear();
        const trigger = compacting.get(id);
        compacting.delete(id);
        // After an auto-compaction mid-turn Claude keeps working; otherwise it waits for a prompt.
        s.state = p.source === 'compact' && trigger === 'auto' ? 'GENERATING' : 'IDLE';
        break;
      }
      case 'UserPromptSubmit':
        tools.clear();
        s.prompts += 1;
        s.state = 'GENERATING';
        break;
      case 'PreToolUse': {
        const name = shortToolName(p.tool_name);
        tools.set(String(p.tool_use_id || `${name}#${seq++}`), name);
        s.lastTool = name;
        s.state = 'TOOL_RUNNING';
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const key = p.tool_use_id && tools.has(String(p.tool_use_id)) ? String(p.tool_use_id) : findByName(tools, shortToolName(p.tool_name));
        if (key) tools.delete(key);
        s.state = 'GENERATING';
        break;
      }
      case 'Notification':
        if (isAttentionNotification(p)) s.state = 'WAITING';
        else if (tools.size === 0 && prev !== 'GENERATING') s.state = 'IDLE';
        break;
      case 'PreCompact':
        compacting.set(id, p.trigger === 'manual' ? 'manual' : 'auto');
        tools.clear();
        s.state = 'TOOL_RUNNING';
        s.tool = 'Compact';
        s.running = 0;
        return s;
      case 'SubagentStop':
        // The parent's Task tool is still in flight; its PostToolUse settles the state. Just a heartbeat.
        break;
      case 'Stop':
      case 'StopFailure':
        tools.clear();
        s.state = 'IDLE';
        break;
      case 'SessionEnd':
        tools.clear();
        compacting.delete(id);
        s.state = 'OFFLINE';
        break;
    }

    if (s.state === 'WAITING') {
      s.running = tools.size;
      s.tool = null;
    } else if (s.state !== 'IDLE' && s.state !== 'OFFLINE') {
      settleTools(s);
    } else {
      s.tool = null;
      s.running = 0;
    }
    return s;
  }

  function findByName(tools, name) {
    for (const [k, v] of tools) if (v === name) return k;
    return null;
  }

  /** Drop stale / long-ended sessions. Returns the removed sessions. */
  function sweep() {
    const t = now();
    const removed = [];
    for (const [id, s] of sessions) {
      const age = t - s.lastSeen;
      if (age > STALE_MS || (s.state === 'OFFLINE' && age > OFFLINE_LINGER_MS)) {
        sessions.delete(id);
        inflight.delete(id);
        compacting.delete(id);
        removed.push(s);
      }
    }
    return removed;
  }

  function list() {
    return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  return { apply, sweep, list, get: (id) => sessions.get(String(id)), get size() { return sessions.size; } };
}
