/* Scanlet — bootstrap.
 *
 * Loads the store, mounts the UI, registers the offline worker and asks the
 * browser to keep our data around.
 */

import { loadAll, requestPersistence } from './store.js';
import { mount } from './app.js';
import { toast, nextFrame } from './util.js';
import { pdfEnginesReady } from './pdfs.js';

async function waitForEngines(timeoutMs = 8000) {
  const started = Date.now();
  while (!pdfEnginesReady() && Date.now() - started < timeoutMs) await nextFrame();
  return pdfEnginesReady();
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  // Browsers only allow a service worker in a secure context. A bridge served
  // over plain http on a LAN address is not one, so skip it quietly.
  if (!window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    registration.addEventListener('updatefound', () => {});
  } catch {
    /* offline caching is a bonus, never a requirement */
  }
}

async function boot() {
  mount();
  registerWorker();

  try {
    await loadAll();
  } catch (error) {
    toast(`Local storage is unavailable: ${error.message}`, { kind: 'err', timeout: 8000 });
  }

  requestPersistence().catch(() => {});

  if (!(await waitForEngines())) {
    toast('The PDF engines did not load — check your connection for import and export.', {
      kind: 'err',
      timeout: 8000,
    });
  }

  document.body.dataset.ready = 'true';
}

boot();
