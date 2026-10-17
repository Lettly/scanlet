/* Scanlet — document store: IndexedDB persistence + in-memory app state.
 *
 * Pages are stored as two halves: the untouched original image (a Blob, in the
 * `blobs` store) and the edit recipe (inside the document record). Nothing here
 * ever talks to a network.
 */

import { uid, loadImage, debounce, ctx2d } from './util.js';

const DB_NAME = 'scanlet';
const DB_VERSION = 1;
const STORE_DOCS = 'docs';
const STORE_BLOBS = 'blobs';
const STORE_META = 'meta';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = fn(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export const putBlob = (id, blob) => tx(STORE_BLOBS, 'readwrite', (s) => s.put({ id, blob }));
export const getBlobRecord = (id) => tx(STORE_BLOBS, 'readonly', (s) => s.get(id));
export const deleteBlob = (id) => tx(STORE_BLOBS, 'readwrite', (s) => s.delete(id));
export const putDoc = (doc) => tx(STORE_DOCS, 'readwrite', (s) => s.put(doc));
export const removeDoc = (id) => tx(STORE_DOCS, 'readwrite', (s) => s.delete(id));
export const allDocs = () => tx(STORE_DOCS, 'readonly', (s) => s.getAll());

export async function setMeta(key, value) {
  return tx(STORE_META, 'readwrite', (s) => s.put({ key, value }));
}

export async function getMeta(key) {
  const row = await tx(STORE_META, 'readonly', (s) => s.get(key));
  return row ? row.value : undefined;
}

export async function storageReport() {
  const estimate = (await navigator.storage?.estimate?.()) || {};
  const docs = await allDocs();
  const pages = docs.reduce((n, d) => n + d.pages.length, 0);
  return {
    usage: estimate.usage || 0,
    quota: estimate.quota || 0,
    docs: docs.length,
    pages,
  };
}

export async function requestPersistence() {
  try {
    return await navigator.storage?.persist?.();
  } catch {
    return false;
  }
}

/* ─────────────────────────── state ─────────────────────────── */

export const state = {
  docs: [],
  activeId: null,
  selection: new Set(),
  busy: false,
  bridge: { url: '' },
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(detail = {}) {
  for (const fn of [...listeners]) fn(state, detail);
}

export const activeDoc = () => state.docs.find((d) => d.id === state.activeId) || null;
export const selectedPages = () => {
  const doc = activeDoc();
  if (!doc) return [];
  return doc.pages.filter((p) => state.selection.has(p.id));
};

export function setSelection(ids) {
  state.selection = new Set(ids);
  emit({ reason: 'selection' });
}

export function toggleSelection(id, additive) {
  if (additive) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
  } else {
    state.selection = new Set([id]);
  }
  emit({ reason: 'selection' });
}

/* ─────────────────────────── documents ─────────────────────────── */

export function newDoc(name = 'Untitled document') {
  return {
    id: uid('doc'),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pages: [],
    export: {},
  };
}

export async function loadAll() {
  const docs = (await allDocs()) || [];
  docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  state.docs = docs;
  const last = await getMeta('lastDocId');
  state.activeId = docs.find((d) => d.id === last)?.id || docs[0]?.id || null;
  if (!state.activeId) {
    const doc = newDoc();
    state.docs.push(doc);
    state.activeId = doc.id;
    await saveDoc(doc);
  }
  emit({ reason: 'loaded' });
  // The undo history is empty right after a load, so any original no document
  // references is genuinely abandoned — sweep it without blocking the UI.
  collectGarbage().catch(() => {});
  return state.docs;
}

export const autosave = debounce(async (doc) => {
  if (!doc) return;
  await putDoc(doc);
  await setMeta('lastDocId', doc.id);
}, 350);

export async function saveDoc(doc, { immediate = false } = {}) {
  if (!doc) return;
  doc.updatedAt = Date.now();
  if (immediate) {
    await putDoc(doc);
    await setMeta('lastDocId', doc.id);
  } else {
    autosave(doc);
  }
}

export async function deleteDocHard(docId) {
  const doc = state.docs.find((d) => d.id === docId);
  if (doc) for (const page of doc.pages) await deleteBlob(page.blobId).catch(() => {});
  await removeDoc(docId);
  state.docs = state.docs.filter((d) => d.id !== docId);
  if (state.activeId === docId) state.activeId = state.docs[0]?.id || null;
  if (!state.docs.length) {
    const doc2 = newDoc();
    state.docs.push(doc2);
    state.activeId = doc2.id;
    await saveDoc(doc2, { immediate: true });
  }
  await setMeta('lastDocId', state.activeId);
  emit({ reason: 'docs' });
}

/* ─────────────────────────── pages ─────────────────────────── */

export function makePage({ blob, width, height, thumb, source = 'import' }) {
  return {
    id: uid('page'),
    blobId: uid('blob'),
    blob,
    width,
    height,
    thumb,
    source,
    filter: 'original',
    adjustments: { brightness: 0, contrast: 0, saturation: 0, autoCrop: false },
    rotation: 0,
    flipH: false,
    crop: null,
    ocr: null,
    createdAt: Date.now(),
  };
}

/** Add a page to the active document, persisting its original blob. */
export async function addPage(page, { at = null, silent = false } = {}) {
  const doc = activeDoc();
  if (!doc) throw new Error('No document open');
  await putBlob(page.blobId, page.blob);
  delete page.blob; // only the blob store keeps the bytes
  if (at === null || at === undefined) doc.pages.push(page);
  else doc.pages.splice(at, 0, page);
  await saveDoc(doc);
  if (!silent) emit({ reason: 'pages', added: [page.id] });
  return page;
}

/*
 * Removing a page does not delete its original here on purpose. The undo stack
 * keeps whole page recipes, and a page whose blob was deleted comes back as a
 * broken card ("the original for this page is missing"). Instead the blob is
 * left behind and `collectGarbage()` sweeps anything no document references —
 * on the next load, when the in-memory undo history is empty and a rebuild can
 * no longer be wanted.
 */
export async function removePages(ids) {
  const doc = activeDoc();
  if (!doc) return;
  const set = new Set(ids);
  doc.pages = doc.pages.filter((p) => !set.has(p.id));
  for (const id of ids) state.selection.delete(id);
  await saveDoc(doc);
  emit({ reason: 'pages' });
}

/** Delete original blobs that no document still references. */
export async function collectGarbage() {
  let keys;
  try {
    keys = await tx(STORE_BLOBS, 'readonly', (s) => s.getAllKeys());
  } catch {
    return 0;
  }
  const referenced = new Set();
  for (const doc of state.docs) for (const page of doc.pages) referenced.add(page.blobId);
  const orphans = (keys || []).filter((key) => !referenced.has(key));
  for (const key of orphans) await deleteBlob(key).catch(() => {});
  return orphans.length;
}

/* ─────────────────── decoded originals (cached) ─────────────────── */

const sourceCache = new Map(); // blobId → { promise, canvas }
const MAX_CACHED = 14;

/** Decode the untouched original for a page and cache it. */
export function pageSource(page) {
  const cached = sourceCache.get(page.blobId);
  if (cached) {
    cached.touched = Date.now();
    return cached.promise;
  }
  const promise = (async () => {
    const record = await getBlobRecord(page.blobId);
    if (!record) throw new Error('The original for this page is missing.');
    const bitmap = await loadImage(record.blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.naturalWidth;
    canvas.height = bitmap.naturalHeight;
    ctx2d(canvas).drawImage(bitmap, 0, 0);
    return canvas;
  })();  const entry = { promise, touched: Date.now() };
  sourceCache.set(page.blobId, entry);
  if (sourceCache.size > MAX_CACHED) {
    const oldest = [...sourceCache.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
    if (oldest) sourceCache.delete(oldest[0]);
  }
  return promise;
}

export function forgetSource(blobId) {
  sourceCache.delete(blobId);
}

export function clearSourceCache() {
  sourceCache.clear();
}

/** Replace a page's original with a new blob (used by "bake edits"). */
export async function replacePageBlob(page, blob) {
  await putBlob(page.blobId, blob);
  forgetSource(page.blobId);
  const bitmap = await loadImage(blob);
  page.width = bitmap.naturalWidth;
  page.height = bitmap.naturalHeight;
  return page;
}
