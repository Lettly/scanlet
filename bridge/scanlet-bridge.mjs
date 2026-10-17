#!/usr/bin/env node
/*
 * Scanlet scanning bridge
 * =======================
 *
 * A browser cannot open a socket to a printer, so network scanning needs a
 * helper running on your own machine. This is that helper — one file, no
 * dependencies, Node 18+.
 *
 *   node scanlet-bridge.mjs            # listen on 127.0.0.1:8787
 *   node scanlet-bridge.mjs --port 9000 --host 127.0.0.1
 *
 * It discovers scanners advertised over Bonjour/mDNS (`_uscan._tcp`,
 * `_uscans._tcp`, `_scanner._tcp`) and drives them with eSCL — the same
 * driverless protocol Apple AirScan and SANE's `escl` backend use. Nothing
 * leaves your network: the HTTP API is bound to the loopback interface only.
 */

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import { parseArgs } from 'node:util';

const VERSION = '1.0.0';
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPES = ['_uscan._tcp.local', '_uscans._tcp.local', '_scanner._tcp.local'];

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
      path: secure ? '/eSCL' : '/eSCL',
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

function parseXmlAttributes(xml, tag) {
  const block = new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*${tag}>`, 'i').exec(xml);
  return block ? block[1] : '';
}

function numericTag(xml, tag) {
  const match = new RegExp(`<[^>]*${tag}[^>]*>\\s*(\\d+)\\s*<`, 'i').exec(xml);
  return match ? Number(match[1]) : null;
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
  const maxWidth = numericTag(xml, 'MaxWidth') || 2550;
  const maxHeight = numericTag(xml, 'MaxHeight') || 3300;

  return {
    sources: sources.length ? unique(sources) : ['Platen'],
    colorModes: unique(colorModes).length ? unique(colorModes) : ['RGB24', 'Grayscale8'],
    formats: unique(formats).length ? unique(formats) : ['image/jpeg'],
    resolutions: unique(resolutions).filter(Boolean).sort((a, b) => a - b),
    duplex: /<[^>]*Duplex[^>]*>\s*true\s*</i.test(xml),
    maxWidth,
    maxHeight,
  };
}

function scanSettingsXml(printer, options, caps) {
  const resolution = Number(options.resolution) || 200;
  const regionWidth = Math.round(((caps.maxWidth || 2550) / 300) * resolution);
  const regionHeight = Math.round(((caps.maxHeight || 3300) / 300) * resolution);
  const inputSource = options.inputSource === 'Feeder' ? 'Feeder' : 'Platen';
  const colorMode = options.colorMode || 'RGB24';
  const format = options.format || 'image/jpeg';
  const duplex = options.duplex === true || options.duplex === 'true' ? 'true' : 'false';

  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${regionWidth}</pwg:Width>
      <pwg:Height>${regionHeight}</pwg:Height>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${inputSource}</pwg:InputSource>
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
  const port = Number(portPart) || 80;
  const candidates = [
    { secure: false, port, path: '/eSCL' },
    { secure: false, port, path: '' },
  ];
  for (const candidate of candidates) {
    const printer = { id: `manual:${host}:${candidate.port}`, name: host, model: '', note: '', address: host, ...candidate, manual: true };
    try {
      const caps = await capabilities(printer);
      return { printer, caps };
    } catch {
      /* try the next location */
    }
  }
  throw new Error(`No eSCL scanner answered at ${cleaned}.`);
}

/* ───────────────────────────── HTTP API ───────────────────────────── */

function corsHeaders(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
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

export function createServer({ log = () => {} } = {}) {
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

  return http.createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      return response.end();
    }

    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    log(`${request.method} ${url.pathname}`);

    try {
      if (url.pathname === '/health') {
        const printers = await allPrinters();
        return sendJson(response, 200, { ok: true, version: VERSION, printers });
      }

      if (url.pathname === '/printers') {
        const printers = await allPrinters();
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
  });

  async function findPrinter(id) {
    const decoded = decodeURIComponent(id);
    if (manual.has(decoded)) return manual.get(decoded);
    let printers = cache.printers;
    if (!printers.find((printer) => printer.id === decoded)) printers = await listPrinters();
    const printer = printers.find((candidate) => candidate.id === decoded);
    if (!printer) throw new Error('That device is no longer on the network. Scan for printers again.');
    return printer;
  }
}

/* ───────────────────────────── entry point ───────────────────────────── */

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8787' },
      host: { type: 'string', default: '127.0.0.1' },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const log = values.quiet ? () => {} : (message) => console.log(`[scanlet] ${message}`);
  const server = createServer({ log });

  server.listen(Number(values.port), values.host, () => {
    console.log(`Scanlet bridge ${VERSION}`);
    console.log(`Listening on http://${values.host}:${values.port}`);
    console.log('Open Scanlet, press “Scanner”, then “Connect”. Ctrl-C to stop.');
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
