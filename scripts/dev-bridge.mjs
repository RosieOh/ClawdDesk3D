#!/usr/bin/env node
// Dev runner for the Rust bridge: builds, runs, and rebuilds + restarts on changes under server/.
// A failed build keeps the previous bridge running, so the client stays connected while you fix it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = path.join(ROOT, 'server');
const MANIFEST = path.join(SERVER, 'Cargo.toml');
const BINARY = path.join(SERVER, 'target', 'debug', process.platform === 'win32' ? 'clawddesk-bridge.exe' : 'clawddesk-bridge');
const WATCH = [path.join(SERVER, 'src'), MANIFEST];
const DEBOUNCE_MS = 250;

let child = null;
let building = false;
let pending = false;
let timer = null;
let shuttingDown = false;

const log = (msg) => console.log(`[dev-bridge] ${msg}`);

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
    p.on('error', (err) => {
      log(`${cmd} failed to start: ${err.message}`);
      resolve(1);
    });
  });
}

function stop() {
  if (!child || child.exitCode !== null) return Promise.resolve();
  const proc = child;
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
  });
}

function start() {
  child = spawn(BINARY, [], { stdio: 'inherit', env: process.env });
  const proc = child;
  proc.on('exit', (code, signal) => {
    if (proc === child && !shuttingDown && !building && signal !== 'SIGTERM') {
      log(`bridge exited (${signal ?? code}); waiting for changes`);
    }
  });
}

async function rebuild() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  do {
    pending = false;
    const code = await run('cargo', ['build', '--quiet', '--manifest-path', MANIFEST]);
    if (shuttingDown) break;
    if (code !== 0) {
      log(child ? 'build failed; the previous bridge keeps running' : 'build failed; fix it and save to retry');
      continue;
    }
    const restarting = Boolean(child && child.exitCode === null);
    await stop();
    start();
    if (restarting) log('restarted');
  } while (pending);
  building = false;
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, DEBOUNCE_MS);
}

for (const target of WATCH) {
  fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, (_event, file) => {
    if (!file || file.endsWith('.rs') || file.endsWith('Cargo.toml') || target === MANIFEST) schedule();
  });
}

async function shutdown() {
  shuttingDown = true;
  await stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

rebuild();
