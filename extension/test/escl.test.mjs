#!/usr/bin/env node
/*
 * Tests for the Scanlet bridge extension's printer layer.
 *
 *   node extension/test/escl.test.mjs
 *
 * The extension's `chrome.*` surface is thin on purpose: everything that talks
 * to a printer lives in `src/escl.js` and `src/discovery.js`, which depend only
 * on `fetch`. That is what makes them testable here against the mock scanner,
 * with no browser involved.
 */

import assert from 'node:assert/strict';
import { createMockScanner } from '../../bridge/test/mock-scanner.mjs';
import {
  baseUrl,
  capabilities,
  normaliseAddress,
  parsePrinterId,
  printerId,
  probeAddress,
  scan,
  scanSettingsXml,
} from '../src/escl.js';
import { COMMON_SUBNETS, hostsInSubnet, localSubnets, probeHost, sweep } from '../src/discovery.js';

const PAGES = 3;

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

async function main() {
  const mock = createMockScanner({ pages: PAGES });
  const port = await listen(mock);
  const address = `127.0.0.1:${port}`;

  try {
    await check('printer ids round-trip', () => {
      const id = printerId('192.168.1.42', 8080, '/eSCL');
      const parsed = parsePrinterId(id);
      assert.equal(parsed.address, '192.168.1.42');
      assert.equal(parsed.port, 8080);
      assert.equal(parsed.path, '/eSCL');
      assert.equal(baseUrl(parsed), 'http://192.168.1.42:8080/eSCL');
      assert.throws(() => parsePrinterId('http://example.com/'), /Not a printer address/);
    });

    await check('addresses are normalised the way people type them', () => {
      assert.deepEqual(normaliseAddress('192.168.1.42'), { address: '192.168.1.42', port: 80 });
      assert.deepEqual(normaliseAddress(' http://192.168.1.42:8080/ '), {
        address: '192.168.1.42',
        port: 8080,
      });
      assert.throws(() => normaliseAddress(''), /Enter an address/);
    });

    await check('capabilities are read and normalised', async () => {
      const caps = await capabilities({ address: '127.0.0.1', port, path: '/eSCL' });
      assert.ok(caps.sources.includes('Platen'));
      assert.ok(caps.sources.includes('Feeder'));
      assert.ok(caps.colorModes.includes('RGB24'));
      assert.ok(caps.resolutions.includes(300));
      assert.equal(caps.duplex, true);
      assert.equal(caps.maxHeight, 4200, 'the largest sheet across sources');
      assert.equal(caps.maxima.Platen.maxHeight, 3300);
      assert.equal(caps.maxima.Feeder.maxHeight, 4200);
    });

    await check('scan settings pass the device maximum through unscaled', () => {
      const caps = { maxima: { Platen: { maxWidth: 2550, maxHeight: 3300 }, Feeder: { maxWidth: 2550, maxHeight: 4200 } } };
      const glass = scanSettingsXml({ resolution: 300, inputSource: 'Platen' }, caps);
      const feeder = scanSettingsXml({ resolution: 600, inputSource: 'Feeder' }, caps);

      // ThreeHundredthsOfInches units are fixed, so 600 dpi must not double the region.
      assert.match(glass, /<pwg:Width>2550<\/pwg:Width>/);
      assert.match(glass, /<pwg:Height>3300<\/pwg:Height>/);
      assert.match(feeder, /<pwg:Width>2550<\/pwg:Width>/);
      assert.match(feeder, /<pwg:Height>4200<\/pwg:Height>/);
      assert.ok(!/12600|8400/.test(feeder), 'the region must not be scaled by resolution');
    });

    await check('scan settings carry the chosen options', () => {
      const xml = scanSettingsXml(
        { resolution: 300, colorMode: 'Grayscale8', inputSource: 'Feeder', duplex: 'true', format: 'image/jpeg' },
        { maxima: { Feeder: { maxWidth: 2550, maxHeight: 3300 } } },
      );
      assert.match(xml, /<scan:XResolution>300<\/scan:XResolution>/);
      assert.match(xml, /<scan:ColorMode>Grayscale8<\/scan:ColorMode>/);
      assert.match(xml, /<pwg:InputSource>Feeder<\/pwg:InputSource>/);
      assert.match(xml, /<scan:Duplex>true<\/scan:Duplex>/);
    });

    await check('no region is sent when the device does not describe one', () => {
      const xml = scanSettingsXml({ resolution: 200 }, {});
      assert.ok(!xml.includes('<pwg:ScanRegions>'), 'a default page is better than a wrong one');
    });

    await check('probe by address finds the mock scanner', async () => {
      const { printer, caps } = await probeAddress(address);
      assert.equal(printer.address, '127.0.0.1');
      assert.equal(printer.port, port);
      assert.ok(caps.resolutions.includes(200));
    });

    await check('a scan streams every page of the ADF', async () => {
      const printer = { address: '127.0.0.1', port, path: '/eSCL' };
      const seen = [];
      const count = await scan(printer, { inputSource: 'Feeder' }, {
        caps: { maxWidth: 2550, maxHeight: 3300 },
        onPage: (page) => seen.push(page),
      });
      assert.equal(count, PAGES);
      assert.equal(seen.length, PAGES);
      assert.equal(seen[0].index, 0);
      assert.equal(seen[PAGES - 1].index, PAGES - 1);
      assert.equal(seen[0].mime, 'image/jpeg');
      assert.equal(seen[0].bytes[0], 0xff);
      assert.equal(seen[0].bytes[1], 0xd8);
    });

    await check('probeHost identifies a printer and ignores a stranger', async () => {
      const hit = await probeHost('127.0.0.1', { port });
      assert.ok(hit, 'the mock should be found');
      assert.ok(hit.printer.id.startsWith('escl://'));

      const miss = await probeHost('127.0.0.1', { port: 1, timeout: 300 });
      assert.equal(miss, null);
    });

    await check('sweep reports hits and progress as it goes', async () => {
      const progress = [];
      let streamed = null;
      const found = await sweep(['127.0.0.1'], {
        port,
        concurrency: 4,
        onFound: (printer) => {
          streamed = printer;
        },
        onProgress: (done, total) => progress.push(`${done}/${total}`),
      });
      assert.equal(found.length, 1);
      assert.ok(streamed, 'onFound should fire');
      assert.deepEqual(progress, ['1/1']);
    });

    await check('hostsInSubnet enumerates a /24 and skips the gateway', () => {
      const hosts = hostsInSubnet('192.168.1', { limit: 5 });
      assert.deepEqual(hosts, ['192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5']);
      assert.ok(COMMON_SUBNETS.includes('192.168.1'));
    });

    await check('localSubnets degrades to null without chrome.system.network', async () => {
      const subnets = await localSubnets();
      assert.equal(subnets, null, 'Node has no chrome APIs; the caller must cope');
    });
  } finally {
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
  console.log('');
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
