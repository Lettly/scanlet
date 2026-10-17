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

/** Normalise a user-typed bridge address into an origin. */
export function normaliseBridgeUrl(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/** Pull a pairing code out of `#s=…`, `?token=…` or plain text. */
export function tokenFromInput(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const match = /[#?&](?:s|token|code)=([^&\s]+)/i.exec(value);
  if (match) return decodeURIComponent(match[1]);
  if (/^[\w-]{6,64}$/.test(value)) return value;
  return '';
}

class RequestError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function send(url, { path, method = 'GET', body = null, timeout = 4000, raw = false, token = '' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-scanlet-token'] = token;
  try {
    const response = await fetch(new URL(path, url).toString(), {
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
  constructor(url = DEFAULT_BRIDGE, token = '') {
    this.url = normaliseBridgeUrl(url) || DEFAULT_BRIDGE;
    this.token = token || '';
  }

  /** Who is there? Never throws on an auth problem — look at `requiresToken`. */
  async probe() {
    const health = await send(this.url, { path: '/health', timeout: 2500, token: this.token });
    return {
      url: this.url,
      ok: health?.ok !== false,
      version: health?.version || 'unknown',
      lan: Boolean(health?.lan),
      app: Boolean(health?.app),
      requiresToken: Boolean(health?.requiresToken),
      paired: health?.paired !== false,
      addresses: Array.isArray(health?.addresses) ? health.addresses : [],
      port: health?.port || 0,
      printers: Array.isArray(health?.printers) ? health.printers : [],
    };
  }

  async discover() {
    const data = await send(this.url, { path: '/printers', timeout: 8000, token: this.token });
    return Array.isArray(data?.printers) ? data.printers : [];
  }

  capabilities(id) {
    return send(this.url, {
      path: `/printers/${encodeURIComponent(id)}/capabilities`,
      timeout: 12000,
      token: this.token,
    });
  }

  async probeAddress(address) {
    return send(this.url, {
      path: '/probe',
      method: 'POST',
      body: JSON.stringify({ address }),
      timeout: 15000,
      token: this.token,
    });
  }

  /**
   * Run a scan, reporting pages as they arrive.
   * @returns {Promise<Array<{blob:Blob, mime:string}>>}
   */
  async scan(id, options = {}, { onPage } = {}) {
    const response = await send(this.url, {
      path: `/printers/${encodeURIComponent(id)}/scan`,
      method: 'POST',
      body: JSON.stringify(options),
      timeout: 180_000,
      raw: true,
      token: this.token,
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

function splitMultipart(buffer, boundary) {
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
 * Look for bridges worth offering: this origin (when Scanlet is being served by
 * one), then the standard loopback address, then whatever the user used last.
 */
export async function detectBridges({ remember = null, sameOrigin = true } = {}) {
  const candidates = [];
  const add = (url, token = '') => {
    const clean = normaliseBridgeUrl(url);
    if (!clean) return;
    const existing = candidates.find((c) => c.url === clean);
    // Keep whichever variant carries a pairing code.
    if (existing) {
      if (!existing.token && token) existing.token = token;
      return;
    }
    candidates.push({ url: clean, token });
  };

  // A code we already hold for an address should be offered to that address,
  // whichever way we happen to have reached it.
  const rememberedToken = (url) => {
    const clean = normaliseBridgeUrl(url);
    return remember?.url && normaliseBridgeUrl(remember.url) === clean ? remember.token || '' : '';
  };

  if (sameOrigin && typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    add(location.origin, rememberedToken(location.origin));
  }
  add(DEFAULT_BRIDGE, rememberedToken(DEFAULT_BRIDGE));
  if (remember?.url) add(remember.url, remember.token);

  const found = [];
  for (const candidate of candidates) {
    try {
      const info = await new BridgeClient(candidate.url, candidate.token).probe();
      if (info.ok) {
        found.push({ ...info, token: candidate.token, sameOrigin: candidate.url === location?.origin });
      }
    } catch {
      /* not a bridge; keep looking */
    }
  }
  // A bridge we are already paired with beats one that still needs a code.
  found.sort((a, b) => Number(b.paired) - Number(a.paired));
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

export const probe = (url, token = '') => new BridgeClient(url, token).probe();
export const discover = (url, token = '') => new BridgeClient(url, token).discover();
export const capabilities = (url, id, token = '') => new BridgeClient(url, token).capabilities(id);
export const probeAddress = (url, address, token = '') => new BridgeClient(url, token).probeAddress(address);
export const scan = (url, id, options = {}, extra) => new BridgeClient(url).scan(id, options, extra);

/** Common eSCL colour modes, in the order most printers prefer them. */
export const COLOR_MODES = [
  { value: 'RGB24', label: 'Color' },
  { value: 'Grayscale8', label: 'Grayscale' },
  { value: 'BlackAndWhite1', label: 'Black & white' },
];
