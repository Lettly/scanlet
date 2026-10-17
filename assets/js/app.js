/* Scanlet — the application controller.
 *
 * Owns the views, the modals, the page pipeline and every user action. The
 * store holds the data; this file never talks to the network except through
 * the optional local bridge.
 */

import {
  $, $$, el, uid, clamp, toast, announce, download, formatBytes, safeFilename,
  pool, canvasToBlob, loadImage, nextFrame, confirmDialog, debounce, stripExt, ctx2d,
} from './util.js';
import * as imaging from './imaging.js';
import * as pdfs from './pdfs.js';
import * as ocrLib from './ocr.js';
import * as bridgeLib from './bridge.js';
import * as qrLib from './qr.js';
import * as shareLib from './share.js';
import * as store from './store.js';
import { CameraCapture, cameraSupported } from './capture.js';

const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

const ui = {};
let camera = null;
let lastClickedPage = null;
let undoStack = [];
const cameras = { shots: [], devices: [] };

/* ─────────────────────────────── boot ─────────────────────────────── */

export function mount() {
  cacheDom();
  absorbBridgeTokenFromUrl();
  bindGlobal();
  bindAppBar();
  bindInspector();
  bindCapture();
  bindEditor();
  bindScanner();
  bindExport();
  bindModals();
  store.subscribe(render);
  applyStoredTheme();
  render();
  updateStorageLabel();
}

function cacheDom() {
  ui.pages = $('#pages');
  ui.empty = $('#empty-state');
  ui.docList = $('#doc-list');
  ui.inspector = $('#inspector');
  ui.rail = $('#rail');
  ui.docTitle = $('#doc-title');
  ui.docMeta = $('#doc-meta');
  ui.selCount = $('#sel-count');
  ui.fileInput = $('#file-input');
  ui.projectInput = $('#project-input');
  ui.dropzone = $('#dropzone');
  ui.menu = $('#app-menu');
  ui.toasts = $('#toasts');
  ui.progress = {
    modal: $('#modal-progress'),
    title: $('#progress-title'),
    bar: $('#progress-bar'),
    detail: $('#progress-detail'),
    cancel: $('#progress-cancel'),
  };
  ui.filterSeg = $('#filter-seg');
  ui.edFilterSeg = $('#ed-filter-seg');
  ui.adj = {
    brightness: $('#adj-brightness'),
    contrast: $('#adj-contrast'),
    saturation: $('#adj-saturation'),
    angle: $('#adj-angle'),
    autoCrop: $('#adj-autocrop'),
  };
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

function render(_state, detail = {}) {
  const doc = store.activeDoc();
  renderDocList();
  renderDocHeader(doc);
  renderPages(doc);
  renderInspector();
  if (detail.reason !== 'selection') updateStorageLabel();
}

function renderDocHeader(doc) {
  if (!doc) return;
  if (document.activeElement !== ui.docTitle) ui.docTitle.value = doc.name;
  const pages = doc.pages.length;
  const ocrDone = doc.pages.filter((p) => p.ocr).length;
  const parts = [`${pages} page${pages === 1 ? '' : 's'}`];
  if (ocrDone) parts.push(`${ocrDone} with text`);
  const edited = doc.pages.filter(isEdited).length;
  if (edited) parts.push(`${edited} adjusted`);
  ui.docMeta.textContent = parts.join(' · ');
}

function renderDocList() {
  ui.docList.textContent = '';
  for (const doc of store.state.docs) {
    const item = el('div', {
      class: 'doc-item',
      role: 'button',
      tabindex: '0',
      'aria-current': String(doc.id === store.state.activeId),
    }, [
      el('span', { class: 'doc-ico', html: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>' }),
      el('span', { class: 'doc-name', title: doc.name }, doc.name),
      el('span', { class: 'doc-count' }, String(doc.pages.length)),
      el('button', {
        class: 'icon-btn doc-del',
        title: 'Delete document',
        'aria-label': `Delete ${doc.name}`,
        html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        onclick: (event) => {
          event.stopPropagation();
          deleteDocument(doc);
        },
      }),
    ]);
    item.addEventListener('click', () => selectDocument(doc.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectDocument(doc.id);
      }
    });
    ui.docList.append(item);
  }
}

function renderPages(doc) {
  const hasPages = Boolean(doc && doc.pages.length);
  ui.empty.hidden = hasPages;
  ui.pages.hidden = !hasPages;
  if (!hasPages) {
    ui.pages.textContent = '';
    return;
  }

  const existing = new Map($$('.page-card', ui.pages).map((node) => [node.dataset.pageId, node]));
  const keep = new Set();
  doc.pages.forEach((page, index) => {
    let card = existing.get(page.id);
    if (!card) card = buildPageCard(page);
    keep.add(page.id);
    card.__page = page;
    card.dataset.index = String(index);
    card.querySelector('.card-num').textContent = String(index + 1);
    card.setAttribute('aria-selected', String(store.state.selection.has(page.id)));
    const img = card.querySelector('img');
    if (page.thumb && img.src !== page.thumb) img.src = page.thumb;
    const tags = card.querySelector('.card-tags');
    tags.textContent = '';
    if (page.ocr) tags.append(el('span', { class: 'tag ocr', title: 'Text recognised' }, 'OCR'));
    if (isEdited(page)) tags.append(el('span', { class: 'tag', title: 'Adjusted' }, 'EDIT'));
    if (page.source === 'camera') tags.append(el('span', { class: 'tag src' }, 'CAM'));
    if (page.source === 'scanner') tags.append(el('span', { class: 'tag src' }, 'SCAN'));
    if (page.blank) tags.append(el('span', { class: 'tag', title: 'Looks blank' }, 'BLANK'));
    ui.pages.append(card);
  });
  for (const [id, node] of existing) if (!keep.has(id)) node.remove();
}

function buildPageCard(page) {
  const card = el('div', {
    class: 'page-card',
    role: 'option',
    tabindex: '0',
    'aria-selected': 'false',
    dataset: { pageId: page.id },
    draggable: 'true',
  }, [
    el('img', { class: 'thumb', alt: '', src: page.thumb || '' }),
    el('div', { class: 'card-bar' }, [
      el('span', { class: 'card-num' }, '1'),
      el('span', { class: 'card-tags' }),
    ]),
    el('span', { class: 'sel-dot', html: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>' }),
    el('button', {
      class: 'icon-btn card-menu-btn',
      title: 'Page actions',
      'aria-label': 'Page actions',
      html: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
    }),
  ]);

  card.addEventListener('click', (event) => {
    if (event.target.closest('.card-menu-btn')) return;
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && lastClickedPage) {
      const doc = store.activeDoc();
      const from = doc.pages.findIndex((p) => p.id === lastClickedPage);
      const to = doc.pages.findIndex((p) => p.id === page.id);
      if (from !== -1 && to !== -1) {
        const [a, b] = from < to ? [from, to] : [to, from];
        const ids = doc.pages.slice(a, b + 1).map((p) => p.id);
        store.setSelection([...new Set([...store.state.selection, ...ids])]);
        lastClickedPage = page.id;
        return;
      }
    }
    store.toggleSelection(page.id, additive);
    lastClickedPage = page.id;
  });
  card.addEventListener('dblclick', () => openEditor(page));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openEditor(page);
    if (event.key === ' ') {
      event.preventDefault();
      store.toggleSelection(page.id, event.metaKey || event.ctrlKey);
    }
  });
  card.querySelector('.card-menu-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    if (!store.state.selection.has(page.id)) store.toggleSelection(page.id, false);
    openPageMenu(page, event.currentTarget);
  });
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!store.state.selection.has(page.id)) store.toggleSelection(page.id, false);
    openPageMenu(page, event);
  });
  bindCardDrag(card);
  return card;
}

function bindCardDrag(card) {
  card.addEventListener('dragstart', (event) => {
    if (!store.state.selection.has(card.dataset.pageId)) store.toggleSelection(card.dataset.pageId, false);
    card.classList.add('dragging');
    ui.pages.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.pageId);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    ui.pages.classList.remove('dragging');
    $$('.drag-over', ui.pages).forEach((node) => node.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (event) => {
    if (!ui.pages.classList.contains('dragging')) return;
    event.preventDefault();
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('drag-over');
    const sourceId = event.dataTransfer.getData('text/plain');
    if (sourceId) movePagesTo(store.state.selection.size ? [...store.state.selection] : [sourceId], card.dataset.pageId);
  });
}

function renderInspector() {
  const doc = store.activeDoc();
  const count = store.state.selection.size;
  const selection = store.selectedPages();

  ui.inspector.hidden = !doc || !doc.pages.length;
  ui.selCount.textContent = count
    ? `${count} page${count === 1 ? '' : 's'} selected`
    : 'No pages selected';

  const first = selection[0];
  if (first) {
    setSeg(ui.filterSeg, first.filter || 'original');
    ui.adj.brightness.value = first.adjustments?.brightness ?? 0;
    ui.adj.contrast.value = first.adjustments?.contrast ?? 0;
    ui.adj.saturation.value = first.adjustments?.saturation ?? 0;
    ui.adj.angle.value = Number.isInteger(first.rotation) && Math.abs(first.rotation) <= 15 ? first.rotation : 0;
    ui.adj.autoCrop.checked = Boolean(first.adjustments?.autoCrop);
  }

  for (const group of $$('.insp-group', ui.inspector)) group.style.opacity = count ? '1' : '.45';
  for (const button of $$('.insp-group button, .insp-group input', ui.inspector)) button.disabled = !count;
  $('#act-export').disabled = !doc?.pages.length;
}

const isEdited = (page) =>
  page.filter !== 'original' ||
  page.rotation % 360 !== 0 ||
  page.flipH ||
  page.crop?.applied ||
  page.adjustments?.brightness ||
  page.adjustments?.contrast ||
  page.adjustments?.saturation;

/* ─────────────────────────────── documents ─────────────────────────────── */

function selectDocument(id) {
  store.state.activeId = id;
  store.state.selection.clear();
  store.setMeta('lastDocId', id).catch(() => {});
  ui.rail.classList.remove('open');
  store.emit({ reason: 'docs' });
}

async function newDocument() {
  const doc = store.newDoc(`Document ${store.state.docs.length + 1}`);
  store.state.docs.unshift(doc);
  store.state.activeId = doc.id;
  store.state.selection.clear();
  await store.saveDoc(doc, { immediate: true });
  store.emit({ reason: 'docs' });
  ui.docTitle.focus();
  ui.docTitle.select();
}

async function deleteDocument(doc) {
  if (!confirmDialog(`Delete “${doc.name}” and its ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}?`)) return;
  await store.deleteDocHard(doc.id);
  toast('Document deleted');
}

/* ─────────────────────────────── imports ─────────────────────────────── */

function bindGlobal() {
  ui.fileInput.addEventListener('change', async () => {
    const files = [...ui.fileInput.files];
    ui.fileInput.value = '';
    if (files.length) await importFiles(files);
  });

  ui.projectInput.addEventListener('change', async () => {
    const [file] = ui.projectInput.files;
    ui.projectInput.value = '';
    if (file) await openProjectBundle(file);
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    if (store.activeDoc()?.pages.length) ui.dropzone.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.dropzone.hidden = true;
  });
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  });
  window.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    ui.dropzone.hidden = true;
    await importFiles([...event.dataTransfer.files]);
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', (event) => {
    if (store.state.busy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function onKeyDown(event) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  const modalOpen = $$('.modal').some((node) => !node.hidden);

  if (event.key === 'Escape') {
    closeTopModal();
    return;
  }
  if (typing) return;

  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    const doc = store.activeDoc();
    if (doc) store.setSelection(doc.pages.map((p) => p.id));
    return;
  }
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (modalOpen) return;

  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (store.state.selection.size) {
      event.preventDefault();
      deleteSelectedPages();
    }
    return;
  }
  if (event.key === '[') rotateSelection(-90);
  if (event.key === ']') rotateSelection(90);
  if (event.key === 'Enter' && store.state.selection.size === 1) {
    const [page] = store.selectedPages();
    openEditor(page);
  }
  if (mod && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    $('#act-export').click();
  }
  if (mod && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    ui.fileInput.click();
  }
  const filters = { 1: 'original', 2: 'enhance', 3: 'gray', 4: 'bw', 5: 'magic' };
  if (filters[event.key] && store.state.selection.size) setFilter(filters[event.key]);
}

async function importFiles(files) {
  const isImage = (file) =>
    file.type.startsWith('image/') ||
    /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i.test(file.name);
  const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  const images = files.filter(isImage);
  const pdfFiles = files.filter((file) => !isImage(file) && isPdf(file));
  const others = files.filter((file) => !isImage(file) && !isPdf(file));

  if (!images.length && !pdfFiles.length) {
    toast(others.length ? 'Those files are not images or PDFs.' : 'Nothing to import.', { kind: 'err' });
    return;
  }

  await withProgress('Importing', async ({ update, shouldCancel }) => {
    let done = 0;
    const total = images.length + pdfFiles.length;

    for (const file of images) {
      if (shouldCancel()) return;
      update(done / total, file.name);
      try {
        await addImageFile(file);
      } catch (error) {
        toast(`Could not read ${file.name}: ${error.message}`, { kind: 'err' });
      }
      done++;
    }

    for (const file of pdfFiles) {
      if (shouldCancel()) return;
      update(done / total, file.name);
      try {
        const rendered = await pdfs.importPdfFile(file, {
          onProgress: (page, pages) =>
            update((done + page / pages) / total, `${file.name} — page ${page} of ${pages}`),
        });
        for (const item of rendered) {
          await addCanvasPage(item.canvas, { source: 'pdf' });
        }
      } catch (error) {
        toast(`Could not read ${file.name}: ${error.message}`, { kind: 'err' });
      }
      done++;
    }
    update(1, 'Done');
  });

  announce('Import finished');
  toast(`Imported ${images.length + pdfFiles.length} file${images.length + pdfFiles.length === 1 ? '' : 's'}`);
}

async function addImageFile(file) {
  let blob = file;
  // Normalise exotic formats (HEIC and friends) the canvas cannot decode by
  // itself, when the browser can: use createImageBitmap with a fallback.
  const bitmap = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.naturalWidth;
  canvas.height = bitmap.naturalHeight;
  ctx2d(canvas).drawImage(bitmap, 0, 0);
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    blob = await canvasToBlob(canvas, 'image/png');
  }
  return addCanvasPage(canvas, { source: 'import', blob });
}

async function addCanvasPage(canvas, { source = 'import', blob = null, at = null, crop = null, filter = 'original' } = {}) {
  const bytes = blob || (await canvasToBlob(canvas, 'image/jpeg', 0.92));
  const page = store.makePage({
    blob: bytes,
    width: canvas.width,
    height: canvas.height,
    thumb: imaging.thumbnail(canvas),
    source,
  });
  page.filter = filter;
  if (crop) page.crop = crop;
  return store.addPage(page, { at });
}

/* ─────────────────────────────── launch: shares and shortcuts ─────────────────────────────── */

/** Strip a query parameter without reloading, so a refresh cannot repeat it. */
function clearQueryParams(...names) {
  const url = new URL(location.href);
  let touched = false;
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      touched = true;
    }
  }
  if (touched) history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Files another app shared into Scanlet, on Android's share sheet. */
async function consumeSharedPayload() {
  const id = shareLib.sharedIdFromUrl();
  if (shareLib.shareFailedFromUrl()) {
    clearQueryParams('share');
    toast('That share could not be read — try sharing the file again.', { kind: 'err' });
    return;
  }
  if (!id) return;
  clearQueryParams('shared');
  announce('Receiving shared files');

  let payload = null;
  try {
    payload = await shareLib.takeSharedPayload(id);
  } catch {
    payload = null;
  }
  if (!payload) {
    toast('That share has already been taken, or was too old.', { kind: 'err' });
    return;
  }

  if (payload.files.length) {
    await importFiles(payload.files);
    return;
  }

  const link = shareLib.linkFromShare(payload.text, payload.url);
  if (!link) {
    toast(payload.text ? 'Nothing to import from that share.' : 'That share had no files.', {});
    return;
  }
  try {
    const file = await shareLib.fileFromLink(link);
    await importFiles([file]);
  } catch {
    toast('This site is not allowed to fetch that link — download it, then Import.', {
      kind: 'err',
      timeout: 7000,
    });
  }
}

/** The manifest's long-press shortcuts and action links land here. */
function consumeLaunchAction() {
  const action = new URLSearchParams(location.search).get('action');
  if (!action) return;
  clearQueryParams('action');
  if (action === 'camera') openCapture();
  else if (action === 'scanner') openScanner();
  else if (action === 'import') ui.fileInput.click();
}

/** Called once the store is ready: a share or a shortcut beats an empty screen. */
export async function handleLaunch() {
  await consumeSharedPayload();
  consumeLaunchAction();
}

/* ─────────────────────────────── page actions ─────────────────────────────── */

async function refreshPages(pages, { thumbSize = 340 } = {}) {
  for (const page of pages) {
    try {
      const canvas = await renderForPage(page, { maxEdge: thumbSize * 2 });
      page.thumb = imaging.thumbnail(canvas, thumbSize);
    } catch {
      /* keep the previous thumbnail */
    }
  }
  await store.saveDoc(store.activeDoc());
  store.emit({ reason: 'pages' });
}

async function renderForPage(page, { maxEdge = 0, trim = false } = {}) {
  const source = await store.pageSource(page);
  return imaging.renderPage(source, page, { maxEdge, trim });
}

function mutatePages(mutator, { refresh = true } = {}) {
  const pages = store.selectedPages();
  if (!pages.length) return;
  pushUndo();
  for (const page of pages) mutator(page);
  store.saveDoc(store.activeDoc());
  if (refresh) refreshPages(pages);
  else store.emit({ reason: 'pages' });
}

function rotateSelection(degrees) {
  mutatePages((page) => {
    page.rotation = (((page.rotation || 0) + degrees) % 360 + 360) % 360;
  });
}

function flipSelection() {
  mutatePages((page) => {
    page.flipH = !page.flipH;
  });
}

async function deskewSelection() {
  const pages = store.selectedPages();
  if (!pages.length) return;
  pushUndo();
  await withProgress('Straightening', async ({ update, shouldCancel }) => {
    await pool(pages, 2, async (page, index) => {
      if (shouldCancel()) return;
      update(index / pages.length, `Page ${index + 1}`);
      const source = await store.pageSource(page);
      const pre = imaging.renderPage(source, page, { maxEdge: 2000 });
      const angle = imaging.estimateSkew(pre);
      if (angle) page.rotation = Number((((page.rotation || 0) + angle) % 360).toFixed(2));
    }, (done, total) => update(done / total, `${done} of ${total}`));
  });
  await refreshPages(pages);
  toast('Deskew applied');
}

function setFilter(filter) {
  mutatePages((page) => {
    page.filter = filter;
  });
  setSeg(ui.filterSeg, filter);
}

function applyAdjustments() {
  const values = {
    brightness: Number(ui.adj.brightness.value),
    contrast: Number(ui.adj.contrast.value),
    saturation: Number(ui.adj.saturation.value),
  };
  mutatePages((page) => {
    page.adjustments = { ...page.adjustments, ...values };
  });
}

function setSeg(container, value) {
  for (const button of $$('button', container)) {
    button.setAttribute('aria-checked', String(button.dataset.filter === value));
  }
}

async function deleteSelectedPages() {
  const pages = store.selectedPages();
  if (!pages.length) return;
  if (pages.length > 1 && !confirmDialog(`Delete ${pages.length} pages?`)) return;
  pushUndo();
  await store.removePages(pages.map((p) => p.id));
}

async function duplicateSelection() {
  const doc = store.activeDoc();
  const pages = store.selectedPages();
  if (!pages.length) return;
  pushUndo();
  const created = [];
  for (const page of pages) {
    const index = doc.pages.indexOf(page);
    const record = await store.getBlobRecord(page.blobId);
    if (!record) continue;
    const clone = {
      ...structuredClone(recipeOf(page)),
      id: uid('page'),
      blobId: uid('blob'),
      thumb: page.thumb,
      createdAt: Date.now(),
    };
    await store.putBlob(clone.blobId, record.blob);
    doc.pages.splice(doc.pages.indexOf(page) + 1, 0, clone);
    created.push(clone.id);
    void index;
  }
  await store.saveDoc(doc);
  store.setSelection(created);
  store.emit({ reason: 'pages' });
}

function recipeOf(page) {
  const { ocr, blob, ...recipe } = page;
  return { ...recipe };
}

function movePagesTo(ids, targetId) {
  const doc = store.activeDoc();
  if (!doc) return;
  const moving = doc.pages.filter((p) => ids.includes(p.id));
  if (!moving.length) return;
  pushUndo();
  const targetIndex = doc.pages.findIndex((p) => p.id === targetId);
  const remaining = doc.pages.filter((p) => !ids.includes(p.id));
  const anchor = remaining.findIndex((p) => doc.pages.indexOf(p) > targetIndex);
  const insertAt = anchor === -1 ? remaining.length : anchor;
  remaining.splice(insertAt, 0, ...moving);
  doc.pages = remaining;
  store.saveDoc(doc);
  store.emit({ reason: 'pages' });
}

function moveSelection(direction) {
  const doc = store.activeDoc();
  const ids = [...store.state.selection];
  if (!ids.length) return;
  pushUndo();
  const indices = ids
    .map((id) => doc.pages.findIndex((p) => p.id === id))
    .sort((a, b) => a - b);
  const ordered = direction < 0 ? indices : [...indices].reverse();
  for (const index of ordered) {
    const next = index + direction;
    if (next < 0 || next >= doc.pages.length) continue;
    if (ids.includes(doc.pages[next].id)) continue;
    [doc.pages[index], doc.pages[next]] = [doc.pages[next], doc.pages[index]];
  }
  store.saveDoc(doc);
  store.emit({ reason: 'pages' });
}

async function splitAtSelection() {
  const doc = store.activeDoc();
  const pages = store.selectedPages();
  if (!pages.length) return;
  const index = doc.pages.indexOf(pages[0]);
  const tail = doc.pages.splice(index);
  const newDocument = store.newDoc(`${doc.name} (part 2)`);
  newDocument.pages = tail;
  store.state.docs.unshift(newDocument);
  store.state.activeId = newDocument.id;
  store.state.selection.clear();
  await store.saveDoc(doc, { immediate: true });
  await store.saveDoc(newDocument, { immediate: true });
  store.emit({ reason: 'docs' });
  toast(`Moved ${tail.length} page${tail.length === 1 ? '' : 's'} to a new document`);
}

async function extractSelection() {
  const doc = store.activeDoc();
  const pages = store.selectedPages();
  if (!pages.length) return;
  const newDocument = store.newDoc(`${doc.name} extract`);
  newDocument.pages = pages;
  doc.pages = doc.pages.filter((p) => !pages.includes(p));
  store.state.docs.unshift(newDocument);
  store.state.activeId = newDocument.id;
  store.state.selection.clear();
  await store.saveDoc(doc, { immediate: true });
  await store.saveDoc(newDocument, { immediate: true });
  store.emit({ reason: 'docs' });
}

function revertSelection() {
  mutatePages((page) => {
    page.filter = 'original';
    page.rotation = 0;
    page.flipH = false;
    page.crop = null;
    page.adjustments = { brightness: 0, contrast: 0, saturation: 0, autoCrop: false };
  });
  toast('Edits reverted');
}

async function bakeSelection() {
  const pages = store.selectedPages();
  if (!pages.length) return;
  await withProgress('Applying edits', async ({ update, shouldCancel }) => {
    await pool(pages, 1, async (page, index) => {
      if (shouldCancel()) return;
      update(index / pages.length, `Page ${index + 1}`);
      const baked = await renderForPage(page, { trim: page.adjustments?.autoCrop });
      const blob = await canvasToBlob(baked, 'image/jpeg', 0.94);
      await store.replacePageBlob(page, blob);
      page.filter = 'original';
      page.rotation = 0;
      page.flipH = false;
      page.crop = null;
      page.adjustments = { brightness: 0, contrast: 0, saturation: 0, autoCrop: false };
      page.ocr = null;
      page.thumb = imaging.thumbnail(baked);
    }, (done, total) => update(done / total, `${done} of ${total}`));
  });
  await store.saveDoc(store.activeDoc());
  store.emit({ reason: 'pages' });
  toast('Edits baked into the originals');
}

/* ─────────────────────────────── page menu ─────────────────────────────── */

let pageMenu = null;

function openPageMenu(page, anchor) {
  closePageMenu();
  const doc = store.activeDoc();
  const count = store.state.selection.size;
  const items = [
    { label: 'Adjust page…', run: () => openEditor(page) },
    { label: 'Rotate left', run: () => rotateSelection(-90) },
    { label: 'Rotate right', run: () => rotateSelection(90) },
    { label: 'Deskew', run: () => deskewSelection() },
    { label: 'Duplicate', run: () => duplicateSelection() },
    { label: 'Run OCR', run: () => runOcrOnSelection() },
    { label: 'Move to top', run: () => movePagesTo([...store.state.selection], doc.pages[0].id) },
    { label: 'Revert edits', run: () => revertSelection() },
    { label: 'Bake edits into original', run: () => bakeSelection() },
    { label: 'Delete', run: () => deleteSelectedPages(), danger: true },
  ];
  const menu = el('div', { class: 'menu', style: { position: 'fixed', top: '0px', left: '0px' }, role: 'menu' },
    items.map((item) =>
      el('button', { role: 'menuitem', class: item.danger ? 'danger' : '', onclick: () => { closePageMenu(); item.run(); } }, item.label),
    ).concat([
      el('hr'),
      el('div', { class: 'hint', style: { padding: '4px 10px' } }, `${count} page${count === 1 ? '' : 's'} selected`),
    ]),
  );
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect
    ? anchor.getBoundingClientRect()
    : { left: anchor.clientX, top: anchor.clientY, width: 0, height: 0 };
  const left = clamp(rect.left, 8, window.innerWidth - menu.offsetWidth - 8);
  const top = clamp(rect.top + (rect.height || 0), 8, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  pageMenu = menu;
  setTimeout(() => window.addEventListener('click', closePageMenu, { once: true }), 0);
}

function closePageMenu() {
  pageMenu?.remove();
  pageMenu = null;
}

/* ─────────────────────────────── camera ─────────────────────────────── */

function bindCapture() {
  ui.capture = {
    modal: $('#modal-capture'),
    video: $('#cam-video'),
    overlay: $('#cam-overlay'),
    flash: $('#cam-flash'),
    device: $('#cam-device'),
    res: $('#cam-res'),
    preset: $('#cam-preset'),
    crop: $('#cam-crop'),
    continuous: $('#cam-continuous'),
    autoshot: $('#cam-autoshot'),
    shoot: $('#cam-shoot'),
    done: $('#cam-done'),
    review: $('#cam-review'),
    count: $('#cam-shot-count'),
    strip: $('#cam-strip'),
  };
  camera = new CameraCapture(ui.capture.video, { overlay: ui.capture.overlay });
}

async function openCapture() {
  if (!cameraSupported()) {
    toast('This browser cannot open a camera here. Use Import instead.', { kind: 'err' });
    return;
  }
  openModal(ui.capture.modal);
  try {
    await camera.start({ idealWidth: Number(ui.capture.res.value) || 1920 });
    await populateCameraDevices();
    camera.startDetection();
  } catch (error) {
    toast(error.message || 'Could not start the camera.', { kind: 'err', timeout: 6000 });
    closeModal(ui.capture.modal);
  }
}

async function populateCameraDevices() {
  const devices = await camera.listDevices();
  cameras.devices = devices;
  ui.capture.device.textContent = '';
  if (!devices.length) {
    ui.capture.device.append(el('option', { value: '' }, 'Default camera'));
    return;
  }
  devices.forEach((device, index) => {
    ui.capture.device.append(el('option', { value: device.deviceId }, device.label || `Camera ${index + 1}`));
  });
  if (camera.deviceId) ui.capture.device.value = camera.deviceId;
}

async function shoot() {
  try {
    const shot = await camera.shoot({ detectEdges: ui.capture.crop.checked });
    cameras.shots.push(shot);
    ui.capture.flash.classList.remove('on');
    void ui.capture.flash.offsetWidth;
    ui.capture.flash.classList.add('on');
    renderShotStrip();
  } catch (error) {
    toast(error.message, { kind: 'err' });
  }
}

function renderShotStrip() {
  ui.capture.count.textContent = String(cameras.shots.length);
  ui.capture.strip.textContent = '';
  cameras.shots.forEach((shot, index) => {
    const thumb = imaging.thumbnail(shot.canvas, 180, 0.6);
    ui.capture.strip.append(
      el('img', {
        src: thumb,
        alt: `Shot ${index + 1}`,
        title: 'Click to discard',
        onclick: () => {
          cameras.shots.splice(index, 1);
          renderShotStrip();
        },
      }),
    );
  });
  ui.capture.done.hidden = cameras.shots.length === 0;
  ui.capture.review.textContent = cameras.shots.length ? `Review ${cameras.shots.length}` : 'Review shots';
}

async function commitShots() {
  const shots = cameras.shots;
  if (!shots.length) {
    closeModal(ui.capture.modal);
    return;
  }
  cameras.shots = [];
  renderShotStrip();
  const preset = ui.capture.preset.value;
  const continuous = ui.capture.continuous.checked;

  await withProgress('Adding pages', async ({ update }) => {
    await pool(shots, 2, async (shot, index) => {
      update(index / shots.length, `Page ${index + 1}`);
      let canvas = shot.canvas;
      let crop = null;
      if (shot.quad) {
        crop = { applied: true, quad: shot.quad, auto: true };
        canvas = imaging.warpPerspective(shot.canvas, shot.quad);
      }
      const page = await addCanvasPage(canvas, { source: 'camera', crop, filter: preset });
      void page;
    }, (done, total) => update(done / total, `${done} of ${total}`));
  });

  if (!continuous) closeModal(ui.capture.modal);
  toast(`${shots.length} page${shots.length === 1 ? '' : 's'} captured`);
}

/* ─────────────────────────────── editor ─────────────────────────────── */

const editorState = { page: null, corners: null, filter: 'original', rotation: 0, flipH: false, working: null };

function bindEditor() {
  ui.editor = {
    modal: $('#modal-editor'),
    canvas: $('#ed-canvas'),
    overlay: $('#ed-overlay'),
    stage: $('#ed-stage'),
    angle: $('#ed-angle'),
    angleOut: $('#ed-angle-out'),
    autoCrop: $('#ed-auto-crop'),
    reset: $('#ed-reset'),
    apply: $('#ed-apply'),
    applyCopy: $('#ed-apply-copy'),
  };
}

async function openEditor(page) {
  if (!page) return;
  editorState.page = page;
  editorState.filter = page.filter || 'original';
  editorState.rotation = page.rotation || 0;
  editorState.flipH = Boolean(page.flipH);
  openModal(ui.editor.modal);
  ui.editor.angle.value = String(editorState.rotation);
  ui.editor.angleOut.value = `${editorState.rotation}°`;
  setSeg(ui.edFilterSeg, editorState.filter);

  const source = await store.pageSource(page);
  editorState.working = source;
  editorState.corners = page.crop?.applied && Array.isArray(page.crop.quad)
    ? page.crop.quad.map((p) => ({ ...p }))
    : imaging.fullFrameQuad(source);
  if (!page.crop?.applied) editorState.corners = null;
  drawEditor();
}

function drawEditor() {
  const source = editorState.working;
  if (!source) return;
  const canvas = ui.editor.canvas;
  const maxEdge = 1100;
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  // faint enhancement preview
  const stageScale = canvas.width / source.width;
  drawCornerHandles(stageScale);
}

function drawCornerHandles(stageScale) {
  const overlay = ui.editor.overlay;
  overlay.textContent = '';
  const corners = editorState.corners;
  if (!corners) return;
  const canvas = ui.editor.canvas;
  const rect = canvas.getBoundingClientRect();
  const wrap = el('div', { style: { position: 'absolute', inset: '0' } });
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.left = `${canvas.offsetLeft}px`;
  overlay.style.top = `${canvas.offsetTop}px`;
  const scale = rect.width / canvas.width;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const polygon = document.createElementNS(svgNs, 'polygon');
  polygon.setAttribute('points', corners.map((p) => `${p.x * stageScale},${p.y * stageScale}`).join(' '));
  polygon.setAttribute('fill', 'rgba(79,70,229,.14)');
  polygon.setAttribute('stroke', 'rgba(79,70,229,.95)');
  polygon.setAttribute('stroke-width', String(2 / scale));
  svg.append(polygon);
  wrap.append(svg);

  corners.forEach((corner, index) => {
    const handle = el('div', {
      class: 'handle',
      style: {
        position: 'absolute',
        left: `${corner.x * stageScale * scale}px`,
        top: `${corner.y * stageScale * scale}px`,
        width: '20px',
        height: '20px',
        margin: '-10px 0 0 -10px',
        borderRadius: '999px',
        border: '2px solid #fff',
        background: '#4f46e5',
        boxShadow: '0 1px 4px rgba(0,0,0,.4)',
        cursor: 'grab',
        touchAction: 'none',
      },
      dataset: { index: String(index) },
    });
    handle.addEventListener('pointerdown', (event) => startHandleDrag(event, index));
    wrap.append(handle);
  });

  overlay.append(wrap);
}

function startHandleDrag(event, index) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const canvas = ui.editor.canvas;
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width;
  const source = editorState.working;
  const toImage = (clientX, clientY) => ({
    x: clamp(((clientX - rect.left) / scale) * (source.width / canvas.width), 0, source.width),
    y: clamp(((clientY - rect.top) / scale) * (source.height / canvas.height), 0, source.height),
  });
  const move = (moveEvent) => {
    editorState.corners[index] = toImage(moveEvent.clientX, moveEvent.clientY);
    drawCornerHandles(canvas.width / source.width);
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}

function editorAutoCrop() {
  const source = editorState.working;
  const quad = imaging.detectDocumentCorners(source);
  if (!quad) {
    toast('Could not find a page outline — adjust the corners by hand.', { kind: 'err' });
    return;
  }
  editorState.corners = quad;
  drawCornerHandles(ui.editor.canvas.width / source.width);
}

async function applyEditor({ copy = false } = {}) {
  const page = editorState.page;
  if (!page) return;
  const source = editorState.working;
  pushUndo();
  const target = copy ? await clonePageRecord(page) : page;

  const full = imaging.fullFrameQuad(source);
  const corners = editorState.corners;
  const isFull = !corners || corners.every((p, i) =>
    Math.abs(p.x - full[i].x) < 2 && Math.abs(p.y - full[i].y) < 2);
  target.crop = isFull ? null : { applied: true, quad: corners.map((p) => ({ ...p })) };
  target.filter = editorState.filter;
  target.rotation = editorState.rotation;
  target.flipH = editorState.flipH;

  if (copy) {
    const doc = store.activeDoc();
    doc.pages.splice(doc.pages.indexOf(page) + 1, 0, target);
  }
  await store.saveDoc(store.activeDoc());
  await refreshPages([target]);
  if (copy) store.setSelection([target.id]);
  closeModal(ui.editor.modal);
  toast(copy ? 'Applied to a copy' : 'Page updated');
}

async function clonePageRecord(page) {
  const record = await store.getBlobRecord(page.blobId);
  const clone = { ...structuredClone(recipeOf(page)), id: uid('page'), blobId: uid('blob'), createdAt: Date.now() };
  await store.putBlob(clone.blobId, record.blob);
  return clone;
}

/* ─────────────────────────────── OCR ─────────────────────────────── */

async function runOcrOnSelection() {
  const pages = store.selectedPages();
  if (!pages.length) {
    toast('Select at least one page first.');
    return;
  }
  const lang = $('#exp-language').value || 'eng';
  await withProgress('Recognising text', async ({ update, shouldCancel, setTitle }) => {
    let done = 0;
    for (const page of pages) {
      if (shouldCancel()) break;
      setTitle(`Reading page ${done + 1} of ${pages.length}`);
      const canvas = await renderForPage(page, {
        maxEdge: 2200,
        trim: Boolean(page.adjustments?.autoCrop),
      });
      try {
        page.ocr = await ocrLib.recognise(canvas, {
          lang,
          onProgress: (message) => {
            const { fraction, label } = ocrLib.progressFraction(message);
            update((done + fraction) / pages.length, `${label} — page ${done + 1}`);
          },
        });
      } catch (error) {
        toast(`OCR failed on page ${done + 1}: ${error.message}`, { kind: 'err' });
      }
      done++;
      update(done / pages.length, `${done} of ${pages.length}`);
    }
  });
  await store.saveDoc(store.activeDoc());
  store.emit({ reason: 'pages' });
  const total = pages.filter((p) => p.ocr).length;
  toast(`Text recognised on ${total} page${total === 1 ? '' : 's'}`);
}

async function runOcrOnAllPages() {
  const doc = store.activeDoc();
  if (!doc?.pages.length) return;
  store.setSelection(doc.pages.map((p) => p.id));
  await runOcrOnSelection();
}

function showRecognisedText() {
  const pages = store.selectedPages();
  const withText = (pages.length ? pages : store.activeDoc()?.pages || []).filter((p) => p.ocr);
  if (!withText.length) {
    toast('No page has been recognised yet. Run OCR first.');
    return;
  }
  $('#text-out').value = withText
    .map((page, index) => `— Page ${store.activeDoc().pages.indexOf(page) + 1} —\n${page.ocr.text}`)
    .join('\n\n');
  $('#text-copy').onclick = async () => {
    await navigator.clipboard.writeText($('#text-out').value);
    toast('Text copied');
  };
  $('#text-download').onclick = () => {
    download(new Blob([$('#text-out').value], { type: 'text/plain' }), `${safeFilename(store.activeDoc().name)}.txt`);
  };
  openModal($('#modal-text'));
}

/* ─────────────────────────────── scanner ─────────────────────────────── */

const scannerState = {
  method: 'bridge',
  client: null,
  extension: null,
  bridge: null,
  caps: null,
  printer: null,
};

const BRIDGE_KEY = 'scanlet:bridge';

function rememberBridge() {
  try {
    localStorage.setItem(BRIDGE_KEY, JSON.stringify(store.state.bridge || {}));
  } catch {
    /* private mode; the session still works */
  }
}

function recalledBridge() {
  try {
    const raw = localStorage.getItem(BRIDGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * A bridge can hand us its code through the URL it printed — that is how a
 * phone gets paired by opening one link.
 */
function absorbBridgeTokenFromUrl() {
  const fromHash = bridgeLib.tokenFromInput(location.hash || '');
  if (!fromHash) return false;
  store.state.bridge = { url: location.origin, token: fromHash };
  rememberBridge();
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

function bindScanner() {
  ui.scanner = {
    modal: $('#modal-scanner'),
    method: $('#scan-method'),
    servedByBridge: $('#served-by-bridge'),
    status: $('#bridge-status'),
    dot: $('#bridge-dot'),
    url: $('#bridge-url'),
    connect: $('#bridge-connect'),
    pairWrap: $('#bridge-pair-wrap'),
    token: $('#bridge-token'),
    pair: $('#bridge-pair'),
    readQr: $('#bridge-read-qr'),
    list: $('#printer-list'),
    listWrap: $('#printer-list-wrap'),
    address: $('#printer-addr'),
    probe: $('#printer-probe'),
    options: $('#scan-options'),
    source: $('#scan-source'),
    color: $('#scan-color'),
    res: $('#scan-res'),
    duplex: $('#scan-duplex'),
    size: $('#scan-size'),
    format: $('#scan-format'),
    start: $('#scan-start'),
    hint: $('#scan-hint'),
    shareToggle: $('#bridge-share-toggle'),
    share: $('#bridge-share'),
    shareQr: $('#bridge-qr'),
    shareHint: $('#bridge-qr-hint'),
    shareUrl: $('#bridge-qr-url'),
    shareCopy: $('#bridge-qr-copy'),
    extDot: $('#ext-dot'),
    extStatus: $('#ext-status'),
    qrModal: $('#modal-qr'),
    qrVideo: $('#qr-video'),
    helpHint: $('#bridge-pair-hint'),
  };

  ui.scanner.url.value = store.state.bridge?.url || bridgeLib.DEFAULT_BRIDGE;
  ui.scanner.readQr.hidden = !qrLib.qrReadingSupported();
}

async function openScanner() {
  openModal(ui.scanner.modal);
  setMethod(scannerState.method);
  await refreshBridge();
  if (!scannerState.bridge) await refreshExtension();
}

function setMethod(method) {
  scannerState.method = method;
  for (const button of $$('button', ui.scanner.method)) {
    button.setAttribute('aria-checked', String(button.dataset.method === method));
  }
  $('#method-bridge').hidden = method !== 'bridge';
  $('#method-extension').hidden = method !== 'extension';
  $('#method-address').hidden = method !== 'address';
  if (method === 'extension') refreshExtension();
}

function setBridgeStatus(state, message) {
  ui.scanner.dot.className = `dot ${state}`;
  ui.scanner.status.textContent = message;
}

function setExtStatus(state, message) {
  ui.scanner.extDot.className = `dot ${state}`;
  ui.scanner.extStatus.textContent = message;
}

function setScanHint(message) {
  ui.scanner.hint.textContent = message || '';
}

/** Find the best bridge: this origin first, then loopback, then last used. */
async function refreshBridge() {
  setBridgeStatus('busy', 'Looking for a scanning bridge…');
  let found = [];
  try {
    found = await bridgeLib.detectBridges({ remember: recalledBridge() });
  } catch {
    found = [];
  }

  const best = found[0];
  if (!best) {
    scannerState.bridge = null;
    scannerState.client = null;
    setBridgeStatus(
      'bad',
      'No bridge answered. Start one, or paste its address — it is one Node command.',
    );
    ui.scanner.pairWrap.hidden = true;
    ui.scanner.shareToggle.hidden = true;
    ui.scanner.share.hidden = true;
    renderPrinterList([]);
    return null;
  }

  scannerState.bridge = best;
  store.state.bridge = { url: best.url, token: best.token || '' };
  rememberBridge();
  return applyBridge(best);
}

function applyBridge(info) {
  ui.scanner.url.value = info.url;
  ui.scanner.servedByBridge.hidden = !info.sameOrigin;
  ui.scanner.shareToggle.hidden = !info.lan;

  if (info.requiresToken && !info.paired) {
    setBridgeStatus('bad', `Found a bridge at ${info.url}, but it needs a pairing code.`);
    ui.scanner.pairWrap.hidden = false;
    ui.scanner.share.hidden = true;
    renderPrinterList([]);
    return info;
  }

  ui.scanner.pairWrap.hidden = !info.requiresToken;
  setBridgeStatus(
    'ok',
    `Connected to ${info.url}${info.lan ? ' — shared on your network' : ''}` +
      ` · bridge ${info.version}`,
  );
  scannerState.client = new bridgeLib.BridgeClient(info.url, info.token || '');
  renderPrinterList(info.printers || []);
  renderShare(info);
  // Refresh in the background: discovery on the bridge side takes a moment.
  loadPrinters();
  return info;
}

async function loadPrinters() {
  const client = activeClient();
  if (!client) return;
  setBridgeStatus('busy', 'Looking for printers…');
  try {
    const printers = await client.discover();
    renderPrinterList(printers);
    const where = scannerState.bridge?.url || 'the extension';
    setBridgeStatus('ok', `${printers.length} device${printers.length === 1 ? '' : 's'} via ${where}`);
  } catch (error) {
    if (scannerState.bridge) setBridgeStatus('bad', error.message);
  }
}

function activeClient() {
  if (scannerState.method === 'extension') return scannerState.extension;
  if (scannerState.method === 'address') return scannerState.extension || scannerState.client;
  return scannerState.client || scannerState.extension;
}

async function refreshExtension() {
  const client = new bridgeLib.ExtensionClient();
  const info = await client.probe();
  if (!info) {
    client.dispose();
    scannerState.extension = null;
    setExtStatus('bad', 'The extension is not installed or is disabled in this browser.');
    return null;
  }
  scannerState.extension = client;
  setExtStatus('ok', `Extension connected · version ${info.version}`);
  if (scannerState.method === 'extension') {
    try {
      const printers = await client.discover({
        onPrinter: (printer) => addPrinter(printer),
      });
      renderPrinterList(printers);
      if (!printers.length) {
        setExtStatus('busy', 'No printers answered yet. Add one by address.');
      }
    } catch (error) {
      setExtStatus('bad', error.message);
    }
  }
  return client;
}

function renderPrinterList(printers) {
  ui.scanner.listWrap.hidden = !printers.length;
  ui.scanner.list.textContent = '';
  for (const printer of printers) addPrinter(printer);
}

function addPrinter(printer) {
  ui.scanner.listWrap.hidden = false;
  if (ui.scanner.list.querySelector(`[data-printer-id="${CSS.escape(printer.id)}"]`)) return;
  const item = el('div', {
    class: 'printer-item',
    role: 'button',
    tabindex: '0',
    dataset: { printerId: printer.id },
    'aria-pressed': String(scannerState.printer?.id === printer.id),
    onclick: () => selectPrinter(printer),
  }, [
    el('span', { html: '<svg viewBox="0 0 24 24"><path d="M6 9V4h12v5M6 18H5a2 2 0 01-2-2v-5a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-1M6 15h12v6H6z"/></svg>' }),
    el('span', {}, [
      el('div', { class: 'p-name' }, printer.name || printer.address),
      el('div', { class: 'p-meta' },
        [printer.model, printer.address && `${printer.address}:${printer.port}`,
          printer.manual ? 'added by address' : printer.found ? 'found on this network' : 'Bonjour']
          .filter(Boolean).join(' · ')),
    ]),
  ]);
  ui.scanner.list.append(item);
}

async function selectPrinter(printer) {
  scannerState.printer = printer;
  for (const item of $$('.printer-item', ui.scanner.list)) {
    item.setAttribute('aria-pressed', String(item.dataset.printerId === printer.id));
  }
  ui.scanner.options.hidden = false;
  setScanHint('Reading the device’s capabilities…');
  const client = activeClient();
  try {
    const caps = await client.capabilities(printer.id);
    scannerState.caps = caps;
    fillScannerOptions(caps);
    setScanHint('');
  } catch (error) {
    setScanHint(error.message);
  }
}

function fillScannerOptions(caps) {
  ui.scanner.source.textContent = '';
  for (const source of caps.sources || ['Platen']) {
    ui.scanner.source.append(el('option', { value: source }, source === 'Feeder' ? 'ADF / feeder' : 'Flatbed'));
  }
  if ((caps.sources || []).includes('Feeder')) ui.scanner.source.value = 'Feeder';

  ui.scanner.color.textContent = '';
  const labels = { RGB24: 'Color', Grayscale8: 'Grayscale', BlackAndWhite1: 'Black & white' };
  for (const mode of caps.colorModes || ['RGB24']) {
    ui.scanner.color.append(el('option', { value: mode }, labels[mode] || mode));
  }

  ui.scanner.res.textContent = '';
  const resolutions = caps.resolutions?.length ? caps.resolutions : [75, 150, 200, 300, 600];
  for (const dpi of resolutions) ui.scanner.res.append(el('option', { value: String(dpi) }, `${dpi} dpi`));
  if (resolutions.includes(300)) ui.scanner.res.value = '300';

  ui.scanner.duplex.disabled = !caps.duplex;
  if (!caps.duplex) ui.scanner.duplex.value = 'false';
}

async function connectToTypedBridge() {
  const url = bridgeLib.normaliseBridgeUrl(ui.scanner.url.value) || bridgeLib.DEFAULT_BRIDGE;
  const token = bridgeLib.tokenFromInput(ui.scanner.token.value) || store.state.bridge?.token || '';
  store.state.bridge = { url, token };
  rememberBridge();
  setBridgeStatus('busy', `Connecting to ${url}…`);
  const info = await refreshBridge();
  if (!info) return;
  if (info.requiresToken && !info.paired) {
    setBridgeStatus('bad', `${url} needs a pairing code — paste it below.`);
    ui.scanner.pairWrap.hidden = false;
    return;
  }
  await loadPrinters();
}

async function pairBridge() {
  const token = bridgeLib.tokenFromInput(ui.scanner.token.value) || ui.scanner.token.value.trim();
  if (!token) {
    setBridgeStatus('bad', 'Paste the pairing code first.');
    return;
  }
  store.state.bridge = {
    url: bridgeLib.normaliseBridgeUrl(ui.scanner.url.value) || store.state.bridge?.url || bridgeLib.DEFAULT_BRIDGE,
    token,
  };
  rememberBridge();
  setBridgeStatus('busy', 'Pairing…');
  const info = await refreshBridge();
  if (info?.paired) {
    ui.scanner.token.value = '';
    await loadPrinters();
    toast('Paired with the bridge');
  } else if (info) {
    setBridgeStatus('bad', 'That code was not accepted. Check it and try again.');
  }
}

/** Show a QR code so a phone can join with one scan. */
async function renderShare(info) {
  if (!info.lan) {
    ui.scanner.share.hidden = true;
    return;
  }
  ui.scanner.share.hidden = window.innerWidth < 900;
  const host = info.addresses?.[0] || location.hostname;
  const scheme = info.url.startsWith('https') ? 'https' : 'http';
  const url = `${scheme}://${host}:${info.port}/${info.token ? `#s=${info.token}` : ''}`;
  ui.scanner.shareUrl.value = url;
  ui.scanner.shareHint.textContent = info.token
    ? 'The link carries the pairing code, so the other device needs no setup.'
    : 'This bridge has no pairing code, so anyone on your network can use it.';
  try {
    const { dataUrl } = await qrLib.renderQr(url, { size: 180 });
    ui.scanner.shareQr.src = dataUrl;
    ui.scanner.shareQr.hidden = false;
  } catch {
    ui.scanner.shareQr.hidden = true;
  }
}

async function readPairingQr() {
  if (!qrLib.qrReadingSupported()) return;
  openModal(ui.scanner.qrModal);
  setScanHint('');
  try {
    const text = await qrLib.readQr({ video: ui.scanner.qrVideo });
    closeModal(ui.scanner.qrModal);
    const url = bridgeLib.normaliseBridgeUrl(text);
    const token = bridgeLib.tokenFromInput(text);
    if (!url || !token) throw new Error('That code does not look like a Scanlet bridge link.');
    store.state.bridge = { url, token };
    rememberBridge();
    ui.scanner.url.value = url;
    ui.scanner.token.value = token;
    await pairBridge();
  } catch (error) {
    closeModal(ui.scanner.qrModal);
    toast(error.message, { kind: 'err', timeout: 6000 });
  }
}

async function probeByAddress() {
  const address = ui.scanner.address.value.trim();
  if (!address) return;
  const client = activeClient();
  if (!client) {
    setScanHint('Add a printer by address through the bridge or the extension.');
    return;
  }
  setScanHint(`Asking ${address}…`);
  try {
    const result = await client.probeAddress(address);
    const printer = result.printer || result;
    addPrinter(printer);
    await selectPrinter(printer);
    toast(`Added ${printer.address}`);
  } catch (error) {
    setScanHint(error.message);
  }
}

async function startScan() {
  const printer = scannerState.printer;
  const client = activeClient();
  if (!printer || !client) return;

  const options = {
    resolution: Number(ui.scanner.res.value) || 200,
    colorMode: ui.scanner.color.value,
    inputSource: ui.scanner.source.value,
    duplex: ui.scanner.duplex.value,
    format: ui.scanner.format.value,
    pageSize: ui.scanner.size.value,
  };

  ui.scanner.start.disabled = true;
  setScanHint('Waiting for the scanner…');
  try {
    const pages = await client.scan(printer.id, options, {
      onProgress: (index, total) => setScanHint(`Receiving page ${index}${total ? ` of ${total}` : ''}…`),
    });
    if (!pages.length) throw new Error('The scanner returned no pages.');

    let dropped = 0;
    await withProgress('Adding scanned pages', async ({ update }) => {
      for (const [index, part] of pages.entries()) {
        update(index / pages.length, `Page ${index + 1} of ${pages.length}`);
        if (part.mime === 'application/pdf') {
          const rendered = await pdfs.importPdfFile(
            new File([part.blob], 'scan.pdf', { type: 'application/pdf' }),
          );
          for (const item of rendered) await addCanvasPage(item.canvas, { source: 'scanner' });
          continue;
        }
        const bitmap = await loadImage(part.blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.naturalWidth;
        canvas.height = bitmap.naturalHeight;
        ctx2d(canvas).drawImage(bitmap, 0, 0);
        if (imaging.inkRatio(canvas) < 0.0025) {
          dropped++;
          continue;
        }
        await addCanvasPage(canvas, {
          source: 'scanner',
          blob: await canvasToBlob(canvas, 'image/jpeg', 0.95),
          filter: 'enhance',
        });
      }
    });

    setScanHint('');
    toast(
      `Scanned ${pages.length - dropped} page${pages.length - dropped === 1 ? '' : 's'} from ` +
        `${printer.name || 'the printer'}${dropped ? ` — skipped ${dropped} blank sheet${dropped === 1 ? '' : 's'}` : ''}`,
    );
  } catch (error) {
    setScanHint('');
    toast(error.message, { kind: 'err', timeout: 7000 });
  } finally {
    ui.scanner.start.disabled = false;
  }
}

/* ─────────────────────────────── export ─────────────────────────────── */

function bindExport() {
  ui.exp = {
    modal: $('#modal-export'),
    filename: $('#exp-filename'),
    pageSize: $('#exp-pagesize'),
    orientation: $('#exp-orientation'),
    margin: $('#exp-margin'),
    marginOut: $('#exp-margin-out'),
    layout: $('#exp-layout'),
    back2back: $('#exp-back2back'),
    quality: $('#exp-quality'),
    qualityOut: $('#exp-quality-out'),
    imageFormat: $('#exp-imageformat'),
    maxDpi: $('#exp-maxdpi'),
    searchable: $('#exp-searchable'),
    pageNumbers: $('#exp-pagenumbers'),
    watermark: $('#exp-watermark'),
    watermarkText: $('#exp-watermark-text'),
    bookmarks: $('#exp-bookmarks'),
    metadata: $('#exp-metadata'),
    title: $('#exp-title'),
    author: $('#exp-author'),
    subject: $('#exp-subject'),
    keywords: $('#exp-keywords'),
    language: $('#exp-language'),
    estimate: $('#exp-estimate'),
    openAfter: $('#exp-open-after'),
    go: $('#exp-go'),
  };

  for (const language of ocrLib.OCR_LANGUAGES) {
    ui.exp.language.append(el('option', { value: language.code }, language.label));
  }

  const sync = () => {
    ui.exp.marginOut.value = `${ui.exp.margin.value} mm`;
    ui.exp.qualityOut.value = ui.exp.quality.value;
    ui.exp.watermarkText.disabled = !ui.exp.watermark.checked;
    updateEstimate();
  };
  for (const input of $$('input, select', ui.exp.modal)) input.addEventListener('input', sync);
  sync();
}

function openExport() {
  const doc = store.activeDoc();
  if (!doc?.pages.length) {
    toast('Add some pages first.');
    return;
  }
  const saved = { ...pdfs.DEFAULT_EXPORT, ...(doc.export || {}) };
  ui.exp.filename.value = `${safeFilename(doc.name, 'scan')}.pdf`;
  ui.exp.pageSize.value = saved.pageSize;
  ui.exp.orientation.value = saved.orientation;
  ui.exp.margin.value = String(saved.margin);
  ui.exp.layout.value = String(saved.layout);
  ui.exp.back2back.checked = Boolean(saved.back2back);
  ui.exp.quality.value = String(saved.quality);
  ui.exp.imageFormat.value = saved.imageFormat;
  ui.exp.maxDpi.value = String(saved.maxDpi);
  ui.exp.searchable.checked = Boolean(saved.searchable);
  ui.exp.pageNumbers.checked = Boolean(saved.pageNumbers);
  ui.exp.watermark.checked = Boolean(saved.watermark);
  ui.exp.watermarkText.value = saved.watermarkText;
  ui.exp.bookmarks.checked = Boolean(saved.bookmarks);
  ui.exp.metadata.checked = Boolean(saved.metadata);
  ui.exp.title.value = saved.title || doc.name;
  ui.exp.author.value = saved.author || '';
  ui.exp.subject.value = saved.subject || '';
  ui.exp.keywords.value = saved.keywords || '';
  ui.exp.marginOut.value = `${ui.exp.margin.value} mm`;
  ui.exp.qualityOut.value = ui.exp.quality.value;
  ui.exp.watermarkText.disabled = !ui.exp.watermark.checked;
  updateEstimate();
  openModal(ui.exp.modal);
}

function readExportOptions() {
  return {
    pageSize: ui.exp.pageSize.value,
    orientation: ui.exp.orientation.value,
    margin: Number(ui.exp.margin.value),
    layout: ui.exp.layout.value,
    back2back: ui.exp.back2back.checked,
    quality: Number(ui.exp.quality.value),
    imageFormat: ui.exp.imageFormat.value,
    maxDpi: Number(ui.exp.maxDpi.value),
    searchable: ui.exp.searchable.checked,
    pageNumbers: ui.exp.pageNumbers.checked,
    watermark: ui.exp.watermark.checked,
    watermarkText: ui.exp.watermarkText.value,
    bookmarks: ui.exp.bookmarks.checked,
    metadata: ui.exp.metadata.checked,
    title: ui.exp.title.value,
    author: ui.exp.author.value,
    subject: ui.exp.subject.value,
    keywords: ui.exp.keywords.value,
  };
}

function applyPreset(kind) {
  const presets = {
    scan: { pageSize: 'A4', quality: 82, imageFormat: 'image/jpeg', maxDpi: 300, searchable: true, layout: '1', margin: 0 },
    archive: { pageSize: 'A4', quality: 92, imageFormat: 'image/jpeg', maxDpi: 400, searchable: true, layout: '1', margin: 0 },
    small: { pageSize: 'A4', quality: 62, imageFormat: 'image/jpeg', maxDpi: 150, searchable: true, layout: '1', margin: 0 },
  };
  const preset = presets[kind];
  if (!preset) return;
  ui.exp.pageSize.value = preset.pageSize;
  ui.exp.quality.value = String(preset.quality);
  ui.exp.imageFormat.value = preset.imageFormat;
  ui.exp.maxDpi.value = String(preset.maxDpi);
  ui.exp.searchable.checked = preset.searchable;
  ui.exp.layout.value = preset.layout;
  ui.exp.margin.value = String(preset.margin);
  ui.exp.marginOut.value = `${preset.margin} mm`;
  ui.exp.qualityOut.value = String(preset.quality);
  updateEstimate();
}

function updateEstimate() {
  const doc = store.activeDoc();
  if (!doc?.pages.length) return;
  const options = readExportOptions();
  const quality = clamp(Number(options.quality) / 100, 0.2, 1);
  let pixels = 0;
  for (const page of doc.pages) pixels += page.width * page.height;
  const perPixel = options.imageFormat === 'image/png' ? 1.1 : 0.42 * quality ** 2.4;
  const bytes = pixels * perPixel * 0.25;
  const searchable = doc.pages.filter((p) => p.ocr).length;
  ui.exp.estimate.textContent =
    `≈ ${formatBytes(bytes)} across ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}` +
    (options.searchable
      ? searchable
        ? ` · text layer on ${searchable} page${searchable === 1 ? '' : 's'}`
        : ' · no page recognised yet, so no text layer will be written'
      : '');
}

async function exportPdf() {
  const doc = store.activeDoc();
  const options = readExportOptions();
  if (options.searchable && !doc.pages.some((p) => p.ocr)) {
    toast('No page has recognised text yet — exporting without a text layer.', { timeout: 5000 });
  }
  doc.export = { ...options };
  await store.saveDoc(doc);

  const maxDpi = Number(options.maxDpi) || 0;
  const sheetLongIn = options.pageSize === 'fit'
    ? pdfs.SHEET_SIZES.A4[1] / 72
    : Math.max(...(pdfs.SHEET_SIZES[options.pageSize] || pdfs.SHEET_SIZES.A4)) / 72;
  const maxEdge = maxDpi ? Math.round(maxDpi * sheetLongIn) : 0;

  const pdfPages = doc.pages;

  try {
    const bytes = await withProgress('Building the PDF', async ({ update, shouldCancel, setTitle }) => {
      const pdfBytes = await pdfs.buildPdf(pdfPages, options, {
        renderCanvas: async (page) => {
          if (shouldCancel()) throw new Error('cancelled');
          const canvas = await renderForPage(page, { maxEdge, trim: Boolean(page.adjustments?.autoCrop) });
          update(0, `Rendering page ${doc.pages.indexOf(page) + 1}`);
          return canvas;
        },
        onProgress: (sheet, total) => {
          setTitle('Building the PDF');
          update(sheet / total, `Sheet ${sheet} of ${total}`);
        },
      });
      return pdfBytes;
    });
    if (!bytes) return;

    const blob = new Blob([bytes], { type: 'application/pdf' });
    const name = options.title ? `${safeFilename(options.title)}.pdf` : ui.exp.filename.value;
    download(blob, name);
    closeModal(ui.exp.modal);
    toast(`PDF ready — ${formatBytes(blob.size)}`);
    if (ui.exp.openAfter.checked) {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }
  } catch (error) {
    if (error.message !== 'cancelled') toast(error.message, { kind: 'err' });
  }
}

async function exportImages() {
  const doc = store.activeDoc();
  if (!doc?.pages.length) return;
  const zip = await loadZip();
  await withProgress('Exporting images', async ({ update, shouldCancel }) => {
    const archive = new zip();
    for (const [index, page] of doc.pages.entries()) {
      if (shouldCancel()) return;
      update(index / doc.pages.length, `Page ${index + 1}`);
      const canvas = await renderForPage(page, { trim: Boolean(page.adjustments?.autoCrop) });
      const blob = await canvasToBlob(canvas, 'image/png');
      archive.file(`page-${String(index + 1).padStart(3, '0')}.png`, blob);
    }
    const blob = await archive.generateAsync({ type: 'blob' });
    download(blob, `${safeFilename(doc.name)}-pages.zip`);
  });
}

/* ─────────────────────────────── project bundles ─────────────────────────────── */

async function loadZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = JSZIP_CDN;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the archive library.'));
    document.head.append(script);
  });
  return window.JSZip;
}

async function saveProjectBundle() {
  const doc = store.activeDoc();
  if (!doc) return;
  const zip = await loadZip();
  const archive = new zip();
  const manifest = { version: 1, app: 'scanlet', name: doc.name, pages: [] };

  for (const [index, page] of doc.pages.entries()) {
    const record = await store.getBlobRecord(page.blobId);
    if (!record) continue;
    const extension = record.blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `pages/${String(index + 1).padStart(3, '0')}.${extension}`;
    archive.file(path, record.blob);
    manifest.pages.push({ ...recipeOf(page), file: path, mime: record.blob.type || 'image/jpeg' });
  }
  archive.file('scanlet.json', JSON.stringify(manifest, null, 2));
  const blob = await archive.generateAsync({ type: 'blob' });
  download(blob, `${safeFilename(doc.name)}.scanlet.zip`);
  toast('Project bundle saved');
}

async function openProjectBundle(file) {
  const zip = await loadZip();
  const archive = await zip.loadAsync(file);
  const manifestFile = archive.file('scanlet.json');
  if (!manifestFile) throw new Error('That archive is not a Scanlet project.');
  const manifest = JSON.parse(await manifestFile.async('string'));
  const doc = store.newDoc(manifest.name || stripExt(file.name));
  doc.pages = [];

  await withProgress('Opening project', async ({ update }) => {
    for (const [index, record] of manifest.pages.entries()) {
      update(index / manifest.pages.length, `Page ${index + 1}`);
      const entry = archive.file(record.file);
      if (!entry) continue;
      const blob = await entry.async('blob');
      const typed = new Blob([blob], { type: record.mime || 'image/jpeg' });
      const bitmap = await loadImage(typed);
      const page = store.makePage({
        blob: typed,
        width: bitmap.naturalWidth,
        height: bitmap.naturalHeight,
        thumb: '',
        source: record.source || 'import',
      });
      Object.assign(page, {
        filter: record.filter || 'original',
        rotation: record.rotation || 0,
        flipH: Boolean(record.flipH),
        crop: record.crop || null,
        adjustments: record.adjustments || { brightness: 0, contrast: 0, saturation: 0, autoCrop: false },
        ocr: record.ocr || null,
      });
      await store.putBlob(page.blobId, typed);
      delete page.blob;
      doc.pages.push(page);
    }
  });

  store.state.docs.unshift(doc);
  store.state.activeId = doc.id;
  store.state.selection.clear();
  await store.saveDoc(doc, { immediate: true });
  await refreshPages(doc.pages);
  store.emit({ reason: 'docs' });
  toast(`Opened “${doc.name}” with ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}`);
}

/* ─────────────────────────────── undo ─────────────────────────────── */

function pushUndo() {
  const doc = store.activeDoc();
  if (!doc) return;
  undoStack.push({
    docId: doc.id,
    pages: JSON.stringify(doc.pages),
    selection: [...store.state.selection],
  });
  if (undoStack.length > 30) undoStack.shift();
}

async function undo() {
  const entry = undoStack.pop();
  if (!entry) {
    toast('Nothing to undo');
    return;
  }
  const doc = store.state.docs.find((d) => d.id === entry.docId);
  if (!doc) return;
  doc.pages = JSON.parse(entry.pages);
  store.state.activeId = doc.id;
  store.setSelection(entry.selection);
  await store.saveDoc(doc, { immediate: true });
  store.emit({ reason: 'pages' });
  toast('Undone');
}

/* ─────────────────────────────── app bar & inspector ─────────────────────────────── */

function bindAppBar() {
  $('#act-import').addEventListener('click', () => ui.fileInput.click());
  $('#act-camera').addEventListener('click', openCapture);
  $('#act-scanner').addEventListener('click', openScanner);
  $('#act-export').addEventListener('click', openExport);
  $('#btn-new-doc').addEventListener('click', newDocument);
  $('#btn-menu').addEventListener('click', () => ui.rail.classList.toggle('open'));

  ui.docTitle.addEventListener('change', async () => {
    const doc = store.activeDoc();
    if (!doc) return;
    doc.name = ui.docTitle.value.trim() || 'Untitled document';
    await store.saveDoc(doc);
    store.emit({ reason: 'docs' });
  });

  const menuButton = $('#btn-app-menu');
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    ui.menu.hidden = !ui.menu.hidden;
    menuButton.setAttribute('aria-expanded', String(!ui.menu.hidden));
  });
  document.addEventListener('click', () => {
    ui.menu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
  });
  ui.menu.addEventListener('click', async (event) => {
    const action = event.target.closest('button')?.dataset.menu;
    if (!action) return;
    ui.menu.hidden = true;
    const handlers = {
      'save-project': saveProjectBundle,
      'open-project': () => ui.projectInput.click(),
      'export-images': exportImages,
      'ocr-all': runOcrOnAllPages,
      'straighten-all': async () => {
        const doc = store.activeDoc();
        store.setSelection(doc.pages.map((p) => p.id));
        await deskewSelection();
      },
      'flatten-all': async () => {
        const doc = store.activeDoc();
        store.setSelection(doc.pages.map((p) => p.id));
        await bakeSelection();
      },
      settings: openExport,
      about: openAbout,
    };
    await handlers[action]?.();
  });

  for (const button of $$('#empty-state [data-empty]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.empty;
      if (action === 'import') ui.fileInput.click();
      if (action === 'camera') openCapture();
      if (action === 'scanner') openScanner();
    });
  }

  $('#btn-storage').addEventListener('click', async () => {
    const report = await store.storageReport();
    toast(`${report.docs} document${report.docs === 1 ? '' : 's'}, ${report.pages} pages, ${formatBytes(report.usage)} stored locally`);
  });
}

function bindInspector() {
  $('#btn-clear-sel').addEventListener('click', () => store.setSelection([]));
  ui.filterSeg.addEventListener('click', (event) => {
    const filter = event.target.closest('button')?.dataset.filter;
    if (filter) setFilter(filter);
  });
  $('#btn-rotate-l').addEventListener('click', () => rotateSelection(-90));
  $('#btn-rotate-r').addEventListener('click', () => rotateSelection(90));
  $('#btn-flip').addEventListener('click', flipSelection);
  $('#btn-deskew').addEventListener('click', deskewSelection);
  $('#btn-crop').addEventListener('click', () => openEditor(store.selectedPages()[0]));
  $('#btn-duplicate').addEventListener('click', duplicateSelection);
  $('#btn-move-up').addEventListener('click', () => moveSelection(-1));
  $('#btn-move-down').addEventListener('click', () => moveSelection(1));
  $('#btn-split').addEventListener('click', splitAtSelection);
  $('#btn-extract').addEventListener('click', extractSelection);
  $('#btn-ocr').addEventListener('click', runOcrOnSelection);
  $('#btn-ocr-text').addEventListener('click', showRecognisedText);
  $('#btn-delete').addEventListener('click', deleteSelectedPages);

  const liveAdjust = debounce(() => applyAdjustments(), 320);
  for (const key of ['brightness', 'contrast', 'saturation']) {
    ui.adj[key].addEventListener('input', liveAdjust);
  }
  ui.adj.angle.addEventListener('input', debounce(() => {
    const angle = Number(ui.adj.angle.value);
    mutatePages((page) => {
      page.rotation = angle;
    });
  }, 260));
  ui.adj.autoCrop.addEventListener('change', () =>
    mutatePages((page) => {
      page.adjustments = { ...page.adjustments, autoCrop: ui.adj.autoCrop.checked };
    }, { refresh: false }),
  );
}

/* ─────────────────────────────── modals & progress ─────────────────────────────── */

function bindModals() {
  for (const modal of $$('.modal')) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal && modal.id !== 'modal-progress') closeModal(modal);
    });
    for (const button of $$('[data-close]', modal)) {
      button.addEventListener('click', () => closeModal(modal));
    }
  }
  $('#cam-shoot').addEventListener('click', shoot);
  $('#cam-done').addEventListener('click', commitShots);
  $('#cam-review').addEventListener('click', () => {
    ui.capture.strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('#cam-device').addEventListener('change', async (event) => {
    try {
      await camera.start({ deviceId: event.target.value, idealWidth: Number(ui.capture.res.value) });
      camera.startDetection();
    } catch (error) {
      toast(error.message, { kind: 'err' });
    }
  });
  $('#cam-res').addEventListener('change', () => camera.start({ deviceId: camera.deviceId, idealWidth: Number(ui.capture.res.value) }).catch(() => {}));

  $('#ed-filter-seg').addEventListener('click', (event) => {
    const filter = event.target.closest('button')?.dataset.filter;
    if (!filter) return;
    editorState.filter = filter;
    setSeg(ui.edFilterSeg, filter);
  });
  $('#ed-rot-l').addEventListener('click', () => changeEditorRotation(-90));
  $('#ed-rot-r').addEventListener('click', () => changeEditorRotation(90));
  $('#ed-flip').addEventListener('click', () => {
    editorState.flipH = !editorState.flipH;
  });
  $('#ed-deskew').addEventListener('click', async () => {
    const angle = imaging.estimateSkew(editorState.working);
    if (!angle) {
      toast('This page already looks straight.');
      return;
    }
    editorState.rotation = Number(((editorState.rotation + angle) % 360).toFixed(2));
    ui.editor.angle.value = String(clamp(editorState.rotation, -180, 180));
    ui.editor.angleOut.value = `${editorState.rotation}°`;
  });
  $('#ed-angle').addEventListener('input', () => {
    editorState.rotation = Number($('#ed-angle').value);
    ui.editor.angleOut.value = `${editorState.rotation}°`;
  });
  $('#ed-auto-crop').addEventListener('click', editorAutoCrop);
  $('#ed-reset').addEventListener('click', () => {
    editorState.corners = null;
    drawCornerHandles(ui.editor.canvas.width / editorState.working.width);
  });
  $('#ed-apply').addEventListener('click', () => applyEditor({ copy: false }));
  $('#ed-apply-copy').addEventListener('click', () => applyEditor({ copy: true }));

  $('#exp-go').addEventListener('click', exportPdf);
  $('#exp-preset-scan').addEventListener('click', () => applyPreset('scan'));
  $('#exp-preset-archive').addEventListener('click', () => applyPreset('archive'));
  $('#exp-preset-small').addEventListener('click', () => applyPreset('small'));

  $('#bridge-connect').addEventListener('click', connectToTypedBridge);
  $('#bridge-pair').addEventListener('click', pairBridge);
  $('#bridge-read-qr').addEventListener('click', readPairingQr);
  $('#bridge-share-toggle').addEventListener('click', () => {
    ui.scanner.share.hidden = !ui.scanner.share.hidden;
  });
  $('#bridge-qr-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(ui.scanner.shareUrl.value);
    toast('Link copied');
  });
  $('#printer-probe').addEventListener('click', probeByAddress);
  $('#scan-start').addEventListener('click', startScan);
  $('#ext-recheck').addEventListener('click', refreshExtension);
  ui.scanner.method.addEventListener('click', (event) => {
    const method = event.target.closest('button')?.dataset.method;
    if (method) setMethod(method);
  });
  $('#btn-bridge-help').addEventListener('click', () => openModal($('#modal-help')));
  $('#help-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#help-cmd').textContent);
    toast('Command copied');
  });
  $('#btn-selftest').addEventListener('click', runSelfTest);
  $('#btn-theme').addEventListener('click', toggleTheme);
}

function changeEditorRotation(delta) {
  editorState.rotation = (((editorState.rotation + delta) % 360) + 360) % 360;
  const normalized = editorState.rotation > 180 ? editorState.rotation - 360 : editorState.rotation;
  ui.editor.angle.value = String(clamp(normalized, -180, 180));
  ui.editor.angleOut.value = `${editorState.rotation}°`;
}

function openModal(modal) {
  modal.hidden = false;
  const focusable = modal.querySelector('input, select, button');
  focusable?.focus?.();
}

function closeModal(modal) {
  if (modal === ui.capture.modal) {
    camera?.stop();
    cameras.shots = [];
    renderShotStrip();
  }
  if (modal === ui.editor.modal) {
    editorState.page = null;
    editorState.working = null;
  }
  modal.hidden = true;
}

function closeTopModal() {
  const open = $$('.modal').filter((node) => !node.hidden && node.id !== 'modal-progress');
  const last = open[open.length - 1];
  if (last) closeModal(last);
  closePageMenu();
}

/** Show the progress sheet and run `task`; resolves with whatever it returns. */
async function withProgress(title, task) {
  const cancelled = { value: false };
  ui.progress.modal.hidden = false;
  ui.progress.title.textContent = title;
  ui.progress.bar.style.width = '0%';
  ui.progress.detail.textContent = '';
  store.state.busy = true;
  ui.progress.cancel.hidden = false;
  const onCancel = () => {
    cancelled.value = true;
    ui.progress.detail.textContent = 'Finishing the current step…';
  };
  ui.progress.cancel.addEventListener('click', onCancel);
  await nextFrame();

  const api = {
    update: (fraction, detail) => {
      ui.progress.bar.style.width = `${clamp(fraction * 100, 0, 100)}%`;
      if (detail !== undefined) ui.progress.detail.textContent = detail;
    },
    setTitle: (value) => {
      ui.progress.title.textContent = value;
    },
    shouldCancel: () => cancelled.value,
  };

  try {
    return await task(api);
  } catch (error) {
    if (error.message !== 'cancelled') throw error;
    return null;
  } finally {
    ui.progress.cancel.removeEventListener('click', onCancel);
    ui.progress.modal.hidden = true;
    store.state.busy = false;
  }
}

/* ─────────────────────────────── misc ─────────────────────────────── */

function applyStoredTheme() {
  const stored = localStorage.getItem('scanlet:theme');
  if (stored) document.documentElement.dataset.theme = stored;
  else document.documentElement.dataset.theme = 'auto';
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('scanlet:theme', next);
}

async function updateStorageLabel() {
  try {
    const report = await store.storageReport();
    const pages = store.state.docs.reduce((total, doc) => total + doc.pages.length, 0);
    $('#storage-label').textContent = `${pages} page${pages === 1 ? '' : 's'} · ${formatBytes(report.usage)}`;
  } catch {
    $('#storage-label').textContent = 'Local storage';
  }
}

function openAbout() {
  $('#about-versions').textContent =
    `PDF.js ${pdfs.PDFJS_VERSION} · pdf-lib ${pdfs.PDFLIB_VERSION} · Tesseract.js 5.1.1 · JSZip 3.10.1 · qrcode-generator 1.4.4`;
  openModal($('#modal-about'));
}

async function runSelfTest() {
  const out = $('#selftest-out');
  out.hidden = false;
  out.textContent = 'Running…';
  const lines = [];
  const record = (name, ok, detail = '') => lines.push(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 520;
    const ctx = ctx2d(canvas);
    ctx.fillStyle = '#20243a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(40, 40, 320, 440);
    ctx.fillStyle = '#111111';
    for (let i = 0; i < 8; i++) ctx.fillRect(70, 90 + i * 40, 260 - i * 12, 10);
    record('canvas available', canvas.width === 400);

    const quad = [{ x: 40, y: 40 }, { x: 360, y: 40 }, { x: 360, y: 480 }, { x: 40, y: 480 }];
    const warped = imaging.warpPerspective(canvas, quad);
    record('perspective warp', warped.width > 280 && warped.height > 400, `${warped.width}×${warped.height}`);

    const detected = imaging.detectDocumentCorners(canvas);
    record('edge detection finds the sheet', Boolean(detected), detected ? detected.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ') : 'none');

    const bw = imaging.enhance(canvas, { filter: 'bw' });
    const ratio = imaging.inkRatio(bw);
    record('adaptive black & white yields ink', ratio > 0.01 && ratio < 0.9, `ink ${(ratio * 100).toFixed(1)}%`);

    const magic = imaging.enhance(canvas, { filter: 'magic' });
    record('shadow removal runs', magic.width === canvas.width);

    const skew = imaging.estimateSkew(canvas);
    record('deskew estimate on a straight page', Math.abs(skew) < 1, `${skew}°`);

    const trimmed = imaging.trimBorders(canvas);
    record('border trim', trimmed.width <= canvas.width, `${trimmed.width}×${trimmed.height}`);

    const rotated = imaging.rotate90(canvas, 1);
    record('90° rotation swaps axes', rotated.width === canvas.height && rotated.height === canvas.width);

    if (window.PDFLib) {
      const { PDFDocument, PDFName } = window.PDFLib;
      const pagesIn = [1, 2, 3].map((n) => ({
        id: `p${n}`,
        filter: 'original',
        rotation: 0,
        adjustments: {},
        ocr:
          n === 1
            ? {
                text: 'HELLO WORLD',
                words: [{ text: 'HELLO', bbox: { x0: 70, y0: 90, x1: 180, y1: 104 } }],
                imageWidth: canvas.width,
                imageHeight: canvas.height,
              }
            : null,
      }));

      const warnings = [];
      const bytes = await pdfs.buildPdf(
        pagesIn,
        {
          pageSize: 'A4',
          quality: 80,
          searchable: true,
          bookmarks: true,
          metadata: true,
          pageNumbers: true,
          watermark: true,
          watermarkText: 'CONFIDENTIAL',
        },
        { renderCanvas: async () => canvas, onWarning: (message) => warnings.push(message) },
      );
      record('pdf export produces bytes', bytes.length > 1000, formatBytes(bytes.length));
      if (warnings.length) record('export warnings', false, warnings.join('; '));

      const parsed = await PDFDocument.load(bytes);
      record('exported PDF re-opens', parsed.getPageCount() === 3, `${parsed.getPageCount()} pages`);

      const catalog = parsed.context.lookup(parsed.context.trailerInfo.Root);
      const outlineRef = catalog.get(PDFName.of('Outlines'));
      const outline = outlineRef ? parsed.context.lookup(outlineRef) : null;
      const first = outline?.get?.(PDFName.of('First'));
      record(
        'outline (bookmarks) written',
        Boolean(outline && first && parsed.context.lookup(first)),
        outline ? `first = ${String(parsed.context.lookup(first)?.get?.(PDFName.of('Title')))}` : 'none',
      );

      // Verify the text layer the way a real reader sees it.
      const reader = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const readerPage = await reader.getPage(1);
      const content = await readerPage.getTextContent();
      const extracted = content.items.map((item) => item.str).join(' ');
      record('searchable text layer readable by PDF.js', extracted.includes('HELLO'), extracted.slice(0, 48));
      record('watermark readable by PDF.js', extracted.includes('CONFIDENTIAL'));
      await reader.destroy();

      const bytes2 = await pdfs.buildPdf(pagesIn, { pageSize: 'A4', layout: '2' }, {
        renderCanvas: async () => canvas,
      });
      const parsed2 = await PDFDocument.load(bytes2);
      record('2-up packs 3 pages onto 2 sheets', parsed2.getPageCount() === 2, `${parsed2.getPageCount()} sheets`);
    } else {
      record('pdf-lib loaded', false, 'not loaded yet');
    }

    if (window.pdfjsLib) {
      record('pdf.js loaded', true, 'ok');
    } else {
      record('pdf.js loaded', false, 'not loaded yet');
    }

    record('IndexedDB reachable', typeof indexedDB !== 'undefined');
    record('offline cache registered', Boolean(navigator.serviceWorker?.controller));
  } catch (error) {
    record('self-test crashed', false, error.message);
  }

  out.textContent = lines.join('\n');
}

export { undo, openExport, openScanner, openCapture, importFiles };
