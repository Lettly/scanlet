#!/usr/bin/env node
/*
 * Scanlet scanning bridge
 * =======================
 *
 * A browser cannot open a socket to a printer, so network scanning needs a
 * helper running somewhere on your network. This is that helper — one file, no
 * dependencies, Node 18+.
 *
 *   node scanlet-bridge.mjs                    # this machine only (127.0.0.1)
 *   node scanlet-bridge.mjs --lan              # also serve Scanlet to your phone
 *   node scanlet-bridge.mjs --lan --tls        # …over https, so the camera and
 *                                              # PWA install work on mobile too
 *
 * In the default mode it is a private helper: bound to the loopback interface,
 * reachable only by Scanlet running on the same machine. With `--lan` it becomes
 * a small scan server that also serves the Scanlet app itself, so any device on
 * your network — a phone, a tablet — can open it and scan, with no install and
 * no mixed-content problems. Access is gated by a pairing token.
 *
 * It discovers scanners over Bonjour/mDNS (`_uscan._tcp`, `_uscans._tcp`,
 * `_scanner._tcp`) and drives them with eSCL — the driverless protocol Apple
 * AirScan and SANE's `escl` backend use.
 */

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION = '1.1.0';
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPES = ['_uscan._tcp.local', '_uscans._tcp.local', '_scanner._tcp.local'];
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ───────────────────────────── mDNS ───────────────────────────── */

const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 };

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const buffers = parts.map((part) => {
    const bytes = Buffer.from(part, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...buffers, Buffer.from([0])]);
}

function buildQuery(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id
  header.writeUInt16BE(0, 2); // flags: standard query
  header.writeUInt16BE(1, 4); // qdcount
  const question = Buffer.concat([
    encodeName(name),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(type, 0);
      b.writeUInt16BE(1, 2); // class IN
      return b;
    })(),
  ]);
  return Buffer.concat([header, question]);
}

function parseName(buffer, offset) {
  const labels = [];
  let jumped = false;
  let position = offset;
  let guard = 0;
  while (guard++ < 256) {
    const length = buffer[position];
    if (length === undefined) throw new Error('truncated name');
    if (length === 0) {
      position += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buffer[position + 1];
      if (!jumped) {
        offset = position + 2;
        jumped = true;
      }
      position = pointer;
      continue;
    }
    labels.push(buffer.toString('utf8', position + 1, position + 1 + length));
    position += length + 1;
  }
  return { name: labels.join('.'), next: jumped ? offset : position };
}

function parseMessage(buffer) {
  const records = [];
  if (buffer.length < 12) return records;
  const qdcount = buffer.readUInt16BE(4);
  const counts = [buffer.readUInt16BE(6), buffer.readUInt16BE(8), buffer.readUInt16BE(10)];
  let offset = 12;

  for (let i = 0; i < qdcount; i++) {
    const parsed = parseName(buffer, offset);
    offset = parsed.next + 4;
  }

  for (const count of counts) {
    for (let i = 0; i < count; i++) {
      let parsed;
      try {
        parsed = parseName(buffer, offset);
      } catch {
        return records;
      }
      offset = parsed.next;
      const type = buffer.readUInt16BE(offset);
      const rdlength = buffer.readUInt16BE(offset + 8);
      const rdataStart = offset + 10;
      const rdata = buffer.subarray(rdataStart, rdataStart + rdlength);
      offset = rdataStart + rdlength;

      try {
        if (type === TYPE.PTR) records.push({ name: parsed.name, type, value: parseName(buffer, rdataStart).name });
        else if (type === TYPE.SRV) {
          const port = rdata.readUInt16BE(4);
          const target = parseName(buffer, rdataStart + 6).name;
          records.push({ name: parsed.name, type, value: { port, target } });
        } else if (type === TYPE.TXT) {
          const txt = {};
          let cursor = 0;
          while (cursor < rdata.length) {
            const length = rdata[cursor];
            const entry = rdata.toString('utf8', cursor + 1, cursor + 1 + length);
            const eq = entry.indexOf('=');
            txt[eq === -1 ? entry : entry.slice(0, eq)] = eq === -1 ? '' : entry.slice(eq + 1);
            cursor += length + 1;
          }
          records.push({ name: parsed.name, type, value: txt });
        } else if (type === TYPE.A && rdlength === 4) {
          records.push({ name: parsed.name, type, value: [...rdata].join('.') });
        } else if (type === TYPE.AAAA && rdlength === 16) {
          const groups = [];
          for (let g = 0; g < 16; g += 2) groups.push(rdata.readUInt16BE(g).toString(16));
          records.push({ name: parsed.name, type, value: groups.join(':') });
        }
      } catch {
        /* skip malformed records */
      }
    }
  }
  return records;
}

function interfaceAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** Query every eSCL-ish service type and collect what the network answers. */
export function discover({ timeout = 2500 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const records = [];

    const finish = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(records);
    };

    socket.on('message', (message) => {
      records.push(...parseMessage(message));
    });

    socket.on('error', () => finish());

    socket.bind(MDNS_PORT, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(255);
        socket.addMembership(MDNS_ADDR);
      } catch {
        /* some platforms refuse the second bind; discovery still works */
      }
      for (const service of SERVICE_TYPES) {
        const query = buildQuery(service, TYPE.PTR);
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDR, () => {});
        for (const address of interfaceAddresses()) {
          socket.send(query, 0, query.length, MDNS_PORT, address, () => {});
        }
      }
    });

    setTimeout(finish, timeout);
  });
}

/** Fold raw records into a list of printers. */
export function summarise(records) {
  const ptr = new Map();
  const srv = new Map();
  const txt = new Map();
  const addresses = new Map();

  for (const record of records) {
    if (record.type === TYPE.PTR && SERVICE_TYPES.includes(record.name)) ptr.set(record.value, record.name);
    else if (record.type === TYPE.SRV) srv.set(record.name, record.value);
    else if (record.type === TYPE.TXT) txt.set(record.name, record.value);
    else if ((record.type === TYPE.A || record.type === TYPE.AAAA) && !addresses.has(record.name)) {
      addresses.set(record.name, record.value);
    }
  }

  const printers = [];
  for (const [instance, service] of ptr) {
    const target = srv.get(instance);
    const properties = txt.get(instance) || {};
    const address = target ? addresses.get(target.target) : null;
    if (!address || !target) continue;
    const secure = service === '_uscans._tcp.local';
    printers.push({
      id: instance,
      name: properties.ty || instance.replace(/\._uscans?\._tcp$|\._scanner\._tcp$/, '').replace(/\.local$/, ''),
      model: properties.ty || '',
      note: properties.note || '',
      address,
      port: target.port || (secure ? 443 : 80),
      path: '/eSCL',
      secure,
      tls: secure,
      resolutions: (properties.rs || '').split(',').filter(Boolean).map(Number),
      colorModes: (properties.cs || '').split(',').filter(Boolean),
      formats: (properties.pdl || '').split(',').filter(Boolean),
      duplex: properties.duplex === 'T',
    });
  }
  // de-duplicate by address:port
  const seen = new Set();
  return printers.filter((printer) => {
    const key = `${printer.address}:${printer.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ───────────────────────────── eSCL client ───────────────────────────── */

function baseUrl(printer) {
  return `${printer.tls ? 'https' : 'http'}://${printer.address}:${printer.port}${printer.path || '/eSCL'}`;
}

/** Minimal HTTP(S) request that tolerates the self-signed certs eSCL uses. */
function httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers,
        rejectUnauthorized: false,
        timeout,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('the scanner did not answer in time')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function numericTag(xml, tag) {
  const match = new RegExp(`<[^>]*${tag}[^>]*>\\s*(\\d+)\\s*<`, 'i').exec(xml);
  return match ? Number(match[1]) : null;
}

function allOfTag(xml, tag) {
  return [...xml.matchAll(new RegExp(`<[^>]*${tag}[^>]*>\\s*(\\d+)\\s*<`, 'gi'))].map((m) => Number(m[1]));
}

/**
 * Maximum page extent per input source, in eSCL's 1/300-inch units. A device
 * usually allows a longer sheet in the feeder than on the glass, and asking for
 * a region larger than a source supports gets the job rejected.
 */
function sourceMaxima(xml) {
  const maxima = {};
  const read = (tag, key) => {
    const section = new RegExp(`<[^>]*${tag}[\\s>][\\s\\S]*?</[^>]*${tag}>`, 'i').exec(xml);
    if (!section) return;
    const maxWidth = numericTag(section[0], 'MaxWidth');
    const maxHeight = numericTag(section[0], 'MaxHeight');
    if (maxWidth || maxHeight) maxima[key] = { maxWidth, maxHeight };
  };
  read('Platen', 'Platen');
  read('Adf', 'Feeder');
  return maxima;
}

/** Read ScannerCapabilities and boil it down to what the UI needs. */
export async function capabilities(printer) {
  const response = await httpRequest(`${baseUrl(printer)}/ScannerCapabilities`, { timeout: 12000 });
  if (response.status !== 200) {
    throw new Error(`The scanner refused to describe itself (HTTP ${response.status}).`);
  }
  const xml = response.body.toString('utf8');
  const sources = [];
  if (/<[^>]*InputSource[^>]*>\s*Platen\s*</i.test(xml) || /PlatenInputCaps/i.test(xml)) sources.push('Platen');
  if (/<[^>]*InputSource[^>]*>\s*Feeder\s*</i.test(xml) || /AdfInputCaps/i.test(xml)) sources.push('Feeder');
  const colorModes = [...xml.matchAll(/<[^>]*ColorMode[^>]*>\s*([A-Za-z0-9]+)\s*</g)].map((m) => m[1]);
  const formats = [...xml.matchAll(/<[^>]*DocumentFormat[^>]*>\s*([^\s<]+)\s*</g)].map((m) => m[1]);
  const resolutions = [...xml.matchAll(/<[^>]*XResolution[^>]*>\s*(\d+)\s*</g)].map((m) => Number(m[1]));

  const unique = (list) => [...new Set(list)];

  return {
    sources: sources.length ? unique(sources) : ['Platen'],
    colorModes: unique(colorModes).length ? unique(colorModes) : ['RGB24', 'Grayscale8'],
    formats: unique(formats).length ? unique(formats) : ['image/jpeg'],
    resolutions: unique(resolutions).filter(Boolean).sort((a, b) => a - b),
    duplex: /<[^>]*Duplex[^>]*>\s*true\s*</i.test(xml),
    maxima: sourceMaxima(xml),
    maxWidth: Math.max(2550, ...allOfTag(xml, 'MaxWidth')),
    maxHeight: Math.max(3300, ...allOfTag(xml, 'MaxHeight')),
  };
}

function scanSettingsXml(printer, options, caps) {
  const resolution = Number(options.resolution) || 200;
  const inputSource = options.inputSource === 'Feeder' ? 'Feeder' : 'Platen';
  const colorMode = options.colorMode || 'RGB24';
  const format = options.format || 'image/jpeg';
  const duplex = options.duplex === true || options.duplex === 'true' ? 'true' : 'false';

  // eSCL measures the region in 1/300-inch units whatever the resolution is, so
  // the device's own maximum is passed through untouched; when no maximum is
  // known, no region is sent and the device uses its default page.
  const source = caps.maxima?.[inputSource];
  const regions =
    source?.maxWidth && source?.maxHeight
      ? `  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${source.maxWidth}</pwg:Width>
      <pwg:Height>${source.maxHeight}</pwg:Height>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
${regions}  <pwg:InputSource>${inputSource}</pwg:InputSource>
  <scan:ColorMode>${colorMode}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>${format}</pwg:DocumentFormat>
  <scan:DocumentFormatExt>${format}</scan:DocumentFormatExt>
  <scan:Duplex>${duplex}</scan:Duplex>
</scan:ScanSettings>`;
}

/** Create a scan job and collect every page it produces (an ADF can yield many). */
export async function runScan(printer, options = {}) {
  const caps = options.caps || (await capabilities(printer));
  const xml = scanSettingsXml(printer, options, caps);
  const created = await httpRequest(`${baseUrl(printer)}/ScanJobs`, {
    method: 'POST',
    headers: { 'content-type': 'text/xml', 'content-length': Buffer.byteLength(xml) },
    body: xml,
    timeout: 30000,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`The scanner rejected the job (HTTP ${created.status}).`);
  }
  const location = created.headers.location;
  if (!location) throw new Error('The scanner did not return a job location.');
  const jobUrl = new URL(location, `${baseUrl(printer)}/`).toString();

  const pages = [];
  for (let page = 0; page < 200; page++) {
    const document = await httpRequest(`${jobUrl}/NextDocument`, { timeout: 120000 });
    if (document.status === 404 || document.status === 204) break;
    if (document.status !== 200 || !document.body.length) {
      if (!pages.length) throw new Error(`The scanner returned no image (HTTP ${document.status}).`);
      break;
    }
    pages.push({
      body: document.body,
      mime: (document.headers['content-type'] || 'image/jpeg').split(';')[0],
    });
  }
  if (!pages.length) throw new Error('The scanner produced no pages.');
  return pages;
}

/**
 * Reach a device by address, for networks where Bonjour is blocked or the
 * printer does not advertise itself. Tries the usual eSCL locations.
 */
export async function probeAddress(address) {
  const cleaned = String(address || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!cleaned) throw new Error('Enter an address such as 192.168.1.42 or 192.168.1.42:8080.');
  const [host, portPart] = cleaned.split('/')[0].split(':');
  const candidates = [
    { secure: false, port: Number(portPart) || 80, path: '/eSCL' },
    { secure: false, port: Number(portPart) || 80, path: '' },
  ];
  for (const candidate of candidates) {
    const printer = {
      id: `manual:${host}:${candidate.port}`,
      name: host,
      model: '',
      note: '',
      address: host,
      ...candidate,
      manual: true,
    };
    try {
      const caps = await capabilities(printer);
      return { printer, caps };
    } catch {
      /* try the next location */
    }
  }
  throw new Error(`No eSCL scanner answered at ${cleaned}.`);
}

/* ───────────────────────────── pairing ───────────────────────────── */

export function createToken() {
  return crypto.randomBytes(9).toString('base64url');
}

/** Constant-time-ish comparison so a token cannot be guessed by timing. */
function sameToken(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function tokenFrom(request, url) {
  return request.headers['x-scanlet-token'] || url.searchParams.get('token') || '';
}

/* ───────────────────────────── static files ───────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Serve a file from `root`, refusing anything that escapes it. */
export function serveStatic(root, urlPath, response, { head = false } = {}) {
  if (!root) return false;
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const relative = clean === '/' || clean === '' ? 'index.html' : clean.replace(/^\/+/, '');

  // Never serve dotfiles: that is where .git, .env and friends live.
  if (relative.split('/').some((segment) => segment.startsWith('.') && segment !== '.')) return false;

  const target = path.resolve(root, relative);
  const resolvedRoot = path.resolve(root);
  const rootWithSep = resolvedRoot + path.sep;
  if (target !== path.join(resolvedRoot, 'index.html') && !target.startsWith(rootWithSep)) return false;

  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return false;
  }
  if (stats.isDirectory()) return serveStatic(root, path.join(relative, 'index.html'), response);

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  // This server is on your own network and the files are small, so always let
  // the browser revalidate: a stale asset here is far more annoying than a
  // refetch. The shell and the worker must never be stale at all.
  const noCache = /(^|\/)(index\.html|sw\.js|manifest\.webmanifest)$/.test(relative);
  response.writeHead(200, {
    'content-type': type,
    'content-length': stats.size,
    'cache-control': noCache ? 'no-store' : 'no-cache',
  });
  if (head) {
    response.end();
    return true;
  }
  fs.createReadStream(target).pipe(response);
  return true;
}

/* ───────────────────────────── HTTP API ───────────────────────────── */

function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, x-scanlet-token',
    // Chrome's Local Network Access preflight
    'access-control-allow-private-network': 'true',
    ...extra,
  };
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  response.writeHead(status, corsHeaders({ 'content-type': 'application/json', 'content-length': body.length }));
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('The request body was not valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

/**
 * The request handler, shared by the http and https servers.
 * @param {object} options
 * @param {(message:string)=>void} [options.log]
 * @param {string} [options.token]   when set, every device/scan route needs it
 * @param {string} [options.appDir]  directory to serve the Scanlet app from
 */
export function createHandler({ log = () => {}, token = '', appDir = '', lan = false, port = 0, certificatePath = '' } = {}) {
  let cache = { at: 0, printers: [], caps: new Map() };
  const manual = new Map(); // id → printer, added by address

  const listPrinters = async ({ force = false } = {}) => {
    if (!force && Date.now() - cache.at < 15000 && cache.printers.length) return cache.printers;
    const records = await discover();
    const printers = summarise(records);
    cache = { at: Date.now(), printers, caps: cache.caps };
    log(`discovered ${printers.length} device(s)`);
    return printers;
  };

  const allPrinters = async () => [...manual.values(), ...(await listPrinters())];

  /** Cheap, cache-only view — used by /health so probing stays instant. */
  const cachedPrinters = () => [...manual.values(), ...cache.printers];

  async function findPrinter(id) {
    const decoded = decodeURIComponent(id);
    if (manual.has(decoded)) return manual.get(decoded);
    let printers = cache.printers;
    if (!printers.find((printer) => printer.id === decoded)) printers = await listPrinters();
    const printer = printers.find((candidate) => candidate.id === decoded);
    if (!printer) throw new Error('That device is no longer on the network. Scan for printers again.');
    return printer;
  }

  const SCAN_FORMATS = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
  };

  /**
   * One scan, one plain URL: `/printers/<id>/scan.pdf` or `.jpg`.
   *
   * This exists so anything that can only fetch a URL can still scan — an iOS
   * Shortcut ("Get Contents of URL" → "Save to Files"), a cron job, a curl one
   * liner. PDF is asked of the device itself, which assembles a multi-page ADF
   * job server-side; if the device refuses, we fall back to the first page as
   * an image rather than pretending.
   */
  async function serveSingleScan(response, printer, extension, url) {
    const caps = cache.caps.get(printer.id) || (await capabilities(printer));
    const query = url.searchParams;
    const wantsPdf = extension === 'pdf';
    const wanted = SCAN_FORMATS[extension];

    const options = {
      resolution: Number(query.get('resolution') || query.get('dpi')) || 300,
      colorMode: query.get('colorMode') || query.get('color') || 'RGB24',
      inputSource:
        (query.get('inputSource') || query.get('source') || '').toLowerCase() === 'feeder' ||
        query.get('adf') === 'true'
          ? 'Feeder'
          : 'Platen',
      duplex: query.get('duplex') === 'true',
      caps,
    };

    let pages;
    if (wantsPdf) {
      pages = await runScan(printer, { ...options, format: wanted }).catch(() => null);
      if (!pages) {
        log('the device refused a PDF job — asking for an image instead');
        pages = await runScan(printer, { ...options, format: 'image/jpeg' });
      }
    } else {
      pages = await runScan(printer, { ...options, format: wanted });
    }

    const first = pages[0];
    const contentType = (first.mime || wanted).split(';')[0];
    const headers = corsHeaders({
      'content-type': contentType,
      'content-length': first.body.length,
      'cache-control': 'no-store',
      'content-disposition': `inline; filename="scanlet.${extension}"`,
    });
    // Report against what the *caller* asked for, so a Shortcut that wanted a
    // PDF and got a JPEG can tell.
    if (contentType !== wanted) headers['x-scanlet-format'] = contentType;
    if (pages.length > 1) headers['x-scanlet-note'] = `device returned ${pages.length} parts; served the first`;

    log(`single-url scan → ${contentType} (${first.body.length} bytes)`);
    response.writeHead(200, headers);
    return response.end(first.body);
  }

  return async function handle(request, response) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      return response.end();
    }

    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const authorised = !token || sameToken(tokenFrom(request, url), token);
    const hostPort = Number((request.headers.host || '').split(':')[1]) || port;

    try {
      // ── liveness: always open, and deliberately cheap so probing is instant ──
      if (url.pathname === '/health') {
        return sendJson(response, 200, {
          ok: true,
          version: VERSION,
          lan,
          requiresToken: Boolean(token),
          paired: authorised,
          app: Boolean(appDir),
          // LAN addresses let a paired client show a QR code for another device.
          addresses: authorised ? interfaceAddresses() : [],
          port: hostPort,
          printers: authorised ? cachedPrinters() : [],
        });
      }

      // ── the TLS certificate, so a phone can install and trust it ──
      // iOS will not let URLSession (Shortcuts) or the camera trust a
      // self-signed certificate until it is installed as a profile, and the
      // only way to get it onto the device is to serve it.
      if (url.pathname === '/certificate.pem') {
        if (!certificatePath) return sendJson(response, 404, { error: 'This bridge is not serving TLS.' });
        try {
          const pem = fs.readFileSync(certificatePath);
          response.writeHead(200, corsHeaders({
            'content-type': 'application/x-pem-file',
            'content-length': pem.length,
            'content-disposition': 'attachment; filename="scanlet-bridge.pem"',
            'cache-control': 'no-store',
          }));
          return response.end(pem);
        } catch {
          return sendJson(response, 404, { error: 'The certificate file is missing.' });
        }
      }

      // ── the app itself is public: a phone has to load it *before* it can
      //    present the pairing code it was given ──
      const isApi = /^\/(health|printers|probe|scan\.)/.test(url.pathname);
      const isRead = request.method === 'GET' || request.method === 'HEAD';
      if (isRead && appDir && !isApi) {
        if (serveStatic(appDir, url.pathname, response, { head: request.method === 'HEAD' })) {
          return undefined;
        }
        return sendJson(response, 404, { error: 'Not found' });
      }

      if (!authorised) {
        return sendJson(response, 401, {
          error: 'This bridge needs a pairing code. Open the address shown by the bridge, including its #code.',
          requiresToken: true,
        });
      }

      if (url.pathname === '/printers') {
        if (url.searchParams.has('refresh')) await listPrinters({ force: true });
        return sendJson(response, 200, { printers: await allPrinters() });
      }

      if (url.pathname === '/probe' && request.method === 'POST') {
        const { address } = await readBody(request);
        const { printer, caps } = await probeAddress(address);
        manual.set(printer.id, printer);
        cache.caps.set(printer.id, caps);
        log(`added ${printer.address}:${printer.port} by address`);
        return sendJson(response, 200, { printer, caps });
      }

      if (parts[0] === 'printers' && parts[2] === 'capabilities') {
        const printer = await findPrinter(parts[1]);
        const caps = await capabilities(printer);
        cache.caps.set(printer.id, caps);
        return sendJson(response, 200, caps);
      }

      // ── a single, bookmarkable URL: /printers/<id>/scan.pdf ──
      const singleScan = /^scan\.(pdf|jpe?g|png)$/i.exec(parts[2] || '');
      if (parts[0] === 'printers' && parts.length === 3 && request.method === 'GET' && singleScan) {
        return serveSingleScan(response, await findPrinter(parts[1]), singleScan[1].toLowerCase(), url);
      }

      // …and a friendlier form for humans and scripts, with a plain address:
      //   /scan.pdf?printer=192.168.1.42&token=…
      const rootScan = /^\/scan\.(pdf|jpe?g|png)$/i.exec(url.pathname);
      if (rootScan && request.method === 'GET') {
        const reference = url.searchParams.get('printer') || url.searchParams.get('address') || '';
        let printer;
        if (reference) {
          printer = (await probeAddress(reference)).printer;
        } else {
          const known = await allPrinters();
          if (known.length !== 1) {
            throw new Error(
              'Name the printer, for example /scan.pdf?printer=192.168.1.42 — ' +
                `${known.length} devices are known.`,
            );
          }
          [printer] = known;
        }
        const found = await capabilities(printer).catch(() => null);
        if (found) cache.caps.set(printer.id, found);
        return serveSingleScan(response, printer, rootScan[1].toLowerCase(), url);
      }

      if (parts[0] === 'printers' && parts[2] === 'scan') {
        const printer = await findPrinter(parts[1]);
        const options = await readBody(request);
        const caps = cache.caps.get(printer.id) || (await capabilities(printer));
        const pages = await runScan(printer, { ...options, caps });
        log(`scan produced ${pages.length} page(s)`);

        const boundary = 'scanlet-page';
        const chunks = [];
        for (const page of pages) {
          chunks.push(Buffer.from(`--${boundary}\r\ncontent-type: ${page.mime}\r\n\r\n`));
          chunks.push(page.body);
          chunks.push(Buffer.from('\r\n'));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        const body = Buffer.concat(chunks);
        response.writeHead(200, corsHeaders({
          'content-type': `multipart/mixed; boundary=${boundary}`,
          'content-length': body.length,
        }));
        return response.end(body);
      }

      if (parts[0] === 'printers' && parts.length === 2 && request.method === 'GET') {
        const printer = await findPrinter(parts[1]);
        return sendJson(response, 200, { printer });
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      log(`error: ${error.message}`);
      return sendJson(response, 502, { error: error.message });
    }
  };
}

/** Convenience wrapper for the common case. */
export function createServer(options = {}) {
  return http.createServer(createHandler(options));
}

/* ───────────────────────────── tls ───────────────────────────── */

/**
 * Generate a self-signed certificate with openssl. Browsers warn once, but an
 * https origin is a *secure context*: that is what makes the camera, the
 * service worker and PWA installation work on a phone.
 */
function ensureCertificate(dir, host) {
  const keyPath = path.join(dir, 'scanlet-key.pem');
  const certPath = path.join(dir, 'scanlet-cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return { keyPath, certPath };
  fs.mkdirSync(dir, { recursive: true });
  const addresses = [...new Set([host, ...interfaceAddresses()])].filter(Boolean);
  const altNames = ['DNS:localhost', ...addresses.map((ip) => `IP:${ip}`)].join(',');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '825',
      '-subj', '/CN=Scanlet Bridge',
      '-addext', `subjectAltName=${altNames}`,
    ], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `Could not create a certificate (is openssl installed?): ${error.message.split('\n')[0]}`,
    );
  }
  return { keyPath, certPath };
}

/* ───────────────────────────── entry point ───────────────────────────── */

function resolveAppDir(explicit) {
  const candidates = explicit ? [explicit] : [path.resolve(HERE, '..')];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'index.html'))) return path.resolve(candidate);
    } catch {
      /* keep looking */
    }
  }
  return '';
}

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8787' },
      host: { type: 'string', default: '' },
      lan: { type: 'boolean', default: false },
      tls: { type: 'boolean', default: false },
      token: { type: 'string', default: '' },
      app: { type: 'string', default: '' },
      'no-serve': { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const log = values.quiet ? () => {} : (message) => console.log(`[scanlet] ${message}`);
  const lan = values.lan;
  const host = values.host || (lan ? '0.0.0.0' : '127.0.0.1');
  const port = Number(values.port) || 8787;
  const token = values.token || (lan ? createToken() : '');
  const appDir = values['no-serve'] ? '' : resolveAppDir(values.app);

  if (values.app && !appDir) {
    console.error(`Scanlet: no index.html in ${values.app} — not serving the app.`);
  }

  let scheme = 'http';
  let tlsOptions = null;
  let certificatePath = '';

  if (values.tls) {
    try {
      const { keyPath, certPath } = ensureCertificate(path.join(HERE, '.certs'), '127.0.0.1');
      certificatePath = certPath;
      tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      scheme = 'https';
    } catch (error) {
      console.error(`Scanlet: ${error.message}`);
      console.error('Scanlet: continuing over http instead.');
    }
  }

  const handler = createHandler({ log, token, appDir, lan, port, certificatePath });
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);

  const addresses = interfaceAddresses();
  const printUrl = (address) => `${scheme}://${address}:${port}/${token ? `#s=${token}` : ''}`;

  server.listen(port, host, () => {
    console.log(`Scanlet bridge ${VERSION}`);
    console.log(`Listening on ${scheme}://${host}:${port}`);
    if (appDir) {
      console.log('');
      console.log('  Open Scanlet on this machine:  ' + printUrl('127.0.0.1'));
      if (lan) {
        console.log('  Open Scanlet on your phone:    ' + printUrl(addresses[0] || '<your-lan-ip>'));
        if (addresses.length > 1) {
          for (const address of addresses.slice(1)) console.log(`                                 ${printUrl(address)}`);
        }
        console.log('');
        console.log('  The link carries a pairing code. Anyone on your network with it can');
        console.log('  reach your printers, so treat it like a password.');
        if (values.tls) {
          console.log('');
          console.log('  Your browser will warn about the self-signed certificate once —');
          console.log('  accept it, and the camera, service worker and PWA install all work.');
          console.log('');
          console.log('  iPhone, for a Shortcut or the camera: install the certificate with');
          console.log(`    http://${addresses[0] || '<your-lan-ip>'}:${port}/certificate.pem`);
          console.log('  then trust it in Settings → General → About → Certificate Trust Settings.');
        } else if (lan) {
          console.log('');
          console.log('  Over http, a phone cannot use its camera or install the PWA');
          console.log('  (browsers require https for both). Scanning works either way;');
          console.log('  add --tls for the full experience.');
        }
      } else {
        console.log('  (add --lan to also serve it to your phone)');
      }
      console.log('');
    } else {
      console.log('Open Scanlet, press “Scanner”, then “Connect”. Ctrl-C to stop.');
    }
    log('looking for scanners over Bonjour…');
    discover({ timeout: 2500 })
      .then((records) => {
        const printers = summarise(records);
        if (!printers.length) log('no eSCL/AirScan scanner answered — you can still add one by address');
        for (const printer of printers) log(`found ${printer.name} at ${printer.address}:${printer.port}`);
      })
      .catch(() => log('discovery failed; add a device by address instead'));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
