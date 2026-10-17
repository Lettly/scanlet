/*
 * Scanlet Bridge — Home Assistant add-on entry point.
 *
 * Wraps the bridge in two listeners:
 *
 *   ingress (8099) — Home Assistant proxies this for the sidebar panel, over
 *     Home Assistant's own https. That gives the app a *secure origin* it will
 *     accept, so the camera, the service worker and "Add to Home Screen" all
 *     work on a phone; and it is same-origin with the API, so there is no CORS
 *     or mixed-content problem to solve.
 *
 *   lan (8787) — reachable directly, for an iOS Shortcut, Tasker, curl, the
 *     browser extension, and any other device on the network.
 *
 * Neither listener has a pairing code: reaching the add-on means being on the
 * network, and the network is the boundary. Everything that talks to a printer
 * is the same module the standalone bridge uses, so the add-on adds no second
 * implementation of anything.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP_DIR = process.env.SCANLET_APP || '/app';
const OPTIONS_PATH = process.env.SCANLET_OPTIONS || '/data/options.json';
const INGRESS_PORT = Number(process.env.SCANLET_INGRESS_PORT) || 8099;
const LAN_PORT = Number(process.env.SCANLET_LAN_PORT) || 8787;

const { createHandler, createResponder, interfaceAddresses } = await import(
  path.join(APP_DIR, 'bridge', 'scanlet-bridge.mjs')
);

const log = (message) => console.log(`[scanlet] ${message}`);

function readOptions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    log(`no readable options at ${OPTIONS_PATH}; using defaults`);
    return {};
  }
}

/**
 * Home Assistant proxies ingress with `X-Ingress-Path`, and may or may not have
 * already stripped that prefix from the URL, so handle both.
 */
function normaliseIngress(request) {
  const prefix = request.headers['x-ingress-path'];
  if (prefix && request.url.startsWith(prefix)) {
    request.url = request.url.slice(prefix.length) || '/';
  }
  return Boolean(prefix);
}

function createListener({ appDir, port }) {
  const inner = createHandler({ log, appDir, lan: true, port });
  return (request, response) => {
    normaliseIngress(request);
    return inner(request, response);
  };
}

/** Ask the bridge to remember printers the user listed in the options. */
async function registerPrinters(printers, port) {
  for (const address of printers) {
    const wanted = String(address || '').trim();
    if (!wanted) continue;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: wanted }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await response.json().catch(() => ({}));
      log(response.ok ? `added printer ${wanted}` : `could not add ${wanted}: ${body.error || response.status}`);
    } catch (error) {
      log(`could not add ${wanted}: ${error.message}`);
    }
  }
}

/** A missing or unreadable options file must not be fatal either. */
function readPrinters(options) {
  return Array.isArray(options?.printers) ? options.printers : [];
}

/* ─────────────────────────── start ─────────────────────────── */

const options = readOptions();
const appDir = APP_DIR;

if (!fs.existsSync(path.join(appDir, 'index.html'))) {
  log(`no app found at ${appDir} — the add-on image looks wrong`);
  process.exit(1);
}

const ingressServer = http.createServer(createListener({ appDir, port: INGRESS_PORT }));
const lanServer = http.createServer(createListener({ appDir, port: LAN_PORT }));

await new Promise((resolve) => ingressServer.listen(INGRESS_PORT, '0.0.0.0', resolve));
await new Promise((resolve) => lanServer.listen(LAN_PORT, '0.0.0.0', resolve));

log(`Home Assistant panel on port ${INGRESS_PORT} (proxied by ingress, https)`);
log(`network API on port ${LAN_PORT} (open to your network, no pairing)`);

let responder = null;
// Advertising is a nicety: if mDNS is unavailable, or the app version inside the
// image is older than this file expects, the add-on must still run.
if (options.advertise !== false) {
  try {
    const address = typeof interfaceAddresses === 'function' ? interfaceAddresses()[0] : null;
    if (!address) {
      log('no LAN address to advertise on — skipping Bonjour');
    } else {
      responder = createResponder({
        instance: 'scanlet-home-assistant',
        host: 'homeassistant',
        port: LAN_PORT,
        address,
        txt: {
          txtvers: '1',
          vers: '1.1.0',
          ty: 'Scanlet Bridge (Home Assistant)',
          path: '/',
          tls: '0',
        },
        log,
      });
      await responder.start().catch(() => {});
      log('findable on the network via Bonjour as scanlet-home-assistant (_scanlet._tcp)');
    }
  } catch (error) {
    responder = null;
    log(`could not advertise on Bonjour: ${error.message}`);
  }
}

await registerPrinters(readPrinters(options), LAN_PORT);

const shutdown = () => {
  log('stopping');
  responder?.stop();
  ingressServer.close();
  lanServer.close();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
