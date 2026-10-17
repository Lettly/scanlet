/*
 * Scanlet bridge — the extension's service worker.
 *
 * A page cannot read a response from a printer, because the printer sends no
 * CORS headers. This worker can: with host permission granted, `fetch` from an
 * extension is not subject to the page's origin rules. That single fact is what
 * makes a plugin able to replace the local server.
 *
 * The page talks to us through a content script: page → window.postMessage →
 * content script → chrome.runtime.sendMessage → here. Answers go back the same
 * way, and a multi-page ADF streams one message per sheet.
 */

import { capabilities, parsePrinterId, probeAddress, scan, base64FromBytes } from './escl.js';
import { COMMON_SUBNETS, hostsInSubnet, localSubnets, sweep } from './discovery.js';

const VERSION = chrome.runtime.getManifest().version;
const TO_PAGE = 'scanlet-extension';
const NETWORK_ORIGINS = ['http://*/*', 'https://*/*'];
const CAPS_TTL = 5 * 60 * 1000;

const capsCache = new Map(); // printer id → { at, caps }

/* ─────────────────────────── messaging ─────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;

  // Reply through the tab, so one request can yield many messages.
  const reply = (payload) =>
    chrome.tabs
      .sendMessage(tabId, { source: TO_PAGE, id: message.id, ...payload })
      .catch(() => {
        /* the page navigated away */
      });

  handle(message, reply).catch((error) => reply({ type: 'error', error: error.message }));
  return false;
});

async function handle(message, reply) {
  switch (message.type) {
    case 'ping':
      return reply({ type: 'pong', version: VERSION });

    case 'discover':
      return discover(reply, message);

    case 'capabilities':
      return sendCapabilities(reply, message.id);

    case 'probe-address': {
      const { printer, caps } = await probeAddress(message.address);
      capsCache.set(printer.id, { at: Date.now(), caps });
      return reply({ type: 'printer', printer, caps });
    }

    case 'scan':
      return runScan(reply, message);

    default:
      throw new Error(`Unknown request: ${message.type}`);
  }
}

/* ─────────────────────────── discovery ─────────────────────────── */

async function discover(reply, message) {
  if (!(await hasNetworkAccess())) {
    return reply({
      type: 'error',
      error: 'The extension needs permission to reach your local network.',
      needsPermission: true,
    });
  }

  const configured = await readSubnets();
  const detected = await localSubnets();
  const prefixes = message.subnets?.length
    ? message.subnets
    : configured.length
      ? configured
      : detected?.length
        ? detected
        : COMMON_SUBNETS.slice(0, 2);

  reply({ type: 'progress', phase: 'sweep', detail: prefixes.join(', ') });

  const hosts = prefixes.flatMap((prefix) => hostsInSubnet(prefix));
  let lastReport = 0;
  const found = await sweep(hosts, {
    concurrency: 48,
    timeout: 600,
    onFound: (printer, caps) => {
      capsCache.set(printer.id, { at: Date.now(), caps });
      reply({ type: 'printer', printer });
    },
    onProgress: (done, total) => {
      if (done - lastReport < 40 && done !== total) return;
      lastReport = done;
      reply({ type: 'progress', phase: 'sweep', done, total });
    },
  });

  reply({ type: 'done', count: found.length });
}

async function readSubnets() {
  const { subnets } = await chrome.storage.local.get('subnets');
  return Array.isArray(subnets) ? subnets : [];
}

/* ─────────────────────────── scanning ─────────────────────────── */

async function sendCapabilities(reply, id) {
  const printer = parsePrinterId(id);
  const cached = capsCache.get(id);
  const caps =
    cached && Date.now() - cached.at < CAPS_TTL ? cached.caps : await capabilities(printer);
  capsCache.set(id, { at: Date.now(), caps });
  return reply({ type: 'caps', caps });
}

async function runScan(reply, message) {
  const printer = parsePrinterId(message.id);
  let caps = capsCache.get(message.id)?.caps;
  if (!caps) caps = await capabilities(printer).catch(() => ({}));

  let count = 0;
  await scan(printer, message.options || {}, {
    caps,
    onPage: ({ bytes, mime, index }) => {
      count += 1;
      reply({
        type: 'page',
        index: index + 1,
        mime,
        // One message per sheet keeps every message small enough to stay safe.
        data: base64FromBytes(bytes),
      });
    },
  });
  return reply({ type: 'done', count });
}

/* ─────────────────────────── permissions ─────────────────────────── */

async function hasNetworkAccess() {
  try {
    return await chrome.permissions.contains({ origins: NETWORK_ORIGINS });
  } catch {
    return false;
  }
}
