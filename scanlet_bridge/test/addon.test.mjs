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

  // A configured code, so the test can assert the exact string end up in the
  // seeded page rather than reading it back out of the log.
  const token = 'addon-test-code';
  fs.writeFileSync(optionsPath, JSON.stringify({ token, printers: [], advertise: false }));

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

    await check('the network listener needs the pairing code', async () => {
      const health = await fetch(`${lan}/health`).then((response) => response.json());
      assert.equal(health.ok, true);
      assert.equal(health.requiresToken, true);
      assert.equal(health.paired, false, 'an unpaired probe should be told so');

      const refused = await fetch(`${lan}/printers`);
      assert.equal(refused.status, 401);
      await refused.json();
    });

    await check('the network listener accepts the code', async () => {
      const response = await fetch(`${lan}/printers`, { headers: { 'x-scanlet-token': token } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(Array.isArray(body.printers));
    });

    await check('an ingress request is served the app with the code seeded', async () => {
      const response = await fetch(`${ingress}${INGRESS_PATH}/`, {
        headers: { 'x-ingress-path': INGRESS_PATH },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      const html = await response.text();
      assert.match(html, /Scanlet/, 'it should be the app shell');
      assert.ok(html.includes('addon-test-code'), 'the pairing code should be seeded so the panel just works');
      assert.ok(html.includes('scanlet:bridge'), 'seeded under the key the app reads');
    });

    await check('the same request with the prefix already stripped also works', async () => {
      const response = await fetch(`${ingress}/`, { headers: { 'x-ingress-path': INGRESS_PATH } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Scanlet/);
    });

    await check('a request without the ingress header is not handed the code', async () => {
      const response = await fetch(`${ingress}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Scanlet/);
      assert.ok(!html.includes('addon-test-code'), 'someone on the LAN must not get the code for free');
    });

    await check('the seeded code is the app’s bridge record, already paired', async () => {
      // What the app does with what it was handed: read the record, then use it.
      const html = await fetch(`${ingress}${INGRESS_PATH}/`, {
        headers: { 'x-ingress-path': INGRESS_PATH },
      }).then((response) => response.text());
      const match = /\{url:location\.origin,token:"([^"]+)"\}/.exec(html);
      assert.ok(match, 'the seed should carry a token');
      assert.equal(match[1], token);

      const health = await fetch(`${ingress}/health`, {
        headers: { 'x-ingress-path': INGRESS_PATH, 'x-scanlet-token': match[1] },
      }).then((response) => response.json());
      assert.equal(health.paired, true, 'that code should be accepted');
    });

    await check('the app’s own files are served through ingress', async () => {
      const response = await fetch(`${ingress}${INGRESS_PATH}/assets/js/app.js`, {
        headers: { 'x-ingress-path': INGRESS_PATH },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      await response.text();
    });

    await check('a scan URL works with the code in the query, for a Shortcut', async () => {
      // No printer named, and none configured: this must be a clean error, not a
      // crash. It used to take the whole add-on down — the route returned a
      // promise that escaped its own try/catch.
      const withoutCode = await fetch(`${lan}/scan.pdf`);
      assert.equal(withoutCode.status, 401);
      await withoutCode.json();

      const named = await fetch(`${lan}/scan.pdf?printer=127.0.0.1:1&token=${token}`);
      assert.equal(named.status, 502, 'an unreachable printer is a bad gateway, not a dead server');
      const body = await named.json();
      assert.match(body.error, /No eSCL scanner answered/);
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
