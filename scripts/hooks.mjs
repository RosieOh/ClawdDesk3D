#!/usr/bin/env node
// Install / uninstall the ClawdDesk hooks in ~/.claude/settings.json without touching anyone else's hooks.
//
//   node scripts/hooks.mjs install   [--port 3001] [--settings <path>] [--dry-run]
//   node scripts/hooks.mjs uninstall [--settings <path>] [--dry-run]
//   node scripts/hooks.mjs status    [--settings <path>]
//
// Our hooks are recognised by a marker: the `X-ClawdDesk` header on http hooks and a trailing
// `# clawddesk` comment on command hooks. Install is idempotent (it replaces our previous entries),
// and every write keeps a timestamped backup next to the settings file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_PATH = fileURLToPath(new URL('../hooks/claude-settings.hooks.json', import.meta.url));
const DEFAULT_PORT = 3001;

export function isOurs(hook) {
  if (!hook || typeof hook !== 'object') return false;
  if (hook.headers && typeof hook.headers === 'object' && 'X-ClawdDesk' in hook.headers) return true;
  return typeof hook.command === 'string' && hook.command.includes('# clawddesk');
}

/** Template hooks with the bridge port substituted. */
export function templateHooks(template, port = DEFAULT_PORT) {
  const text = JSON.stringify(template.hooks).replaceAll('127.0.0.1:3001', `127.0.0.1:${port}`);
  return JSON.parse(text);
}

/** Returns a copy of `settings` with every ClawdDesk hook removed (and nothing else changed). */
export function uninstallHooks(settings) {
  const out = structuredClone(settings);
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

/** Returns a copy of `settings` with the ClawdDesk hooks (re)installed after any existing ones. */
export function installHooks(settings, hooks) {
  const out = uninstallHooks(settings);
  out.hooks ??= {};
  for (const [event, groups] of Object.entries(hooks)) {
    out.hooks[event] = [...(out.hooks[event] ?? []), ...structuredClone(groups)];
  }
  return out;
}

export function installedEvents(settings) {
  return Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((g) => g?.hooks?.some?.(isOurs)))
    .map(([event]) => event);
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { command: argv[0], port: DEFAULT_PORT, settings: path.join(os.homedir(), '.claude', 'settings.json'), dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--settings') args.settings = argv[++i];
    else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port must be 1-65535');
  return args;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it first, nothing was changed`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.clawddesk-backup-${stamp}`;
    fs.copyFileSync(file, backup);
    console.log(`  backup  ${backup}`);
  }
  const tmp = `${file}.clawddesk-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const before = readSettings(args.settings);
  let after;

  switch (args.command) {
    case 'status': {
      const events = installedEvents(before);
      console.log(events.length ? `  installed for ${events.length} events: ${events.join(', ')}` : '  not installed');
      return;
    }
    case 'install': {
      const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
      after = installHooks(before, templateHooks(template, args.port));
      break;
    }
    case 'uninstall':
      after = uninstallHooks(before);
      break;
    default:
      console.log('usage: node scripts/hooks.mjs <install|uninstall|status> [--port N] [--settings PATH] [--dry-run]');
      process.exitCode = 1;
      return;
  }

  const was = installedEvents(before);
  const now = installedEvents(after);
  const foreign = Object.values(after.hooks ?? {})
    .flat()
    .flatMap((g) => g?.hooks ?? [])
    .filter((h) => !isOurs(h)).length;
  console.log(`  ${args.settings}`);
  console.log(`  ClawdDesk events: ${was.length} -> ${now.length}   (other hooks left untouched: ${foreign})`);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    console.log('  no change');
    return;
  }
  if (args.dryRun) {
    console.log('  dry run, nothing written');
    return;
  }
  writeSettings(args.settings, after);
  console.log(`  ${args.command === 'install' ? 'installed' : 'removed'}. New Claude Code sessions pick it up.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`  ✖ ${err.message}`);
    process.exitCode = 1;
  }
}
