#!/usr/bin/env node
/*
 * Tests for the browser-side helpers that reach the bridge.
 *
 *   node assets/test/bridge.test.mjs
 *
 * `assets/js/bridge.js` builds URLs, reads pairing codes and splits the
 * multipart body the bridge streams back for a multi-page scan. None of that
 * needs a DOM, so it runs in plain Node against bodies shaped exactly like the
 * ones `bridge/scanlet-bridge.mjs` writes.
 */

import assert from 'node:assert/strict';
import { DEFAULT_BRIDGE, normaliseBridgeUrl, tokenFromInput, splitMultipart } from '../js/bridge.js';

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

await check('tokenFromInput reads a code out of a link or plain text', () => {
  assert.equal(tokenFromInput('http://127.0.0.1:8787/#s=ABC123'), 'ABC123');
  assert.equal(tokenFromInput('http://x/?token=abcdef'), 'abcdef');
  assert.equal(tokenFromInput('#s=with%20space'), 'with space');
  assert.equal(tokenFromInput('pl4inC0de'), 'pl4inC0de');
  assert.equal(tokenFromInput('abc'), '', 'too short to be a code');
  assert.equal(tokenFromInput(''), '');
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
