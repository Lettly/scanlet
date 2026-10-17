#!/usr/bin/env node
/*
 * Serve the app locally, with the headers production would send.
 *
 *   node tools/serve.mjs            # http://127.0.0.1:8899
 *   node tools/serve.mjs --port 9000
 *
 * `python3 -m http.server` sends no cache headers at all, so a browser caches
 * your JavaScript by heuristic and a reload silently serves the previous build —
 * which hides exactly the class of staleness bug this project has already been
 * bitten by twice. Here, the shell and the worker are never cached, and
 * everything else is revalidated with an ETag, so a reload always reflects the
 * files on disk.
 *
 * No dependencies, like the rest of the project.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MIME } from '../bridge/scanlet-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** The shell and the worker must never be cached; the rest revalidates. */
const NO_STORE = /(^|\/)(index\.html|sw\.js|manifest\.webmanifest)$/;

function resolveTarget(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const relative = clean === '/' || clean === '' ? 'index.html' : clean.replace(/^\/+/, '');
  if (relative.split('/').some((segment) => segment.startsWith('.') && segment !== '.')) return null;

  const target = path.resolve(ROOT, relative);
  const resolvedRoot = path.resolve(ROOT);
  if (target !== path.join(resolvedRoot, 'index.html') && !target.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  try {
    const stats = fs.statSync(target);
    if (stats.isDirectory()) return resolveTarget(path.join(relative, 'index.html'));
    return { target, stats };
  } catch {
    return null;
  }
}

function headersFor(target, stats, { head = false } = {}) {
  const relative = path.relative(ROOT, target);
  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': type,
    'content-length': stats.size,
    etag,
    'last-modified': stats.mtime.toUTCString(),
    // A reload must always reflect what is on disk.
    'cache-control': NO_STORE.test(relative) ? 'no-store' : 'no-cache',
  };
  if (head) delete headers['content-length'];
  return { headers, etag };
}

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8899' },
      host: { type: 'string', default: '127.0.0.1' },
    },
  });

  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      return response.end();
    }

    const found = resolveTarget(new URL(request.url, 'http://localhost').pathname);
    if (!found) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(`Not found: ${request.url}\n`);
    }

    const { headers, etag } = headersFor(found.target, found.stats, { head: request.method === 'HEAD' });
    // Revalidation: the browser asks, we answer with body or 304.
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      return response.end();
    }

    response.writeHead(200, headers);
    if (request.method === 'HEAD') return response.end();
    return fs.createReadStream(found.target).pipe(response);
  });

  server.listen(Number(values.port), values.host, () => {
    const { port } = server.address();
    console.log(`Scanlet on http://${values.host}:${port}/`);
    console.log('  no-store for the shell and the worker, ETag revalidation for everything else');
    console.log('  Ctrl-C to stop');
  });
}

main();
