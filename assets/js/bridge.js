/* Scanlet — optional scanning bridge.
 *
 * A browser cannot open a socket to a printer, so real network scanning needs a
 * helper on the machine. `bridge/scanlet-bridge.mjs` in this repository is that
 * helper: it discovers eSCL/AirScan devices over Bonjour and exposes a tiny
 * CORS-enabled HTTP API on 127.0.0.1. Everything else in Scanlet works without it.
 */

export const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';

async function request(url, { path, method = 'GET', body = null, timeout = 4000, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(new URL(path, url).toString(), {
      method,
      body,
      signal: controller.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `${response.status} ${response.statusText}`);
    }
    return raw ? response : response.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The bridge did not answer in time.');
    throw new Error(
      err.message === 'Failed to fetch'
        ? 'No bridge is listening there. Start it, then press Connect.'
        : err.message,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a bridge who it is and which printers it can see. */
export async function probe(url) {
  const health = await request(url, { path: '/health', timeout: 2500 });
  return {
    ok: health?.ok !== false,
    version: health?.version || 'unknown',
    printers: Array.isArray(health?.printers) ? health.printers : [],
  };
}

export async function discover(url) {
  const data = await request(url, { path: '/printers', timeout: 6000 });
  return Array.isArray(data?.printers) ? data.printers : [];
}

export async function capabilities(url, id) {
  return request(url, { path: `/printers/${encodeURIComponent(id)}/capabilities`, timeout: 8000 });
}

/** Reach a device that Bonjour did not announce, by host or host:port. */
export async function probeAddress(url, address) {
  const data = await request(url, {
    path: '/probe',
    method: 'POST',
    body: JSON.stringify({ address }),
    timeout: 15000,
  });
  return data;
}

/**
 * Run a scan and return one or more page images.
 * @returns {Promise<Array<{blob:Blob, mime:string}>>}
 */
export async function scan(url, id, options = {}) {
  const response = await request(url, {
    path: `/printers/${encodeURIComponent(id)}/scan`,
    method: 'POST',
    body: JSON.stringify(options),
    timeout: 180_000,
    raw: true,
  });
  return parseScanResponse(response);
}

async function parseScanResponse(response) {
  const type = response.headers.get('content-type') || '';
  if (type.startsWith('image/')) {
    const blob = await response.blob();
    return [{ blob, mime: type.split(';')[0] }];
  }
  if (type.startsWith('application/pdf')) {
    const blob = await response.blob();
    return [{ blob, mime: 'application/pdf' }];
  }
  if (type.startsWith('multipart/')) {
    const boundaryMatch = /boundary="?([^";]+)"?/i.exec(type);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!boundaryMatch) throw new Error('The bridge sent a malformed multi-page response.');
    return splitMultipart(buffer, boundaryMatch[1]);
  }
  throw new Error(`The bridge returned an unexpected content type: ${type || 'none'}`);
}

function splitMultipart(buffer, boundary) {
  const marker = new TextEncoder().encode(`--${boundary}`);
  const parts = [];
  let index = 0;
  while (index < buffer.length) {
    const start = indexOfBytes(buffer, marker, index);
    if (start === -1) break;
    const headerStart = start + marker.length;
    const headerEnd = indexOfBytes(buffer, new TextEncoder().encode('\r\n\r\n'), headerStart);
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

/** Common eSCL colour modes, in the order most printers prefer them. */
export const COLOR_MODES = [
  { value: 'RGB24', label: 'Color' },
  { value: 'Grayscale8', label: 'Grayscale' },
  { value: 'BlackAndWhite1', label: 'Black & white' },
];
