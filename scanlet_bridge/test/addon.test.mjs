#!/usr/bin/env node
/*
 * Tests for the Home Assistant add-on entry point.
 *
 *   node home-assistant/test/addon.test.mjs
 *
 * Runs `scanlet_bridge/run.mjs` as a child process against the working copy of
 * the app, and drives both listeners over HTTP. No Docker needed — the same
 * entry point runs either way, which is the point of keeping it dependency-free.
 *
 * One thing this cannot cover: Home Assistant's own ingress proxy. The header it
 * sends is simulated, including the prefix both stripped and unstripped, which is
 * all the entry point can observe.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ENTRY = path.join(REPO, 'scanlet_bridge', 'run.mjs');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/** Grab a port the OS says is free, then let go of it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scanlet-addon-'));
  const optionsPath = path.join(workspace, 'options.json');
  const ingressPort = await freePort();
  const lanPort = await freePort();

  // Advertising is off, and the options file carries no secret: there is no
  // pairing code any more — the network is the boundary.
  fs.writeFileSync(optionsPath, JSON.stringify({ printers: [], advertise: false }));

  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      SCANLET_APP: REPO,
      SCANLET_OPTIONS: optionsPath,
      SCANLET_INGRESS_PORT: String(ingressPort),
      SCANLET_LAN_PORT: String(lanPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out starting:\n${output.join('')}`)), 20000);
    const poll = setInterval(() => {
      if (output.join('').includes('network API on port')) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
  });

  const lan = `http://127.0.0.1:${lanPort}`;
  const ingress = `http://127.0.0.1:${ingressPort}`;
  const INGRESS_PATH = '/api/hassio_ingress/abc123';

  try {
    await ready;

    await check('the add-on version and the image’s build stamp agree', () => {
      // The stamp is what stops Docker reusing a cached download of the app, so
      // forgetting to bump it ships the previous app while claiming a new version.
      const config = fs.readFileSync(path.join(REPO, 'scanlet_bridge', 'config.yaml'), 'utf8');
      const dockerfile = fs.readFileSync(path.join(REPO, 'scanlet_bridge', 'Dockerfile'), 'utf8');
      const version = /^version:\s*"?([0-9.]+)"?/m.exec(config)?.[1];
      const stamp = /^ARG SCANLET_BUILD=([0-9.]+)/m.exec(dockerfile)?.[1];
      assert.ok(version, 'config.yaml should declare a version');
      assert.equal(stamp, version, 'bump ARG SCANLET_BUILD with the add-on version');
      assert.match(dockerfile, /^ARG SCANLET_REF=/m, 'the app ref should be an explicit argument');
    });

    await check('the add-on starts both listeners', () => {
      assert.match(output.join(''), new RegExp(`network API on port ${lanPort}`));
      assert.match(output.join(''), new RegExp(`panel on port ${ingressPort}`));
    });

    await check('the network listener is open, with no pairing code', async () => {
      const health = await fetch(`${lan}/health`).then((response) => response.json());
      assert.equal(health.ok, true);
      assert.equal(health.requiresToken, undefined, 'there is no code to require');
      assert.equal(health.lan, true);

      const printers = await fetch(`${lan}/printers`);
      assert.equal(printers.status, 200);
      const body = await printers.json();
      assert.ok(Array.isArray(body.printers));
    });

    await check('an ingress request is served the app, with no code to seed', async () => {
      const response = await fetch(`${ingress}${INGRESS_PATH}/`, {
        headers: { 'x-ingress-path': INGRESS_PATH },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      assert.match(html, /Scanlet/, 'it should be the app shell');
      assert.ok(!html.includes('scanlet:bridge'), 'nothing is seeded — the app discovers the bridge itself');
    });

    await check('the same request with the prefix already stripped also works', async () => {
      const response = await fetch(`${ingress}/`, { headers: { 'x-ingress-path': INGRESS_PATH } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Scanlet/);
    });

    await check('a request without the ingress header is served just the same', async () => {
      const response = await fetch(`${ingress}/`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Scanlet/);
    });

    await check('the app’s own files are served through ingress', async () => {
      const response = await fetch(`${ingress}${INGRESS_PATH}/assets/js/app.js`, {
        headers: { 'x-ingress-path': INGRESS_PATH },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      await response.text();
    });

    await check('a scan URL with no printer names one, for a Shortcut', async () => {
      // No printer named, and none configured: this must be a clean error, not a
      // crash. It used to take the whole add-on down — the route returned a
      // promise that escaped its own try/catch.
      const unnamed = await fetch(`${lan}/scan.pdf`);
      assert.equal(unnamed.status, 502);
      const body = await unnamed.json();
      assert.match(body.error, /Name the printer/);

      const unreachable = await fetch(`${lan}/scan.pdf?printer=127.0.0.1:1`);
      assert.equal(unreachable.status, 502, 'an unreachable printer is a bad gateway, not a dead server');
      const detail = await unreachable.json();
      assert.match(detail.error, /No eSCL scanner answered/);
    });

    await check('the add-on is still serving after that failure', async () => {
      const health = await fetch(`${lan}/health`).then((response) => response.json());
      assert.equal(health.ok, true, 'the process must survive a failed scan');
      assert.equal(child.exitCode, null, 'and must not have exited');
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill('SIGKILL');
    fs.rmSync(workspace, { recursive: true, force: true });
  }

  let failed = 0;
  for (const result of results) {
    if (result.ok) console.log(`  ✓ ${result.name}`);
    else {
      failed++;
      console.log(`  ✗ ${result.name}\n      ${result.error.message}`);
    }
  }
  console.log('');
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
