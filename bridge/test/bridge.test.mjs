#!/usr/bin/env node
/*
 * End-to-end test for the scanning bridge, against the mock scanner.
 *
 *   node bridge/test/bridge.test.mjs
 *
 * It drives the real bridge HTTP API with the real client module
 * (assets/js/bridge.js), so the multipart parsing the browser relies on is
 * exercised too.
 */

import assert from 'node:assert/strict';
import { createMockScanner } from './mock-scanner.mjs';
import { createServer } from '../scanlet-bridge.mjs';
import { probeAddress, capabilities, scan } from '../../assets/js/bridge.js';

const PAGES = 4;

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

async function main() {
  const mock = createMockScanner({ pages: PAGES });
  const mockPort = await listen(mock);
  const bridge = createServer({ log: () => {} });
  const bridgePort = await listen(bridge);
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  const scannerAddress = `127.0.0.1:${mockPort}`;

  try {
    const health = await fetch(`${bridgeUrl}/health`).then((r) => r.json());
    check('health answers and is ok', () => {
      assert.equal(health.ok, true);
      assert.ok(health.version);
    });

    const probed = await probeAddress(bridgeUrl, scannerAddress);
    check('probe by address finds the scanner', () => {
      assert.ok(probed.printer, 'expected a printer');
      assert.equal(probed.printer.address, '127.0.0.1');
      assert.equal(probed.printer.port, mockPort);
      assert.ok(probed.printer.id.startsWith('manual:'));
    });

    check('capabilities list sources and colour modes', () => {
      assert.ok(probed.caps.sources.includes('Platen'));
      assert.ok(probed.caps.sources.includes('Adf') || probed.caps.sources.includes('Feeder'));
      assert.ok(probed.caps.colorModes.includes('RGB24'));
      assert.ok(probed.caps.resolutions.includes(300));
      assert.equal(probed.caps.duplex, true);
    });

    const capsViaRoute = await capabilities(bridgeUrl, probed.printer.id);
    check('capabilities route matches', () => {
      assert.equal(capsViaRoute.maxHeight, probed.caps.maxHeight);
    });

    const pages = await scan(bridgeUrl, probed.printer.id, {
      resolution: 300,
      colorMode: 'Grayscale8',
      inputSource: 'Feeder',
      format: 'image/jpeg',
      duplex: 'true',
    });
    check(`multipart response split into ${PAGES} pages`, () => {
      assert.equal(pages.length, PAGES);
      for (const page of pages) {
        assert.equal(page.mime, 'image/jpeg');
        assert.ok(page.blob.size > 100, 'page should carry bytes');
      }
    });

    const jpeg = new Uint8Array(await pages[0].blob.arrayBuffer());
    check('first page is a JPEG by magic bytes', () => {
      assert.equal(jpeg[0], 0xff);
      assert.equal(jpeg[1], 0xd8);
      assert.equal(jpeg[jpeg.length - 2], 0xff);
      assert.equal(jpeg[jpeg.length - 1], 0xd9);
    });

    const secondRun = await scan(bridgeUrl, probed.printer.id, { inputSource: 'Feeder' });
    check('a second job scans again', () => {
      assert.equal(secondRun.length, PAGES);
    });

    const missing = await fetch(`${bridgeUrl}/printers/does-not-exist/capabilities`);
    check('unknown printer returns an error payload, not a crash', () => {
      assert.equal(missing.status, 502);
    });
  } finally {
    bridge.close();
    mock.close();
  }

  let failed = 0;
  for (const result of results) {
    if (result.ok) console.log(`  ✓ ${result.name}`);
    else {
      failed++;
      console.log(`  ✗ ${result.name}\n      ${result.error.message}`);
    }
  }
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
