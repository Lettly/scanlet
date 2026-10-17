#!/usr/bin/env node
/*
 * Tests for the browser-side helpers that reach the bridge.
 *
 *   node assets/test/bridge.test.mjs
 *
 * `assets/js/bridge.js` builds URLs, reads bridge addresses and splits the
 * multipart body the bridge streams back for a multi-page scan. None of that
 * needs a DOM, so it runs in plain Node against bodies shaped exactly like the
 * ones `bridge/scanlet-bridge.mjs` writes.
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_BRIDGE,
  normaliseBridgeUrl,
  normaliseBridgeBase,
  isPrivateIpv4,
  bridgeHostNames,
  detectBridges,
  splitMultipart,
} from '../js/bridge.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

await check('normaliseBridgeUrl accepts what people type', () => {
  assert.equal(normaliseBridgeUrl('127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normaliseBridgeUrl('192.168.1.50'), 'http://192.168.1.50');
  assert.equal(normaliseBridgeUrl('http://box:9000/path?x=1'), 'http://box:9000');
  assert.equal(normaliseBridgeUrl('https://scanlet.local:8787/'), 'https://scanlet.local:8787');
  assert.equal(normaliseBridgeUrl(''), '');
  assert.equal(normaliseBridgeUrl('not a url'), '');
});

await check('normaliseBridgeBase keeps a path, so an ingress prefix survives', () => {
  assert.equal(normaliseBridgeBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/');
  assert.equal(
    normaliseBridgeBase('https://ha:8123/api/hassio_ingress/abc'),
    'https://ha:8123/api/hassio_ingress/abc/',
  );
  assert.equal(normaliseBridgeBase('http://box:9000/path?x=1'), 'http://box:9000/path/');
  assert.equal(normaliseBridgeBase('ftp://box/'), '', 'only http(s) is a bridge');
  assert.equal(normaliseBridgeBase(''), '');
});

await check('isPrivateIpv4 recognises home networks, not public ones', () => {
  assert.equal(isPrivateIpv4('192.168.1.50'), true);
  assert.equal(isPrivateIpv4('10.0.0.4'), true);
  assert.equal(isPrivateIpv4('172.16.0.1'), true);
  assert.equal(isPrivateIpv4('172.32.0.1'), false);
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
  assert.equal(isPrivateIpv4('homeassistant.local'), false);
  assert.equal(isPrivateIpv4(''), false);
});

await check('bridgeHostNames covers Home Assistant and the bridge’s own names', () => {
  const names = bridgeHostNames('192.168.1.50');
  assert.ok(names.includes('home-assistant.local'), 'the add-on advertises this');
  assert.ok(names.includes('homeassistant.local'));
  assert.ok(names.includes('scanlet.local'));
  assert.ok(names.includes('192.168.1.50'));
});

await check('detectBridges sweeps the whole /24 and finds a bridge on the network', async () => {
  const realLocation = globalThis.location;
  const realFetch = globalThis.fetch;
  const tried = [];
  try {
    globalThis.location = {
      protocol: 'http:',
      hostname: '192.168.1.50',
      href: 'http://192.168.1.50:8899/',
      origin: 'http://192.168.1.50:8899',
    };
    globalThis.fetch = async (url) => {
      const href = String(url);
      tried.push(href);
      if (href === 'http://192.168.1.42:8787/health') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            version: '9.9.9',
            lan: true,
            app: false,
            addresses: ['192.168.1.50'],
            port: 8787,
            printers: [],
          }),
        };
      }
      throw new Error('nothing there');
    };

    const found = await detectBridges({ concurrency: 64 });
    assert.equal(found.length, 1, 'exactly the one bridge should answer');
    assert.equal(found[0].url, 'http://192.168.1.42:8787/');
    assert.equal(found[0].version, '9.9.9');
    assert.ok(tried.includes('http://192.168.1.42:8787/health'), 'the sweep should reach it');
    assert.ok(tried.length > 200, `the sweep should try most of the /24 (tried ${tried.length})`);
  } finally {
    globalThis.location = realLocation;
    globalThis.fetch = realFetch;
  }
});

await check('DEFAULT_BRIDGE is the loopback helper', () => {
  assert.equal(DEFAULT_BRIDGE, 'http://127.0.0.1:8787');
});

await check('splitMultipart reads the body the bridge writes', () => {
  const boundary = 'scanlet-page';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0x01]),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}\r\ncontent-type: image/png\r\n\r\n`),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const parts = splitMultipart(new Uint8Array(body), boundary);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].mime, 'image/jpeg');
  assert.equal(parts[1].mime, 'image/png');
});

await check('splitMultipart keeps the page bytes intact', async () => {
  const boundary = 'scanlet-page';
  const page1 = Buffer.from([1, 2, 3, 4, 5]);
  const page2 = Buffer.from([9, 8, 7]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: image/jpeg\r\n\r\n`),
    page1,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}\r\ncontent-type: image/jpeg\r\n\r\n`),
    page2,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const parts = splitMultipart(new Uint8Array(body), boundary);
  assert.equal(parts.length, 2);
  assert.deepEqual(new Uint8Array(await parts[0].blob.arrayBuffer()), new Uint8Array(page1));
  assert.deepEqual(new Uint8Array(await parts[1].blob.arrayBuffer()), new Uint8Array(page2));
});

await check('splitMultipart tolerates a single page', () => {
  const boundary = 'scanlet-page';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: image/jpeg\r\n\r\n`),
    Buffer.from('one'),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const parts = splitMultipart(new Uint8Array(body), boundary);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].mime, 'image/jpeg');
});

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
