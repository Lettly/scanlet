#!/usr/bin/env node
/*
 * End-to-end tests for the scanning bridge, against the mock scanner.
 *
 *   node bridge/test/bridge.test.mjs
 *
 * Two bridge configurations are exercised:
 *   • a private loopback bridge, driven with the real client module
 *     (assets/js/bridge.js) so the multipart parsing the browser relies on runs too
 *   • a LAN bridge that also serves the app, checking static file serving and the
 *     single-URL scan routes — the setup a phone uses
 */

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockScanner } from './mock-scanner.mjs';
import {
  buildAnnouncement,
  capabilities,
  createResponder,
  createServer,
  discoverSanePrinters,
  parseMessage,
  runScan,
  saneCapabilities,
  saneRunScan,
  summarise,
  summariseBridges,
} from '../scanlet-bridge.mjs';
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

async function lanBridge() {
  const bridge = createServer({ log: () => {}, appDir: APP_DIR, lan: true, port: 8787 });
  const port = await listen(bridge);
  return {
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
      assert.equal(health.requiresToken, undefined);
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

async function testLan() {
  const env = await lanBridge();
  const client = new BridgeClient(env.url);
  const mock = createMockScanner({ pages: 2 });
  const mockPort = await listen(mock);
  try {
    const health = await fetch(`${env.url}/health`).then((r) => r.json());
    await check('health is open and needs no code', () => {
      assert.equal(health.ok, true);
      assert.equal(health.app, true);
      assert.equal(health.lan, true);
      assert.equal(health.requiresToken, undefined, 'there is no pairing code to require');
      assert.ok(Array.isArray(health.printers));
      assert.ok(Array.isArray(health.addresses));
    });

    const printers = await fetch(`${env.url}/printers`);
    await check('device routes are open to the network', async () => {
      assert.equal(printers.status, 200);
      const body = await printers.json();
      assert.ok(Array.isArray(body.printers));
    });

    const probe = await client.probe();
    await check('the client probes the LAN bridge with no code', () => {
      assert.equal(probe.ok, true);
      assert.equal(probe.app, true);
      assert.equal(probe.port, env.port);
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
    await check('preflight allows private network access', () => {
      assert.equal(preflight.status, 204);
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

    const shared = await client.probeAddress(`127.0.0.1:${mockPort}`);
    await check('a Shortcut can scan with one URL, no code needed', async () => {
      // No headers: this is what "Get Contents of URL" can actually do.
      const response = await fetch(`${env.url}/printers/${encodeURIComponent(shared.printer.id)}/scan.pdf`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/pdf/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.match(bytes.subarray(-8).toString('latin1'), /%%EOF/);
    });

    await check('the TLS certificate is downloadable for a phone to trust', async () => {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'scanlet-cert-'));
      const pemPath = path.join(sandbox, 'cert.pem');
      fs.writeFileSync(pemPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');

      const withCert = createServer({ log: () => {}, certificatePath: pemPath });
      const withoutCert = createServer({ log: () => {} });
      const certPort = await listen(withCert);
      const plainPort = await listen(withoutCert);
      try {
        const response = await fetch(`http://127.0.0.1:${certPort}/certificate.pem`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /pem/);
        assert.match(await response.text(), /BEGIN CERTIFICATE/);

        const none = await fetch(`http://127.0.0.1:${plainPort}/certificate.pem`);
        assert.equal(none.status, 404, 'a bridge without TLS has no certificate to give');
        await none.json();
      } finally {
        withCert.close();
        withoutCert.close();
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
  } finally {
    env.close();
    mock.close();
  }
}

async function testSingleUrl() {
  // Two devices: one assembles PDFs itself, one refuses and only gives images.
  const pdfDevice = createMockScanner({ pages: 3 });
  const imageDevice = createMockScanner({ pages: 3, pdf: false });
  const pdfPort = await listen(pdfDevice);
  const imagePort = await listen(imageDevice);
  const bridge = createServer({ log: () => {} });
  const bridgePort = await listen(bridge);
  const url = `http://127.0.0.1:${bridgePort}`;

  try {
    const client = new BridgeClient(url);
    const pdfPrinter = (await client.probeAddress(`127.0.0.1:${pdfPort}`)).printer;
    const imagePrinter = (await client.probeAddress(`127.0.0.1:${imagePort}`)).printer;

    const asPdf = await fetch(`${url}/printers/${encodeURIComponent(pdfPrinter.id)}/scan.pdf`);
    const pdfBytes = Buffer.from(await asPdf.arrayBuffer());
    await check('scan.pdf returns a real PDF from a capable device', () => {
      assert.equal(asPdf.status, 200);
      assert.match(asPdf.headers.get('content-type'), /application\/pdf/);
      assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.match(pdfBytes.subarray(-8).toString('latin1'), /%%EOF/);
    });

    const asJpg = await fetch(`${url}/printers/${encodeURIComponent(pdfPrinter.id)}/scan.jpg`);
    const jpgBytes = Buffer.from(await asJpg.arrayBuffer());
    await check('scan.jpg returns a JPEG', () => {
      assert.equal(asJpg.status, 200);
      assert.match(asJpg.headers.get('content-type'), /image\/jpeg/);
      assert.equal(jpgBytes[0], 0xff);
      assert.equal(jpgBytes[1], 0xd8);
    });

    const fallback = await fetch(`${url}/printers/${encodeURIComponent(imagePrinter.id)}/scan.pdf`);
    const fallbackBytes = Buffer.from(await fallback.arrayBuffer());
    await check('scan.pdf falls back to an image and says so', () => {
      assert.equal(fallback.status, 200);
      assert.match(fallback.headers.get('content-type'), /image\/jpeg/);
      // The caller asked for a PDF and must be able to tell it did not get one.
      assert.equal(fallback.headers.get('x-scanlet-format'), 'image/jpeg');
      assert.equal(fallbackBytes[0], 0xff);
      assert.equal(fallbackBytes[1], 0xd8);
    });

    const mismatch = await fetch(`${url}/printers/${encodeURIComponent(pdfPrinter.id)}/scan.png`);
    const mismatchBytes = Buffer.from(await mismatch.arrayBuffer());
    await check('a requested format the device ignores is reported, not disguised', () => {
      assert.equal(mismatch.status, 200);
      assert.match(mismatch.headers.get('content-type'), /image\/jpeg/);
      assert.equal(mismatch.headers.get('x-scanlet-format'), 'image/jpeg');
      assert.ok(mismatchBytes.length > 0);
    });

    const unsupported = await fetch(`${url}/printers/${encodeURIComponent(pdfPrinter.id)}/scan.bmp`);
    await check('an unsupported extension is not a scan route', () => {
      assert.equal(unsupported.status, 404);
    });

    const onDemand = await fetch(
      `${url}/printers/${encodeURIComponent(pdfPrinter.id)}/scan.jpg?resolution=75&adf=true&color=Grayscale8`,
    );
    await check('query options are accepted on the single-URL route', async () => {
      assert.equal(onDemand.status, 200);
      await onDemand.arrayBuffer();
    });

    // The form a human types into a Shortcut: a plain address, no opaque id.
    const friendly = await fetch(`${url}/scan.pdf?printer=127.0.0.1:${imagePort}`);
    const friendlyBytes = Buffer.from(await friendly.arrayBuffer());
    await check('a plain address works instead of an opaque id', () => {
      assert.equal(friendly.status, 200);
      assert.match(friendly.headers.get('content-type'), /image\/jpeg/);
      assert.equal(friendlyBytes[0], 0xff);
    });

    const ambiguous = await fetch(`${url}/scan.pdf`);
    await check('an ambiguous request explains itself instead of guessing', async () => {
      assert.equal(ambiguous.status, 502);
      const body = await ambiguous.json();
      assert.match(body.error, /Name the printer/);
    });

    // Regression: this route used to `return` a promise from inside its own
    // try/catch, so a failure escaped as an unhandled rejection and killed the
    // process — taking every other request with it.
    const unreachable = await fetch(`${url}/scan.pdf?printer=127.0.0.1:1`);
    await check('an unreachable printer is an error, not a fatal crash', async () => {
      assert.equal(unreachable.status, 502);
      const body = await unreachable.json();
      assert.match(body.error, /No eSCL scanner answered/);
    });

    // Regression: `return serveSingleScan(...)` used to sit inside its own
    // try/catch, and returning a promise from an async function awaits it *after*
    // the try block has exited — so a rejection escaped as an unhandled rejection
    // and killed the process, taking every other request with it. A device that
    // answers the probe and then fails the job is exactly how that happened.
    const faultyDevice = createMockScanner({ pages: 1, faulty: true });
    const faultyPort = await listen(faultyDevice);
    try {
      const faulty = await fetch(`${url}/scan.pdf?printer=127.0.0.1:${faultyPort}`);
      await check('a device that fails mid-scan is an error, not a dead server', async () => {
        assert.equal(faulty.status, 502);
        const body = await faulty.json();
        assert.match(body.error, /rejected the job/);
      });

      await check('the bridge still answers after a scan fails', async () => {
        const response = await fetch(`${url}/health`);
        assert.equal(response.status, 200);
        await response.json();
      });
    } finally {
      faultyDevice.close();
    }

    await check('the bridge still answers after that failure', async () => {
      const response = await fetch(`${url}/health`);
      assert.equal(response.status, 200);
      await response.json();
    });
  } finally {
    bridge.close();
    pdfDevice.close();
    imageDevice.close();
  }
}

/* ─────────────────────────── discovery ─────────────────────────── */

async function testDiscovery() {
  const target = { instance: 'scanlet-unit', host: 'scanlet-unit', port: 4321, address: '127.0.0.1' };
  const txt = { txtvers: '1', vers: '1.2.3', ty: 'Scanlet Bridge', path: '/', tls: '0' };

  await check('the advertisement reads back as a bridge', () => {
    const found = summariseBridges(parseMessage(buildAnnouncement({ ...target, txt })));
    assert.equal(found.length, 1, 'the packet should describe exactly one bridge');
    assert.equal(found[0].name, 'Scanlet Bridge');
    assert.equal(found[0].address, '127.0.0.1');
    assert.equal(found[0].port, 4321);
    assert.equal(found[0].version, '1.2.3');
    assert.equal(found[0].url, 'http://127.0.0.1:4321');
  });

  await check('the advertisement carries no secret, because there is none', () => {
    const packet = buildAnnouncement({ ...target, txt });
    assert.ok(packet.includes(Buffer.from('Scanlet Bridge')));
    assert.ok(!packet.includes(Buffer.from('token')), 'no pairing token should be advertised');
  });

  await check('a non-IPv4 address is refused rather than advertised', () => {
    assert.throws(() => buildAnnouncement({ ...target, address: 'fe80::1', txt }), /IPv4/);
  });

  await check('a live responder answers a query', async () => {
    // On a real network the responder sits on 5353; here it takes an ephemeral
    // port so the test cannot collide with the system's own mDNS resolver.
    const responder = createResponder({ ...target, txt, log: () => {}, listen: { port: 0, address: '127.0.0.1' } });
    await responder.start();
    const socket = dgram.createSocket('udp4');
    try {
      const port = responder.address().port;
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the responder stayed silent')), 4000);
        socket.on('message', (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        socket.bind(0, '127.0.0.1', () => {
          // A hand-built PTR query carrying the unicast-response bit, so the
          // reply comes back to this socket rather than to the whole group.
          const labels = '_scanlet._tcp.local'
            .split('.')
            .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
          const header = Buffer.alloc(12);
          header.writeUInt16BE(1, 4); // one question
          const tail = Buffer.alloc(4);
          tail.writeUInt16BE(12, 0); // PTR
          tail.writeUInt16BE(0x8001, 2); // class IN + unicast response
          const query = Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
          socket.send(query, 0, query.length, port, '127.0.0.1');
        });
      });

      const found = summariseBridges(parseMessage(answer));
      assert.equal(found.length, 1);
      assert.equal(found[0].instance, `scanlet-unit._scanlet._tcp.local`);
      assert.equal(found[0].port, 4321);
    } finally {
      socket.close();
      responder.stop();
    }
  });

  await check('an unrelated query is ignored, not answered', async () => {
    const responder = createResponder({ ...target, txt, log: () => {}, listen: { port: 0, address: '127.0.0.1' } });
    await responder.start();
    const socket = dgram.createSocket('udp4');
    try {
      const port = responder.address().port;
      const labels = '_uscan._tcp.local'
        .split('.')
        .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
      const header = Buffer.alloc(12);
      header.writeUInt16BE(1, 4);
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(12, 0);
      tail.writeUInt16BE(0x8001, 2);
      const query = Buffer.concat([header, ...labels, Buffer.from([0]), tail]);

      let answered = false;
      socket.on('message', () => {
        answered = true;
      });
      await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
      socket.send(query, 0, query.length, port, '127.0.0.1');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(answered, false, 'a scanner query must not be answered by the bridge');
    } finally {
      socket.close();
      responder.stop();
    }
  });
}

async function testEsclConfirmation() {
  await check('summarise tags each printer with its Bonjour service', () => {
    const records = [
      { type: 12, name: '_uscan._tcp.local', value: 'A._uscan._tcp.local' },
      { type: 33, name: 'A._uscan._tcp.local', value: { port: 80, target: 'a.local' } },
      { type: 16, name: 'A._uscan._tcp.local', value: { ty: 'AirScan printer' } },
      { type: 1, name: 'a.local', value: '10.0.0.5' },
      { type: 12, name: '_scanner._tcp.local', value: 'B._scanner._tcp.local' },
      { type: 33, name: 'B._scanner._tcp.local', value: { port: 9400, target: 'b.local' } },
      { type: 16, name: 'B._scanner._tcp.local', value: { ty: 'Samsung' } },
      { type: 1, name: 'b.local', value: '10.0.0.6' },
    ];
    const printers = Object.fromEntries(summarise(records).map((printer) => [printer.name, printer]));
    assert.equal(printers['AirScan printer'].service, '_uscan._tcp.local');
    assert.equal(printers['Samsung'].service, '_scanner._tcp.local');
  });

  await check('a device that answers with a non-HTTP protocol is named as such', async () => {
    // The Samsung M2070 way: it accepts the connection, then writes its own
    // binary protocol, which Node's HTTP parser rejects with a cryptic
    // "Parse Error: Expected HTTP/, RTSP/ or ICE/".
    const server = net.createServer((socket) => socket.write(Buffer.from([0xa8, 0x08, 0x43, 0x00])));
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    try {
      const error = await capabilities({ address: '127.0.0.1', port, path: '/eSCL', tls: false }).then(
        () => null,
        (caught) => caught,
      );
      assert.ok(error, 'expected capabilities to reject');
      assert.match(error.message, /did not answer with eSCL/);
    } finally {
      server.close();
    }
  });
}

async function testSane() {
  // A stand-in `scanimage`. A host with SANE would have the real one; this
  // exercises the bridge's listing, option parsing and scan without hardware.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanlet-sane-test-'));
  const fake = path.join(dir, 'scanimage');
  fs.writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) { console.log('scanimage (sane-backends) 1.1.1'); process.exit(0); }",
      'if (args.includes(\'-L\')) { console.log("device `test:0\' is a Fake SANE scanner"); process.exit(0); }',
      "if (args.includes('-A')) {",
      "  console.log('    --mode Color [Color|Gray|Lineart]');",
      "  console.log('    --resolution 300dpi [75|150|300|600]');",
      "  console.log('    --source Flatbed [Flatbed|ADF]');",
      '  process.exit(0);',
      '}',
      'process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    await check('a host with SANE lists its scanner', () => {
      const found = discoverSanePrinters();
      assert.equal(found.length, 1);
      assert.equal(found[0].driver, 'sane');
      assert.equal(found[0].device, 'test:0');
      assert.equal(found[0].name, 'Fake SANE');
    });

    await check('SANE options are read and mapped to what the UI offers', async () => {
      const caps = await saneCapabilities({ driver: 'sane', device: 'test:0' });
      assert.deepEqual(caps.resolutions, [75, 150, 300, 600]);
      assert.ok(caps.colorModes.includes('RGB24'));
      assert.ok(caps.colorModes.includes('BlackAndWhite1'));
      assert.ok(caps.sources.includes('Platen'));
      assert.ok(caps.sources.includes('Feeder'));
    });

    await check('a SANE scan comes back as one image page', async () => {
      const pages = await saneRunScan({ driver: 'sane', device: 'test:0' }, { resolution: 300, colorMode: 'RGB24' });
      assert.equal(pages.length, 1);
      assert.equal(pages[0].mime, 'image/png');
      assert.deepEqual([...pages[0].body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });

    await check('capabilities() and runScan() dispatch to SANE for a driver device', async () => {
      const printer = { id: 'sane:test:0', driver: 'sane', device: 'test:0' };
      const caps = await capabilities(printer);
      assert.ok(caps.resolutions.includes(300));
      const pages = await runScan(printer, {});
      assert.equal(pages.length, 1);
    });

    await check('the bridge serves SANE scanners through /printers', async () => {
      const server = createServer({ log: () => {} });
      const port = await listen(server);
      try {
        const body = await fetch(`http://127.0.0.1:${port}/printers`).then((response) => response.json());
        assert.ok(body.printers.some((printer) => printer.id === 'sane:test:0' && printer.driver === 'sane'));
      } finally {
        server.close();
      }
    });
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testPrivate();
  await testSingleUrl();
  await testLan();
  await testDiscovery();
  await testEsclConfirmation();
  await testSane();

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
