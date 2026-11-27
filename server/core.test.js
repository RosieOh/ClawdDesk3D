import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_LINGER_MS,
  STALE_MS,
  createSessionStore,
  isAllowedOrigin,
  isAttentionNotification,
  projectFromCwd,
  shortToolName,
} from './core.js';

const SID = 'sess-1';
const base = { session_id: SID, cwd: '/Users/me/dev/my-app' };

function setup() {
  let t = 1_000;
  const store = createSessionStore({ now: () => t });
  const fire = (event, extra = {}, meta) => store.apply(event, { ...base, hook_event_name: event, ...extra }, meta);
  return { store, fire, advance: (ms) => (t += ms) };
}

test('basic lifecycle', () => {
  const { fire } = setup();
  assert.equal(fire('SessionStart').state, 'IDLE');
  const s = fire('UserPromptSubmit');
  assert.equal(s.state, 'GENERATING');
  assert.equal(s.prompts, 1);
  assert.equal(s.project, 'my-app');
  assert.equal(fire('PreToolUse', { tool_name: 'Read', tool_use_id: 'a' }).state, 'TOOL_RUNNING');
  assert.equal(fire('PostToolUse', { tool_name: 'Read', tool_use_id: 'a' }).state, 'GENERATING');
  assert.equal(fire('Stop').state, 'IDLE');
  assert.equal(fire('SessionEnd').state, 'OFFLINE');
});

test('parallel tools stay TOOL_RUNNING until the last one finishes', () => {
  const { fire } = setup();
  fire('UserPromptSubmit');
  fire('PreToolUse', { tool_name: 'Read', tool_use_id: 'a' });
  let s = fire('PreToolUse', { tool_name: 'Grep', tool_use_id: 'b' });
  assert.equal(s.running, 2);
  assert.equal(s.tool, 'Grep');

  s = fire('PostToolUse', { tool_name: 'Grep', tool_use_id: 'b' });
  assert.equal(s.state, 'TOOL_RUNNING');
  assert.equal(s.tool, 'Read');
  assert.equal(s.running, 1);

  s = fire('PostToolUseFailure', { tool_name: 'Read', tool_use_id: 'a' });
  assert.equal(s.state, 'GENERATING');
  assert.equal(s.tool, null);
  assert.equal(s.running, 0);
});

test('tool events without tool_use_id fall back to matching by name', () => {
  const { fire } = setup();
  fire('PreToolUse', { tool_name: 'Bash' });
  fire('PreToolUse', { tool_name: 'Read' });
  const s = fire('PostToolUse', { tool_name: 'Bash' });
  assert.equal(s.state, 'TOOL_RUNNING');
  assert.equal(s.tool, 'Read');
});

test('PreToolUse without a prior prompt still shows the tool', () => {
  const { fire } = setup();
  fire('SessionStart');
  const s = fire('PreToolUse', { tool_name: 'mcp__github__create_issue', tool_use_id: 'x' });
  assert.equal(s.state, 'TOOL_RUNNING');
  assert.equal(s.tool, 'create_issue');
});

test('Stop clears dangling tools (e.g. a denied permission never gets PostToolUse)', () => {
  const { fire } = setup();
  fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'a' });
  fire('Stop');
  assert.equal(fire('UserPromptSubmit').state, 'GENERATING');
});

test('permission notification -> WAITING, approval resumes', () => {
  const { fire } = setup();
  fire('UserPromptSubmit');
  fire('PreToolUse', { tool_name: 'Bash', tool_use_id: 'a' });
  let s = fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(s.state, 'WAITING');
  assert.equal(s.tool, null);
  s = fire('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a' });
  assert.equal(s.state, 'GENERATING');
});

test('idle notification does not interrupt a running turn', () => {
  const { fire } = setup();
  fire('UserPromptSubmit');
  assert.equal(fire('Notification', { notification_type: 'idle_prompt' }).state, 'GENERATING');
  fire('Stop');
  assert.equal(fire('Notification', { notification_type: 'idle_prompt' }).state, 'IDLE');
});

test('PreCompact shows Compact; auto-compaction resumes generating, manual returns to idle', () => {
  const { fire } = setup();
  fire('UserPromptSubmit');
  let s = fire('PreCompact', { trigger: 'auto' });
  assert.equal(s.state, 'TOOL_RUNNING');
  assert.equal(s.tool, 'Compact');
  assert.equal(fire('SessionStart', { source: 'compact' }).state, 'GENERATING');

  fire('Stop');
  fire('PreCompact', { trigger: 'manual' });
  s = fire('SessionStart', { source: 'compact' });
  assert.equal(s.state, 'IDLE');
});

test('SubagentStop is only a heartbeat', () => {
  const { fire, advance } = setup();
  fire('PreToolUse', { tool_name: 'Task', tool_use_id: 't' });
  advance(5_000);
  const s = fire('SubagentStop');
  assert.equal(s.state, 'TOOL_RUNNING');
  assert.equal(s.tool, 'Task');
  assert.equal(s.lastSeen, 6_000);
});

test('entrypoint header normalizes source', () => {
  const { fire } = setup();
  assert.equal(fire('SessionStart', {}, { entrypoint: 'claude-vscode' }).source, 'vscode');
  assert.equal(fire('Stop', {}, { entrypoint: 'cli' }).source, 'cli');
  assert.equal(fire('Stop').source, 'cli', 'missing header keeps the last known source');
});

test('unknown events and unattributable payloads are ignored', () => {
  const { store } = setup();
  assert.equal(store.apply('Bogus', base), null);
  assert.equal(store.apply('Stop', { hook_event_name: 'Stop' }), null);
  assert.equal(store.size, 0);
});

test('sweep expires stale and ended sessions', () => {
  const { store, fire, advance } = setup();
  fire('SessionStart');
  store.apply('SessionEnd', { session_id: 'other', cwd: '/x' });
  advance(OFFLINE_LINGER_MS + 1);
  assert.deepEqual(store.sweep().map((s) => s.id), ['other']);
  advance(STALE_MS);
  assert.deepEqual(store.sweep().map((s) => s.id), [SID]);
  assert.equal(store.size, 0);
});

test('isAllowedOrigin', () => {
  assert.equal(isAllowedOrigin(undefined), true, 'hooks / curl send no Origin');
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4173'), true);
  assert.equal(isAllowedOrigin('http://[::1]:5173'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('http://localhost.evil.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
  assert.equal(isAllowedOrigin('file://'), false);
  assert.equal(isAllowedOrigin('https://desk.example', ['https://desk.example']), true);
});

test('helpers', () => {
  assert.equal(projectFromCwd('C:\\code\\proj\\'), 'proj');
  assert.equal(projectFromCwd(''), 'unknown');
  assert.equal(shortToolName(undefined), 'Tool');
  assert.equal(isAttentionNotification({ message: 'Claude needs your permission to use Bash' }), true);
  assert.equal(isAttentionNotification({ message: 'Claude is waiting for your input' }), false);
});
