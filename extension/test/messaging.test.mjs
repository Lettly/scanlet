#!/usr/bin/env node
/*
 * Tests for the extension's wiring: the service worker as the page reaches it.
 *
 *   node extension/test/messaging.test.mjs
 *
 * The printer layer is covered by escl.test.mjs. This one covers what sits on
 * top of it — the message protocol a page speaks through the content script —
 * by standing a fake `chrome` in front of the real worker and driving it against
 * the mock scanner. Nothing here reimplements the worker: it imports the actual
 * `src/worker.js` and calls the listener that module registers.
 */

import assert from 'node:assert/strict';
import { createMockScanner } from '../../bridge/test/mock-scanner.mjs';

const PAGES = 3;
const TAB_ID = 7;

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

/** The smallest `chrome` the worker actually uses. */
function installFakeChrome({ granted = true, store = {}, version = '9.9.9-test' } = {}) {
  const listeners = [];
  const sent = [];
  const opened = [];
  let toolbar = null;
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      openOptionsPage: async () => {
        opened.push('options');
      },
    },
    action: {
      onClicked: {
        addListener: (fn) => {
          toolbar = fn;
        },
      },
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        sent.push({ tabId, message });
      },
    },
    storage: {
      local: { get: async (key) => (key in store ? { [key]: store[key] } : {}) },
    },
    permissions: { contains: async () => granted },
  };
  return { listeners, sent, opened, toolbar: () => toolbar };
}

/** A fresh worker bound to the fake, since it reads `chrome` at load time. */
const loadWorker = () => import(`../src/worker.js?case=${Math.random()}`);

const repliesFor = (sent, requestId) =>
  sent.filter((entry) => entry.message.requestId === requestId).map((entry) => entry.message);

/** Ask the worker something and wait for the reply it sends back to the tab. */
async function call(listeners, sent, request, { settle, timeout = 25000 } = {}) {
  for (const fn of listeners) fn(request, { tab: { id: TAB_ID } });
  const done =
    settle || ((message) => ['pong', 'done', 'error', 'caps', 'printer'].includes(message.type));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = sent.find((entry) => entry.message.requestId === request.requestId && done(entry.message));
    if (hit) return hit.message;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the worker never answered ${request.type}`);
}

async function main() {
  const mock = createMockScanner({ pages: PAGES });
  const port = await listen(mock);
  const address = `127.0.0.1:${port}`;
  let printerId = '';

  try {
    {
      const { listeners, sent, opened, toolbar } = installFakeChrome();
      await loadWorker();

      await check('the toolbar button opens the options page', () => {
        const onClicked = toolbar();
        assert.ok(onClicked, 'no action.onClicked listener was registered');
        onClicked();
        assert.deepEqual(opened, ['options']);
      });

      await check('the worker answers a ping with its version', async () => {
        const reply = await call(listeners, sent, { source: 'scanlet-page', type: 'ping', requestId: 'r1' });
        assert.equal(reply.type, 'pong');
        assert.equal(reply.version, '9.9.9-test');
        assert.equal(reply.requestId, 'r1', 'replies must echo the request id');
      });

      await check('every reply is addressed back to the asking tab', () => {
        assert.ok(sent.length > 0);
        for (const entry of sent) assert.equal(entry.tabId, TAB_ID);
      });

      await check('an unknown request is refused, not ignored', async () => {
        const reply = await call(listeners, sent, { source: 'scanlet-page', type: 'nonsense', requestId: 'r2' });
        assert.equal(reply.type, 'error');
        assert.match(reply.error, /Unknown request/);
      });

      await check('a printer can be added by address', async () => {
        const reply = await call(listeners, sent, {
          source: 'scanlet-page', type: 'probe-address', requestId: 'r3', address,
        });
        assert.equal(reply.type, 'printer');
        assert.equal(reply.printer.address, '127.0.0.1');
        assert.equal(reply.printer.port, port);
        assert.ok(reply.caps.resolutions.includes(300));
        printerId = reply.printer.id;
      });

      await check('a bad address comes back as an error with a reason', async () => {
        const reply = await call(listeners, sent, {
          source: 'scanlet-page', type: 'probe-address', requestId: 'r4', address: '127.0.0.1:1',
        });
        assert.equal(reply.type, 'error');
        assert.match(reply.error, /No eSCL scanner answered/);
      });

      await check('capabilities are returned for a named printer', async () => {
        const reply = await call(listeners, sent, {
          source: 'scanlet-page', type: 'capabilities', requestId: 'r5', printerId,
        });
        assert.equal(reply.type, 'caps');
        assert.ok(reply.caps.sources.includes('Feeder'));
        assert.equal(reply.caps.duplex, true);
      });

      await check('a scan streams one message per sheet, then a done', async () => {
        const requestId = 'r6';
        await call(
          listeners,
          sent,
          {
            source: 'scanlet-page',
            type: 'scan',
            requestId,
            printerId,
            options: { inputSource: 'Feeder' },
          },
          { settle: (message) => ['done', 'error'].includes(message.type), timeout: 30000 },
        );

        const messages = repliesFor(sent, requestId);
        const pages = messages.filter((message) => message.type === 'page');
        const done = messages.find((message) => message.type === 'done');
        assert.ok(done, `no done message: ${JSON.stringify(messages.map((m) => m.type))}`);
        assert.equal(pages.length, PAGES);
        assert.equal(done.count, PAGES);
        assert.equal(pages[0].index, 1, 'pages are numbered from one for the UI');

        const bytes = Buffer.from(pages[0].data, 'base64');
        assert.equal(bytes[0], 0xff, 'the page should be a JPEG');
        assert.equal(bytes[1], 0xd8);
        assert.equal(bytes[bytes.length - 1], 0xd9);
      });

      // The bug this suite exists for: with one `id` field carrying both the
      // request and the printer, capabilities and scan never matched a reply.
      await check('a printer id and a request id cannot be confused', async () => {
        const requestId = 'r7';
        const reply = await call(listeners, sent, {
          source: 'scanlet-page', type: 'capabilities', requestId, printerId,
        });
        assert.equal(reply.requestId, requestId);
        assert.notEqual(reply.requestId, printerId);
      });
    }

    {
      // A fresh worker, this time without network permission.
      const { listeners, sent } = installFakeChrome({ granted: false });
      await loadWorker();

      await check('discovery says which permission is missing', async () => {
        const reply = await call(listeners, sent, { source: 'scanlet-page', type: 'discover', requestId: 'p1' });
        assert.equal(reply.type, 'error');
        assert.equal(reply.needsPermission, true);
        assert.match(reply.error, /permission/i);
      });
    }

    {
      // Granted, but nothing to find: discovery must still report progress and
      // finish rather than hang.
      const { listeners, sent } = installFakeChrome({ granted: true });
      await loadWorker();

      await check('a sweep that finds nothing still finishes and reports progress', async () => {
        const requestId = 'q1';
        await call(
          listeners,
          sent,
          { source: 'scanlet-page', type: 'discover', requestId, subnets: ['127.0.0.1'] },
          { settle: (message) => ['done', 'error'].includes(message.type), timeout: 45000 },
        );
        const messages = repliesFor(sent, requestId);
        const done = messages.find((message) => message.type === 'done');
        assert.ok(done, 'the sweep never finished');
        assert.equal(typeof done.count, 'number');
        assert.ok(
          messages.some((message) => message.type === 'progress'),
          'the UI needs progress while it sweeps',
        );
      });
    }
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
