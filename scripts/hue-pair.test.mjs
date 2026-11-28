import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listGroups, tryCreateUser, writeConfig } from './hue-pair.mjs';

/** A stand-in Hue bridge: refuses until "the button is pressed", then hands out a username. */
function fakeBridge() {
  let pressed = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api') {
        assert.equal(JSON.parse(body).devicetype, 'clawddesk#mac');
        res.end(JSON.stringify(pressed ? [{ success: { username: 'abc123' } }] : [{ error: { type: 101, description: 'link button not pressed' } }]));
      } else if (req.url === '/api/abc123/groups') {
        res.end(JSON.stringify({ 1: { name: 'Desk', type: 'Room' }, 2: { name: 'Office', type: 'Zone' } }));
      } else {
        res.statusCode = 404;
        res.end('[]');
      }
    });
  });
  return { server, press: () => (pressed = true) };
}

test('pairs once the link button is pressed and lists rooms', async () => {
  const { server, press } = fakeBridge();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await tryCreateUser(base), null, 'button not pressed yet');
    press();
    assert.equal(await tryCreateUser(base), 'abc123');
    assert.deepEqual(await listGroups(base, 'abc123'), [
      { id: '1', name: 'Desk', type: 'Room' },
      { id: '2', name: 'Office', type: 'Zone' },
    ]);
  } finally {
    server.close();
  }
});

test('config is written readable only by you', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hue-')), 'sub', 'hue.json');
  writeConfig({ bridge: '10.0.0.2', username: 'u', group: '1', brightness: 200 }, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).group, '1');
});
