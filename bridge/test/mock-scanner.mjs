#!/usr/bin/env node
/*
 * A fake eSCL scanner, for testing the bridge without a real printer.
 *
 *   node bridge/test/mock-scanner.mjs --port 8199 --pages 3
 *
 * It implements just enough of the eSCL / AirScan protocol:
 *   GET  /eSCL/ScannerCapabilities
 *   POST /eSCL/ScanJobs               → 201 + Location
 *   GET  /eSCL/ScanJobs/<id>/NextDocument → a JPEG, then 404 when the ADF is empty
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';

/** A real 1×1 white JPEG, so the bytes are decodable by the client too. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const tinyJpeg = () => Buffer.from(TINY_JPEG_BASE64, 'base64');

/* ── a minimal PNG encoder, used to fake a real scanned page ── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw something that looks like a scanned page, deterministically. */
function renderPage(index, width = 1240, height = 1754) {
  const rgb = Buffer.alloc(width * height * 3, 0xff);
  const ink = (x, y, w, h) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
        const offset = (yy * width + xx) * 3;
        rgb[offset] = 24;
        rgb[offset + 1] = 26;
        rgb[offset + 2] = 34;
      }
    }
  };

  const left = 140;
  const right = width - 140;
  ink(left, 150, 460, 26); // title
  ink(left, 205, 300, 12);

  let y = 290;
  let seed = index * 7919 + 13;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  while (y < height - 200) {
    const lines = 1 + Math.floor(random() * 3);
    for (let i = 0; i < lines && y < height - 200; i++) {
      const width2 = Math.round((right - left) * (0.55 + random() * 0.45));
      ink(left, y, width2, 9);
      y += 22;
    }
    if (random() < 0.22) y += 18; // paragraph gap
    else y += 12;
  }
  ink(left, height - 150, 220, 8); // footer
  return encodePng(width, height, rgb);
}

const CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:MakeAndModel>Scanlet Mock Scanner</pwg:MakeAndModel>
  <scan:Platen>
    <scan:PlatenInputCaps>
      <scan:MinWidth>600</scan:MinWidth>
      <scan:MaxWidth>2550</scan:MaxWidth>
      <scan:MinHeight>600</scan:MinHeight>
      <scan:MaxHeight>3300</scan:MaxHeight>
      <scan:SupportedScanSettings>
        <scan:SupportedScanResolution>
          <scan:XResolution>200</scan:XResolution>
          <scan:YResolution>200</scan:YResolution>
        </scan:SupportedScanResolution>
        <scan:SupportedScanResolution>
          <scan:XResolution>300</scan:XResolution>
          <scan:YResolution>300</scan:YResolution>
        </scan:SupportedScanResolution>
        <scan:ColorMode>RGB24</scan:ColorMode>
        <scan:ColorMode>Grayscale8</scan:ColorMode>
      </scan:SupportedScanSettings>
    </scan:PlatenInputCaps>
  </scan:Platen>
  <scan:Adf>
    <scan:ADFInputCaps>
      <scan:MaxWidth>2550</scan:MaxWidth>
      <scan:MaxHeight>4200</scan:MaxHeight>
      <scan:Duplex>true</scan:Duplex>
      <scan:SupportedScanSettings>
        <scan:ColorMode>Grayscale8</scan:ColorMode>
        <scan:DocumentFormat>image/jpeg</scan:DocumentFormat>
      </scan:SupportedScanSettings>
    </scan:ADFInputCaps>
  </scan:Adf>
</scan:ScannerCapabilities>`;

/** Build a small but genuinely valid single-page PDF, so tests can assert `%PDF`. */
function buildPdf(index, width = 595, height = 842) {
  const bars = [];
  bars.push('0.06 0.07 0.13 rg');
  bars.push(`60 ${height - 100} 300 22 re f`);
  for (let i = 0; i < 14; i++) {
    if (i === index % 14) continue;
    bars.push(`60 ${height - 160 - i * 34} ${420 - (i % 5) * 40} 9 re f`);
  }
  const content = `${bars.join('\n')}\n`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function createMockScanner({ pages = 3, delayMs = 0, render = false, pdf = true } = {}) {
  let nextJob = 1;
  const jobs = new Map();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/eSCL/ScannerCapabilities') {
      response.writeHead(200, { 'content-type': 'text/xml' });
      return response.end(CAPABILITIES);
    }

    if (path === '/eSCL/ScanJobs' && request.method === 'POST') {
      const chunks = [];
      request.on('data', (c) => chunks.push(c));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const wantsPdf = /application\/pdf/i.test(body);
        if (wantsPdf && !pdf) {
          // A device that cannot assemble a PDF server-side.
          response.writeHead(415, { 'content-type': 'text/plain' });
          response.end('unsupported document format');
          return;
        }
        const id = nextJob++;
        jobs.set(id, { remaining: pages, pdf: wantsPdf });
        response.writeHead(201, {
          location: `http://127.0.0.1:${server.address().port}/eSCL/ScanJobs/${id}`,
        });
        response.end();
      });
      return undefined;
    }

    const document = /^\/eSCL\/ScanJobs\/(\d+)\/NextDocument$/.exec(path);
    if (document) {
      const job = jobs.get(Number(document[1]));
      if (!job || job.remaining <= 0) {
        response.writeHead(404);
        return response.end();
      }
      const served = pages - job.remaining;
      job.remaining -= 1;
      const send = () => {
        if (job.pdf) {
          const body = buildPdf(served);
          response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length });
          response.end(body);
        } else if (render) {
          const image = renderPage(served);
          response.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length });
          response.end(image);
        } else {
          response.writeHead(200, { 'content-type': 'image/jpeg' });
          response.end(tinyJpeg());
        }
      };
      if (delayMs) setTimeout(send, delayMs);
      else send();
      return undefined;
    }

    response.writeHead(404);
    return response.end('not found');
  });

  return server;
}

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8199' },
      pages: { type: 'string', default: '3' },
      delay: { type: 'string', default: '0' },
      render: { type: 'boolean', default: false },
      pdf: { type: 'boolean', default: true },
    },
  });
  const server = createMockScanner({
    pages: Number(values.pages),
    delayMs: Number(values.delay),
    render: values.render,
    pdf: values.pdf,
  });
  server.listen(Number(values.port), '127.0.0.1', () => {
    console.log(
      `mock scanner on http://127.0.0.1:${values.port}/eSCL  (${values.pages} pages per job` +
        `${values.render ? ', rendered page images' : ''}${values.pdf ? ', PDF capable' : ', refuses PDF'})`,
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
