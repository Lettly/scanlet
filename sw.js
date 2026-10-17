/* Scanlet — service worker.
 *
 * Two jobs:
 *
 *  1. Offline. The app shell is cached on install; CDN libraries (PDF.js,
 *     pdf-lib, Tesseract.js, JSZip, qrcode-generator) are cached as they are
 *     first used, so the app keeps working offline once it has been opened.
 *
 *  2. Receiving a share. On Android, Scanlet can be a share target: picking
 *     "Scanlet" in any app's share sheet POSTs the files here. A service worker
 *     is the only way a web app can receive a POST, so we stash the payload in
 *     the Cache API and redirect to the app, which picks it up. Safari does not
 *     implement share targets, so on iOS this never fires.
 */

const VERSION = 'scanlet-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/js/main.js',
  './assets/js/app.js',
  './assets/js/store.js',
  './assets/js/util.js',
  './assets/js/imaging.js',
  './assets/js/capture.js',
  './assets/js/pdfs.js',
  './assets/js/ocr.js',
  './assets/js/bridge.js',
  './assets/js/qr.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
];

/* Kept in step with assets/js/share.js, which reads what this writes. */
const SHARE_CACHE = 'scanlet-share';
const SHARE_ROUTE = 'share';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // `cache: 'reload'` skips the browser's HTTP cache. Without it an update
      // can be installed carrying stale copies of the very files it is meant
      // to replace.
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload' });
            if (response.ok) await cache.put(url, response);
          } catch {
            /* one missing file must not block the install */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== VERSION && key !== SHARE_CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** An absolute URL inside our scope — `new Request('./x')` has no base to resolve against. */
const inScope = (path) => new URL(path, self.registration.scope).toString();

/** Store a shared payload and send the browser to the app to collect it. */
async function receiveShare(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect(inScope('./index.html?share=unreadable'), 303);
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const cache = await caches.open(SHARE_CACHE);
  const files = form.getAll('files').filter((entry) => entry && typeof entry === 'object' && 'arrayBuffer' in entry);
  const manifest = { id, files: [], text: '', url: '' };

  for (const [index, file] of files.entries()) {
    const type = file.type || 'application/octet-stream';
    await cache.put(
      new Request(inScope(`./__shared/${id}/${index}`)),
      new Response(file, { headers: { 'content-type': type } }),
    );
    manifest.files.push({ name: file.name || `shared-${index + 1}`, type });
  }

  manifest.text = String(form.get('text') || form.get('title') || '');
  manifest.url = String(form.get('url') || '');
  await cache.put(
    new Request(inScope(`./__shared/${id}`)),
    new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }),
  );

  // Old shares should not accumulate forever.
  const keys = await cache.keys();
  const stale = keys.filter((key) => {
    const match = /__shared\/([a-z0-9]+)/i.exec(key.url);
    return match && Date.now() - Number.parseInt(match[1].slice(0, 8), 36) > 3_600_000;
  });
  await Promise.all(stale.map((key) => cache.delete(key)));

  return Response.redirect(inScope(`./index.html?shared=${id}`), 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only same-origin requests can be a share target.
  if (url.origin === self.location.origin) {
    if (
      (request.method === 'POST' || request.method === 'GET') &&
      url.pathname === new URL(inScope(`./${SHARE_ROUTE}`)).pathname
    ) {
      event.respondWith(receiveShare(request));
      return;
    }
  }

  if (request.method !== 'GET') return;

  // Never cache the local scanning bridge.
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok || response.type === 'opaque') {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
    }),
  );
});
