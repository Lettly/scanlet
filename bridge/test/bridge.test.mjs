#!/usr/bin/env node
/*
 * End-to-end tests for the scanning bridge, against the mock scanner.
 *
 *   node bridge/test/bridge.test.mjs
 *
 * Two bridge configurations are exercised:
 *   • a private loopback bridge, driven with the real client module
 *     (assets/js/bridge.js) so the multipart parsing the browser relies on runs too
 *   • a paired LAN bridge that also serves the app, checking auth, pairing and
 *     static file serving — the setup a phone uses
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockScanner } from './mock-scanner.mjs';
import { createServer, createToken } from '../scanlet-bridge.mjs';
import { BridgeClient } from '../../assets/js/bridge.js';

const PAGES = 4;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..', '..');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

async function privateBridge() {
  const mock = createMockScanner({ pages: PAGES });
  const mockPort = await listen(mock);
  const bridge = createServer({ log: () => {} });
  const bridgePort = await listen(bridge);
  return {
    mock,
    bridge,
    bridgeUrl: `http://127.0.0.1:${bridgePort}`,
    scannerAddress: `127.0.0.1:${mockPort}`,
    close: () => {
      bridge.close();
      mock.close();
    },
  };
}

async function pairedBridge() {
  const token = createToken();
  const bridge = createServer({ log: () => {}, token, appDir: APP_DIR, lan: true, port: 8787 });
  const port = await listen(bridge);
  return {
    token,
    bridge,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => bridge.close(),
  };
}

async function testPrivate() {
  const env = await privateBridge();
  const client = new BridgeClient(env.bridgeUrl);
  try {
    const health = await client.probe();
    await check('health answers and is ok', () => {
      assert.equal(health.ok, true);
      assert.ok(health.version);
      assert.equal(health.requiresToken, false);
      assert.equal(health.paired, true);
    });

    const probed = await client.probeAddress(env.scannerAddress);
    await check('probe by address finds the scanner', () => {
      assert.ok(probed.printer, 'expected a printer');
      assert.equal(probed.printer.address, '127.0.0.1');
      assert.equal(probed.printer.port, Number(env.scannerAddress.split(':')[1]));
      assert.ok(probed.printer.id.startsWith('manual:'));
    });

    await check('capabilities list sources and colour modes', () => {
      assert.ok(probed.caps.sources.includes('Platen'));
      assert.ok(probed.caps.sources.includes('Adf') || probed.caps.sources.includes('Feeder'));
      assert.ok(probed.caps.colorModes.includes('RGB24'));
      assert.ok(probed.caps.resolutions.includes(300));
      assert.equal(probed.caps.duplex, true);
    });

    const capsViaRoute = await client.capabilities(probed.printer.id);
    await check('capabilities route matches', () => {
      assert.equal(capsViaRoute.maxHeight, probed.caps.maxHeight);
    });

    const pages = await client.scan(probed.printer.id, {
      resolution: 300,
      colorMode: 'Grayscale8',
      inputSource: 'Feeder',
      format: 'image/jpeg',
      duplex: 'true',
    });
    await check(`multipart response split into ${PAGES} pages`, () => {
      assert.equal(pages.length, PAGES);
      for (const page of pages) {
        assert.equal(page.mime, 'image/jpeg');
        assert.ok(page.blob.size > 100, 'page should carry bytes');
      }
    });

    const jpeg = new Uint8Array(await pages[0].blob.arrayBuffer());
    await check('first page is a JPEG by magic bytes', () => {
      assert.equal(jpeg[0], 0xff);
      assert.equal(jpeg[1], 0xd8);
      assert.equal(jpeg[jpeg.length - 2], 0xff);
      assert.equal(jpeg[jpeg.length - 1], 0xd9);
    });

    const streamed = [];
    await client.scan(probed.printer.id, { inputSource: 'Feeder' }, {
      onPage: (page, index, total) => streamed.push(`${index}/${total}`),
    });
    await check('pages are reported as they arrive', () => {
      assert.equal(streamed.length, PAGES);
      assert.equal(streamed[0], `1/${PAGES}`);
      assert.equal(streamed[PAGES - 1], `${PAGES}/${PAGES}`);
    });

    const missing = await fetch(`${env.bridgeUrl}/printers/does-not-exist/capabilities`);
    await check('unknown printer returns an error payload, not a crash', () => {
      assert.equal(missing.status, 502);
    });
  } finally {
    env.close();
  }
}

async function testPaired() {
  const env = await pairedBridge();
  const client = new BridgeClient(env.url, env.token);
  try {
    const unauth = await fetch(`${env.url}/health`).then((r) => r.json());
    await check('health is open but withholds devices until paired', () => {
      assert.equal(unauth.ok, true);
      assert.equal(unauth.requiresToken, true);
      assert.equal(unauth.paired, false);
      assert.equal(unauth.app, true);
      assert.equal(unauth.lan, true);
      assert.deepEqual(unauth.printers, []);
      assert.deepEqual(unauth.addresses, []);
    });

    const denied = await fetch(`${env.url}/printers`);
    await check('device routes are refused without the code', async () => {
      assert.equal(denied.status, 401);
      const body = await denied.json();
      assert.equal(body.requiresToken, true);
    });

    const wrong = await new BridgeClient(env.url, 'not-the-code').discover().catch((error) => error);
    await check('a wrong code is refused', () => {
      assert.ok(wrong instanceof Error, 'expected an error');
      assert.equal(wrong.status, 401);
    });

    const headerAuth = await client.discover();
    await check('the code in a header is accepted', () => {
      assert.ok(Array.isArray(headerAuth));
    });

    const queryAuth = await fetch(`${env.url}/printers?token=${encodeURIComponent(env.token)}`);
    await check('the code in a query string is accepted', () => {
      assert.equal(queryAuth.status, 200);
    });

    const health = await client.probe();
    await check('paired health reports the bridge is serving the app', () => {
      assert.equal(health.paired, true);
      assert.equal(health.app, true);
      assert.equal(health.port, env.port);
    });

    const index = await fetch(`${env.url}/`);
    const indexBody = await index.text();
    await check('the app is served at / for other devices', () => {
      assert.equal(index.status, 200);
      assert.match(index.headers.get('content-type'), /text\/html/);
      assert.match(indexBody, /Scanlet/);
    });

    const script = await fetch(`${env.url}/assets/js/app.js`);
    await check('app assets are served with the right type', () => {
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
    });

    const manifest = await fetch(`${env.url}/manifest.webmanifest`);
    await check('the web manifest is served, so it can be installed', () => {
      assert.equal(manifest.status, 200);
      assert.match(manifest.headers.get('content-type'), /manifest\+json/);
    });

    const indexCache = await fetch(`${env.url}/sw.js`).then((r) => r.headers.get('cache-control'));
    await check('the service worker is never cached', () => {
      assert.match(indexCache, /no-store/);
    });

    const missing = await fetch(`${env.url}/assets/nope.js`);
    await check('a missing file is a clean 404', () => {
      assert.equal(missing.status, 404);
    });

    const preflight = await fetch(`${env.url}/printers`, { method: 'OPTIONS' });
    await check('preflight advertises the token header and private network access', () => {
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get('access-control-allow-headers'), /x-scanlet-token/);
      assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    });

    await check('the bridge refuses to serve files outside its app directory', async () => {
      // A throwaway tree: the app sits in `app/`, the secret is its sibling.
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'scanlet-serve-'));
      const appDir = path.join(sandbox, 'app');
      fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(appDir, 'index.html'), '<title>Scanlet</title>');
      fs.writeFileSync(path.join(appDir, 'assets', 'app.js'), 'export default 1;');
      fs.writeFileSync(path.join(appDir, '.env'), 'SECRET=do-not-serve');
      fs.writeFileSync(path.join(sandbox, 'secret.txt'), 'do-not-serve');

      const server = createServer({ log: () => {}, appDir });
      const port = await listen(server);
      const base = `http://127.0.0.1:${port}`;
      try {
        const ok = await fetch(`${base}/`);
        assert.equal(ok.status, 200, 'the app itself should be served');

        const attempts = [
          '/../../secret.txt',
          '/..%2f..%2fsecret.txt',
          '/%2e%2e/%2e%2e/secret.txt',
          '/%2e%2e%2fsecret.txt',
          '/assets/../../secret.txt',
        ];
        for (const attempt of attempts) {
          const response = await fetch(`${base}${attempt}`);
          const body = response.status === 200 ? await response.text() : '';
          assert.ok(!body.includes('do-not-serve'), `${attempt} leaked a sibling file`);
          assert.notEqual(response.status, 200, `${attempt} should not be served`);
        }

        const dotfile = await fetch(`${base}/.env`);
        assert.notEqual(dotfile.status, 200, 'dotfiles must not be served');
      } finally {
        server.close();
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
  } finally {
    env.close();
  }
}

async function main() {
  await testPrivate();
  await testPaired();

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
