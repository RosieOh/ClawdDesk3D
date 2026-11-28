import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installHooks, installedEvents, isOurs, templateHooks, uninstallHooks } from './hooks.mjs';

const template = JSON.parse(fs.readFileSync(new URL('../hooks/claude-settings.hooks.json', import.meta.url), 'utf8'));

const foreignSettings = () => ({
  model: 'opus',
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool pre' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop' }] }],
  },
  permissions: { allow: ['Bash(ls:*)'] },
});

test('every template hook carries the marker', () => {
  for (const groups of Object.values(template.hooks)) {
    for (const g of groups) for (const h of g.hooks) assert.ok(isOurs(h), JSON.stringify(h));
  }
});

test('install keeps foreign hooks and other settings, and appends ours', () => {
  const out = installHooks(foreignSettings(), templateHooks(template));
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(out.hooks.PreToolUse[0].hooks[0].command, 'other-tool pre', 'foreign hook stays first');
  assert.ok(out.hooks.PreToolUse.at(-1).hooks.every(isOurs));
  assert.deepEqual(installedEvents(out).sort(), Object.keys(template.hooks).sort());
});

test('install is idempotent', () => {
  const once = installHooks(foreignSettings(), templateHooks(template));
  const twice = installHooks(once, templateHooks(template));
  assert.deepEqual(twice, once);
});

test('uninstall restores the original settings exactly', () => {
  const original = foreignSettings();
  const out = uninstallHooks(installHooks(original, templateHooks(template)));
  assert.deepEqual(out, original);
});

test('uninstall drops the hooks key when only ours were there', () => {
  const out = uninstallHooks(installHooks({ theme: 'dark' }, templateHooks(template)));
  assert.deepEqual(out, { theme: 'dark' });
});

test('port is substituted everywhere', () => {
  const text = JSON.stringify(templateHooks(template, 3101));
  assert.ok(!text.includes(':3001'));
  assert.ok(text.includes('127.0.0.1:3101/hook'));
});

test('a group mixing ours with a foreign hook keeps the foreign one', () => {
  const settings = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine # clawddesk' }, { type: 'command', command: 'theirs' }] }] },
  };
  assert.deepEqual(uninstallHooks(settings), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } });
});
