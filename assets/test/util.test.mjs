#!/usr/bin/env node
/*
 * Tests for the small shared frontend helpers.
 *
 *   node assets/test/util.test.mjs
 *
 * `assets/js/util.js` only touches the DOM inside the functions that draw or
 * fetch, so its pure helpers — formatting, filename safety, the concurrency
 * pool — run in plain Node with no browser.
 */

import assert from 'node:assert/strict';
import {
  clamp,
  formatBytes,
  stripExt,
  safeFilename,
  uid,
  debounce,
  pool,
  stripUndefined,
  once,
} from '../js/util.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await check('clamp pins a value between its bounds', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

await check('formatBytes scales into human units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1.5 kB');
  assert.equal(formatBytes(2_500_000), '2.5 MB');
});

await check('stripExt removes a trailing extension only', () => {
  assert.equal(stripExt('Scan 2024.pdf'), 'Scan 2024');
  assert.equal(stripExt('no.extension.here'), 'no.extension');
  assert.equal(stripExt('a.PDF'), 'a');
  assert.equal(stripExt(''), '');
});

await check('safeFilename produces a usable base name', () => {
  assert.equal(safeFilename('My Invoice #3.pdf'), 'My Invoice _3');
  assert.equal(safeFilename(''), 'document');
  assert.equal(safeFilename('  ///  ', 'scan'), 'scan');
  assert.ok(!/[/\\?%*:|"<>]/.test(safeFilename('a/b\\c?d*e')));
});

await check('uid is unique and carries its prefix', () => {
  const a = uid('page');
  const b = uid('page');
  assert.match(a, /^page_/);
  assert.notEqual(a, b);
  assert.equal(new Set([a, b, uid('page')]).size, 3);
});

await check('stripUndefined drops only undefined values', () => {
  assert.deepEqual(stripUndefined({ a: 1, b: undefined, c: null, d: 0 }), { a: 1, c: null, d: 0 });
});

await check('once runs a function a single time', () => {
  let calls = 0;
  const fn = once((value) => (calls++, value));
  assert.equal(fn(1), 1);
  assert.equal(fn(2), undefined);
  assert.equal(calls, 1);
});

await check('debounce collapses a burst into one trailing call', async () => {
  const seen = [];
  const fn = debounce((value) => seen.push(value), 20);
  fn('a');
  fn('b');
  fn('c');
  await sleep(50);
  assert.deepEqual(seen, ['c']);
});

await check('pool runs every item with a bounded number in flight', async () => {
  const items = Array.from({ length: 9 }, (_, i) => i);
  let live = 0;
  let peak = 0;
  const seen = [];
  await pool(items, 3, async (item) => {
    live++;
    peak = Math.max(peak, live);
    await sleep(5);
    seen.push(item);
    live--;
  });
  assert.equal(seen.length, 9);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

await check('pool reports progress and stops on the first failure', async () => {
  const progress = [];
  await assert.rejects(
    pool([1, 2, 3, 4], 1, async (item) => {
      if (item === 2) throw new Error('boom');
    }, (done) => progress.push(done)),
    /boom/,
  );
  assert.ok(progress.length >= 1);
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
