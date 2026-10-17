/* Small shared helpers: DOM, formatting, files, async utilities. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'html') node.innerHTML = value;
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  return `${(n / 1000 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export const stripExt = (name) => String(name || '').replace(/\.[a-z0-9]{1,6}$/i, '');

export function safeFilename(name, fallback = 'document') {
  const base = stripExt(name).replace(/[^\w\d \-_.()]+/g, '_').replace(/\s+/g, ' ').trim();
  return base || fallback;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Run `worker` over `items` with a bounded number of concurrent tasks. */
export async function pool(items, limit, worker, onProgress) {
  const queue = items.slice();
  const total = queue.length;
  let done = 0;
  let failure = null;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, total || 1)) }, async () => {
    while (queue.length && !failure) {
      const item = queue.shift();
      const index = total - queue.length - 1;
      try {
        await worker(item, index);
      } catch (err) {
        failure = err;
      }
      done += 1;
      onProgress?.(done, total);
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
}

export function toast(message, { kind = '', timeout = 3600 } = {}) {
  const host = $('#toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${kind}`, role: 'status' }, message);
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, timeout);
}

export function announce(message) {
  const region = $('#live-region');
  if (region) region.textContent = message;
}

export function confirmDialog(message) {
  return window.confirm(message);
}

/** Load an <img> from a Blob/URL and wait for decode. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const img = new Image();
    img.onload = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      reject(new Error('Could not decode this image.'));
    };
    img.src = url;
  });
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image.'))), type, quality);
  });
}

export function blobToArrayBuffer(blob) {
  return blob.arrayBuffer();
}

export function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Read failed'));
    reader.readAsDataURL(blob);
  });
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export const ctx2d = (canvas, options = { willReadFrequently: true }) =>
  canvas.getContext('2d', options);

/** Device pixel ratio aware draw of a bitmap into a canvas. */
export function drawBitmapToCanvas(bitmap, width, height) {
  const canvas = createCanvas(width, height);
  const ctx = ctx2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return undefined;
    called = true;
    return fn(...args);
  };
}
