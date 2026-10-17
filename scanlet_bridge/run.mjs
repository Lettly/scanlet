/*
 * Scanlet Bridge — Home Assistant add-on entry point.
 *
 * Wraps the bridge in two listeners:
 *
 *   ingress (8099) — Home Assistant proxies this for the sidebar panel, over
 *     Home Assistant's own https. That gives the app a *secure origin* it will
 *     accept, so the camera, the service worker and "Add to Home Screen" all
 *     work on a phone; and it is same-origin with the API, so there is no CORS
 *     or mixed-content problem to solve. The pairing code is seeded into the
 *     page here, and only for requests that actually arrived through ingress.
 *
 *   lan (8787) — reachable directly, for an iOS Shortcut, Tasker, curl or the
 *     browser extension. This one needs the pairing code.
 *
 * Everything that talks to a printer is the same module the standalone bridge
 * uses, so the add-on adds no second implementation of anything.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

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
 * The pairing code: the configured one, or one generated once and kept beside
 * the options file so it survives a restart. Regenerating it on every restart
 * would silently break every Shortcut and bookmark.
 */
function resolveToken(configured) {
  const given = String(configured || '').trim();
  if (given) return given;

  const tokenPath = path.join(path.dirname(OPTIONS_PATH), 'scanlet-token');
  try {
    const saved = fs.readFileSync(tokenPath, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(9).toString('base64url');
  try {
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  } catch {
    log('could not persist the pairing code; it will change on restart');
  }
  return token;
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

/** The app shell, with the pairing code seeded so the panel needs no setup. */
function seedToken(appDir, token) {
  let html;
  try {
    html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  } catch {
    return null;
  }
  const seed =
    '<script>try{localStorage.setItem("scanlet:bridge",JSON.stringify(' +
    `{url:location.origin,token:${JSON.stringify(token)}}` +
    '))}catch(e){}</script>';
  return Buffer.from(html.replace('</head>', `${seed}</head>`), 'utf8');
}

function createIngressHandler({ appDir, token, port }) {
  const inner = createHandler({ log, appDir, lan: true, port, token });
  return (request, response) => {
    const fromIngress = normaliseIngress(request);
    const url = new URL(request.url, 'http://localhost');
    const isShell = url.pathname === '/' || url.pathname === '/index.html';

    // Only seed the code on a request that really came from Home Assistant. A
    // browser on the LAN can reach this port too, and it must not be handed the
    // code for free.
    if (fromIngress && isShell && request.method === 'GET') {
      const body = seedToken(appDir, token);
      if (body) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        return response.end(body);
      }
    }
    return inner(request, response);
  };
}

function createLanHandler({ appDir, token, port }) {
  const inner = createHandler({ log, appDir, lan: true, port, token });
  return (request, response) => {
    normaliseIngress(request);
    return inner(request, response);
  };
}

/** Ask the bridge to remember printers the user listed in the options. */
async function registerPrinters(printers, port, token) {
  for (const address of printers) {
    const wanted = String(address || '').trim();
    if (!wanted) continue;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-scanlet-token': token },
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
const token = resolveToken(options.token);
const appDir = APP_DIR;

if (!fs.existsSync(path.join(appDir, 'index.html'))) {
  log(`no app found at ${appDir} — the add-on image looks wrong`);
  process.exit(1);
}

const ingressServer = http.createServer(createIngressHandler({ appDir, token, port: INGRESS_PORT }));
const lanServer = http.createServer(createLanHandler({ appDir, token, port: LAN_PORT }));

await new Promise((resolve) => ingressServer.listen(INGRESS_PORT, '0.0.0.0', resolve));
await new Promise((resolve) => lanServer.listen(LAN_PORT, '0.0.0.0', resolve));

log(`Home Assistant panel on port ${INGRESS_PORT} (proxied by ingress, https)`);
log(`network API on port ${LAN_PORT}`);

if (!String(options.token || '').trim()) {
  log(`pairing code: ${token}`);
  log('  open the panel from the sidebar and it pairs itself;');
  log(`  anything else needs the code: http://<this-host>:${LAN_PORT}/#s=${token}`);
}

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
        host: 'home-assistant',
        port: LAN_PORT,
        address,
        txt: {
          txtvers: '1',
          vers: '1.0.0',
          ty: 'Scanlet Bridge (Home Assistant)',
          path: '/',
          tls: '0',
          token: 'required',
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

await registerPrinters(readPrinters(options), LAN_PORT, token);

const shutdown = () => {
  log('stopping');
  responder?.stop();
  ingressServer.close();
  lanServer.close();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
