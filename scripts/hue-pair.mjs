#!/usr/bin/env node
// Pair ClawdDesk with a Philips Hue bridge so the room lights follow the desk.
//
//   npm run hue:pair [-- --ip 192.168.0.10] [--group <id>]
//
// Finds the bridge (Philips' discovery service, or --ip), asks you to press its link button, creates a
// ClawdDesk user and writes ~/.config/clawddesk/hue.json (only readable by you). Restart the bridge after.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_PATH = process.env.CLAWDDESK_HUE_CONFIG || path.join(os.homedir(), '.config', 'clawddesk', 'hue.json');
const DISCOVERY = 'https://discovery.meethue.com/';
const DEVICE_TYPE = 'clawddesk#mac';

export async function discover(fetchImpl = fetch) {
  const res = await fetchImpl(DISCOVERY, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`discovery failed (${res.status})`);
  const list = await res.json();
  return list.map((b) => b.internalipaddress).filter(Boolean);
}

/** One attempt to create a user. Returns the username, or null while the link button isn't pressed. */
export async function tryCreateUser(base, fetchImpl = fetch) {
  const res = await fetchImpl(`${base}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicetype: DEVICE_TYPE }),
    signal: AbortSignal.timeout(4000),
  });
  const body = await res.json();
  const first = Array.isArray(body) ? body[0] : body;
  if (first?.success?.username) return first.success.username;
  if (first?.error?.type === 101) return null; // link button not pressed
  throw new Error(first?.error?.description ?? `unexpected answer: ${JSON.stringify(body)}`);
}

export async function listGroups(base, username, fetchImpl = fetch) {
  const res = await fetchImpl(`${base}/api/${username}/groups`, { signal: AbortSignal.timeout(4000) });
  const groups = await res.json();
  return Object.entries(groups).map(([id, g]) => ({ id, name: g.name, type: g.type }));
}

export function writeConfig(config, file = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let ip = arg('--ip');
  if (!ip) {
    console.log('  looking for a Hue bridge (discovery.meethue.com)…');
    const found = await discover();
    if (!found.length) throw new Error('no bridge found; pass --ip <address> (Hue app › Settings › Bridges)');
    ip = found[0];
  }
  const base = `http://${ip}`;
  console.log(`  bridge ${ip}: press its round link button now (waiting up to 30 s)…`);
  let username = null;
  for (let i = 0; i < 15 && !username; i++) {
    username = await tryCreateUser(base);
    if (!username) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!username) throw new Error('the link button was not pressed in time; run it again');
  const groups = await listGroups(base, username);
  const group = arg('--group') ?? '0';
  writeConfig({ bridge: ip, username, group, brightness: 200 });
  console.log(`  ✓ paired. wrote ${CONFIG_PATH} (group ${group}${group === '0' ? ' = all lights' : ''})`);
  if (groups.length) {
    console.log('    rooms / zones (use one with --group <id>):');
    for (const g of groups) console.log(`      ${g.id.padStart(3)}  ${g.name} (${g.type})`);
  }
  console.log('    restart the bridge (or ClawdDesk) to start following the desk.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`  ✖ ${err.message}`);
    process.exitCode = 1;
  });
}
