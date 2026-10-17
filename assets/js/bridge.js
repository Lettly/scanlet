/* Scanlet — clients for the two ways to reach a printer.
 *
 * 1. `BridgeClient` talks to the scanning bridge, a small Node process that runs
 *    either on this machine (http://127.0.0.1:8787) or on your network, in which
 *    case it also serves this app and you reach it at its own origin.
 * 2. `ExtensionClient` talks to the optional browser extension, which reaches
 *    eSCL printers directly thanks to its host permissions — no local server.
 *
 * Everything else in Scanlet works with neither of them.
 */

export const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';

/** The port a bridge listens on by default. */
export const BRIDGE_PORT = 8787;

/** Normalise a user-typed bridge address into an origin. */
export function normaliseBridgeUrl(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  // A scheme that is not http(s) is not a bridge, and must not be turned into one.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/**
 * A bridge's *base* URL: like `normaliseBridgeUrl`, but it keeps a path so a
 * bridge served behind a prefix (Home Assistant's ingress, for one) stays
 * reachable. Always ends with a slash, so relative paths resolve inside it.
 */
export function normaliseBridgeBase(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return '';
  }
}

/** The directory this app was served from — the bridge's base when it serves us. */
export function appBase() {
  if (typeof location === 'undefined') return '';
  return normaliseBridgeBase(new URL('.', location.href).toString());
}

/** True for the IPv4 ranges a home network actually uses. */
export function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''));
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if ([a, b].some((part) => part > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The names a bridge might answer to. Home Assistant's add-on advertises itself
 * as `home-assistant.local`, and a phone's own resolver understands `.local` even
 * though a browser has no mDNS of its own.
 */
export function bridgeHostNames(hostname = '') {
  const names = new Set([
    'scanlet.local',
    'home-assistant.local',
    'homeassistant.local',
    'scanlet-home-assistant.local',
  ]);
  if (hostname) names.add(hostname);
  return [...names];
}

class RequestError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function send(base, { path, method = 'GET', body = null, timeout = 4000, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  try {
    // A relative path resolves inside the base, so a bridge behind a prefix
    // (Home Assistant ingress) is reached at the right address.
    const url = new URL(String(path).replace(/^\/+/, ''), base).toString();
    const response = await fetch(url, {
      method,
      body,
      signal: controller.signal,
      headers: Object.keys(headers).length ? headers : undefined,
    });
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.clone().json();
      } catch {
        payload = null;
      }
      const detail = payload?.error || (await response.text().catch(() => ''));
      throw new RequestError(detail || `${response.status} ${response.statusText}`, response.status, payload);
    }
    return raw ? response : response.json();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error.name === 'AbortError') throw new RequestError('The bridge did not answer in time.', 0);
    throw new RequestError(
      error.message === 'Failed to fetch'
        ? 'Nothing answered there. Check the address, or start the bridge.'
        : error.message,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── the bridge ─────────────────────────── */

export class BridgeClient {
  constructor(url = DEFAULT_BRIDGE) {
    this.url = normaliseBridgeBase(url) || normaliseBridgeBase(DEFAULT_BRIDGE);
  }

  /** Who is there? */
  async probe({ timeout = 2500 } = {}) {
    const health = await send(this.url, { path: 'health', timeout });
    return {
      url: this.url,
      ok: health?.ok !== false,
      version: health?.version || 'unknown',
      lan: Boolean(health?.lan),
      app: Boolean(health?.app),
      addresses: Array.isArray(health?.addresses) ? health.addresses : [],
      port: health?.port || 0,
      printers: Array.isArray(health?.printers) ? health.printers : [],
    };
  }

  async discover() {
    const data = await send(this.url, { path: 'printers', timeout: 8000 });
    return Array.isArray(data?.printers) ? data.printers : [];
  }

  capabilities(id) {
    return send(this.url, {
      path: `printers/${encodeURIComponent(id)}/capabilities`,
      timeout: 12000,
    });
  }

  async probeAddress(address) {
    return send(this.url, {
      path: 'probe',
      method: 'POST',
      body: JSON.stringify({ address }),
      timeout: 15000,
    });
  }

  /**
   * Run a scan, reporting pages as they arrive.
   * @returns {Promise<Array<{blob:Blob, mime:string}>>}
   */
  async scan(id, options = {}, { onPage } = {}) {
    const response = await send(this.url, {
      path: `printers/${encodeURIComponent(id)}/scan`,
      method: 'POST',
      body: JSON.stringify(options),
      timeout: 180_000,
      raw: true,
    });
    return parseScanResponse(response, onPage);
  }
}

async function parseScanResponse(response, onPage) {
  const type = response.headers.get('content-type') || '';

  if (type.startsWith('image/') || type.startsWith('application/pdf')) {
    const blob = await response.blob();
    const page = { blob, mime: type.split(';')[0] };
    onPage?.(page, 1, 1);
    return [page];
  }

  if (type.startsWith('multipart/')) {
    const boundaryMatch = /boundary="?([^";]+)"?/i.exec(type);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!boundaryMatch) throw new RequestError('The bridge sent a malformed multi-page response.', 0);
    const parts = splitMultipart(buffer, boundaryMatch[1]);
    parts.forEach((page, index) => onPage?.(page, index + 1, parts.length));
    return parts;
  }

  throw new RequestError(`The bridge returned an unexpected content type: ${type || 'none'}`, 0);
}

/** Split a `multipart/mixed` body the way the bridge writes it. Exported for tests. */
export function splitMultipart(buffer, boundary) {
  const marker = new TextEncoder().encode(`--${boundary}`);
  const crlfcrlf = new TextEncoder().encode('\r\n\r\n');
  const parts = [];
  let index = 0;
  while (index < buffer.length) {
    const start = indexOfBytes(buffer, marker, index);
    if (start === -1) break;
    const headerStart = start + marker.length;
    const headerEnd = indexOfBytes(buffer, crlfcrlf, headerStart);
    if (headerEnd === -1) break;
    const headers = new TextDecoder().decode(buffer.subarray(headerStart, headerEnd));
    let next = indexOfBytes(buffer, marker, headerEnd + 4);
    if (next === -1) next = buffer.length;
    // the CRLF before the boundary belongs to the delimiter, not the body
    let end = next;
    if (buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;
    const mime = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() || 'image/jpeg';
    parts.push({ blob: new Blob([buffer.subarray(headerEnd + 4, end)]), mime });
    index = next;
  }
  return parts;
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Look for bridges across the whole network, not just this origin.
 *
 * A browser cannot browse mDNS, so this probes instead: the origin that served
 * this page (a bridge, or Home Assistant's ingress, which proxies one), the
 * loopback helper, the well-known `.local` names a bridge may answer to, the
 * whole `/24` this page is on when the browser will tell us the address, and
 * whatever the user used last. Every hit is reported through `onBridge` as it
 * arrives, so the UI can fill up while the sweep is still running.
 */
export async function detectBridges({
  remember = null,
  sameOrigin = true,
  onBridge = null,
  sweep = true,
  hostTimeout = 1200,
  sweepTimeout = 700,
  concurrency = 48,
} = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (url) => {
    const base = normaliseBridgeBase(url);
    if (!base || seen.has(base)) return;
    seen.add(base);
    candidates.push(base);
  };

  const base = appBase();
  if (sameOrigin && base && /^https?:$/.test(location.protocol)) add(base);
  // A bridge the user connected to before, or just typed, comes first so it
  // answers before the sweep has finished.
  if (remember?.url) add(remember.url);
  add(DEFAULT_BRIDGE);

  /*
   * A bridge sits on the local network, so these are plain-http addresses on a
   * `.local` name or a private IP. An https page would normally have those
   * blocked as mixed content, but Chrome's Local Network Access exempts exactly
   * those destinations: it asks the user for permission and, once granted, the
   * request goes through. (It is the `.local` name or the private-IP literal
   * that earns the exemption — a public hostname would not, so we do not guess
   * one over https.) Other browsers block it outright, where the probe simply
   * fails and is caught. So we try them whatever this page's scheme is.
   */
  const named = new Set();
  for (const name of bridgeHostNames(location.hostname)) {
    if (!name || name === 'localhost' || isPrivateIpv4(name)) continue;
    if (location.protocol !== 'http:' && !/\.local$/i.test(name)) continue;
    named.add(normaliseBridgeBase(`http://${name}:${BRIDGE_PORT}`));
  }
  for (const url of named) add(url);
  if (sweep && isPrivateIpv4(location.hostname)) {
    const prefix = location.hostname.split('.').slice(0, 3).join('.');
    for (let i = 1; i <= 254; i++) add(`http://${prefix}.${i}:${BRIDGE_PORT}`);
  }

  const found = [];
  const record = (info) => {
    found.push(info);
    onBridge?.(info);
  };

  const probe = async (url) => {
    // Well-known names and the loopback deserve a moment; a bare address in a
    // /24 sweep is either there or is not.
    const timeout = named.has(url) || url === base || url === normaliseBridgeBase(DEFAULT_BRIDGE)
      ? hostTimeout
      : sweepTimeout;
    try {
      const info = await new BridgeClient(url).probe({ timeout });
      if (info.ok) record({ ...info, sameOrigin: url === base });
    } catch {
      /* not a bridge; keep looking */
    }
  };

  const queue = candidates.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (queue.length) {
      // eslint-disable-next-line no-await-in-loop
      await probe(queue.shift());
    }
  });
  await Promise.all(workers);

  // The bridge that served this page is the one the user is already looking at.
  found.sort((a, b) => Number(b.sameOrigin) - Number(a.sameOrigin));
  return found;
}

/* ─────────────────────────── the extension ─────────────────────────── */

const EXT_SOURCE = 'scanlet-page';
const EXT_REPLY = 'scanlet-extension';

/** True when the optional browser extension is installed and listening. */
export function extensionPing(timeout = 600) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.source === EXT_REPLY && data.type === 'pong') done(data);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: EXT_SOURCE, type: 'ping' }, location.origin);
    setTimeout(() => done(null), timeout);
  });
}

/** A page-side client for the extension, over window.postMessage. */
export class ExtensionClient {
  constructor({ timeout = 240_000 } = {}) {
    this.timeout = timeout;
    this.serial = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.source !== EXT_REPLY) return;
      this.listeners.forEach((fn) => fn(data));
      // `requestId` correlates a reply; `printerId` names a device. They used to
      // share one field, which made every reply unmatchable.
      if (!data.requestId) return;
      const entry = this.pending.get(data.requestId);
      if (!entry) return;
      if (data.type === 'error') {
        this.pending.delete(data.requestId);
        entry.reject(new Error(data.error || 'The extension failed.'));
      } else if (data.type === 'done') {
        this.pending.delete(data.requestId);
        entry.resolve(entry.result);
      } else if (entry.onEvent) {
        entry.onEvent(data);
        if (data.type === 'page') entry.result.push(data);
      }
    };
    window.addEventListener('message', this.onMessage);
  }

  dispose() {
    window.removeEventListener('message', this.onMessage);
    this.pending.clear();
    this.listeners.clear();
  }

  send(type, payload = {}, { onEvent } = {}) {
    const requestId = `c${++this.serial}`;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onEvent, result: [] });
      window.postMessage({ source: EXT_SOURCE, type, requestId, ...payload }, location.origin);
      setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        reject(new Error('The extension did not answer in time.'));
      }, this.timeout);
    });
  }

  async probe() {
    const pong = await extensionPing();
    return pong ? { ok: true, version: pong.version, printers: [] } : null;
  }

  /** `discover` may stream printers in as it finds them. */
  async discover({ onPrinter } = {}) {
    const printers = [];
    await this.send('discover', {}, {
      onEvent: (data) => {
        if (data.type === 'printer') {
          printers.push(data.printer);
          onPrinter?.(data.printer);
        }
      },
    });
    return printers;
  }

  capabilities(printerId) {
    return this.send('capabilities', { printerId }).then((result) => result?.caps || result);
  }

  probeAddress(address) {
    return this.send('probe-address', { address }).then((result) => result?.printer || result);
  }

  /** Scan and decode each page to a Blob as it arrives. */
  async scan(printerId, options = {}, { onPage, onProgress } = {}) {
    const pages = [];
    await this.send('scan', { printerId, options }, {
      onEvent: (data) => {
        if (data.type !== 'page') return;
        const bytes = base64ToBytes(data.data);
        const page = { blob: new Blob([bytes], { type: data.mime || 'image/jpeg' }), mime: data.mime };
        pages.push(page);
        onProgress?.(data.index, data.total);
        onPage?.(page, data.index, data.total);
      },
    });
    return pages;
  }
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ─────────────────────────── compatibility helpers ─────────────────────────── */

export const probe = (url) => new BridgeClient(url).probe();
export const discover = (url) => new BridgeClient(url).discover();
export const capabilities = (url, id) => new BridgeClient(url).capabilities(id);
export const probeAddress = (url, address) => new BridgeClient(url).probeAddress(address);
export const scan = (url, id, options = {}, extra) => new BridgeClient(url).scan(id, options, extra);

/** Common eSCL colour modes, in the order most printers prefer them. */
export const COLOR_MODES = [
  { value: 'RGB24', label: 'Color' },
  { value: 'Grayscale8', label: 'Grayscale' },
  { value: 'BlackAndWhite1', label: 'Black & white' },
];
