/* Scanlet — image processing.
 *
 * Everything here is pure canvas / typed-array work: no dependency on the UI.
 * The page pipeline is:
 *
 *   source bitmap → perspective crop → fine rotation → 90° rotation / flip
 *                 → enhancement (preset + manual adjustments) → border trim
 *
 * Pages keep their untouched original, so every step stays reversible.
 */

import { createCanvas, ctx2d, clamp } from './util.js';

/* ─────────────────────────── geometry ─────────────────────────── */

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function gaussSolve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('degenerate transform');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      if (!factor) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}

/** Homography taking the four `from` points to the four `to` points. */
function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = gaussSolve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/* ─────────────────────── perspective correction ─────────────────────── */

/**
 * Warp the quadrilateral `quad` (four {x,y} in source pixels, clockwise from
 * top-left) onto a rectangle. Returns a canvas sized from the quad's edges.
 */
export function warpPerspective(source, quad, { maxEdge = 0 } = {}) {
  const [tl, tr, br, bl] = quad;
  let width = Math.max(40, Math.round(Math.max(distance(tl, tr), distance(bl, br))));
  let height = Math.max(40, Math.round(Math.max(distance(tl, bl), distance(tr, br))));

  const srcCanvas = source instanceof HTMLCanvasElement ? source : bitmapToCanvas(source);
  let scale = 1;
  if (maxEdge > 0) {
    const longest = Math.max(width, height);
    if (longest > maxEdge) scale = maxEdge / longest;
  }

  const outW = Math.max(20, Math.round(width * scale));
  const outH = Math.max(20, Math.round(height * scale));
  const out = createCanvas(outW, outH);
  const outCtx = ctx2d(out);
  const srcCtx = ctx2d(srcCanvas);
  const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  const H = homography(
    [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }],
    [tl, tr, br, bl],
  );

  const dst = outCtx.createImageData(outW, outH);
  const sd = srcData.data;
  const dd = dst.data;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = H;

  for (let y = 0; y < outH; y++) {
    const yRow = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const xCol = x + 0.5;
      const denom = h6 * xCol + h7 * yRow + 1;
      const sx = (h0 * xCol + h1 * yRow + h2) / denom;
      const sy = (h3 * xCol + h4 * yRow + h5) / denom;
      const di = (y * outW + x) * 4;
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) {
        dd[di] = dd[di + 1] = dd[di + 2] = 255;
        dd[di + 3] = 255;
        continue;
      }
      // bilinear sample
      const fx = sx - 0.5;
      const fy = sy - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const dx = fx - x0;
      const dy = fy - y0;
      const x1 = clamp(x0 + 1, 0, sw - 1);
      const y1 = clamp(y0 + 1, 0, sh - 1);
      const cx0 = clamp(x0, 0, sw - 1);
      const cy0 = clamp(y0, 0, sh - 1);
      const i00 = (cy0 * sw + cx0) * 4;
      const i10 = (cy0 * sw + x1) * 4;
      const i01 = (y1 * sw + cx0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - dx) + sd[i10 + c] * dx;
        const bot = sd[i01 + c] * (1 - dx) + sd[i11 + c] * dx;
        dd[di + c] = top * (1 - dy) + bot * dy;
      }
      dd[di + 3] = 255;
    }
  }
  outCtx.putImageData(dst, 0, 0);
  return out;
}

function bitmapToCanvas(bitmap) {
  const canvas = createCanvas(bitmap.width, bitmap.height);
  ctx2d(canvas).drawImage(bitmap, 0, 0);
  return canvas;
}

/* ─────────────────── document edge detection ─────────────────── */

/** Downscale a canvas to at most `max` on its longest edge, returning ImageData. */
export function smallImageData(canvas, max = 420) {
  const scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const small = createCanvas(canvas.width * scale, canvas.height * scale);
  const ctx = ctx2d(small);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return { data: ctx.getImageData(0, 0, small.width, small.height), scale: 1 / scale };
}

function grayFromImageData({ data }) {
  const { width, height } = data;
  const gray = new Uint8ClampedArray(width * height);
  const px = data.data;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  }
  return { gray, width, height };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find the page outline by comparing the picture against its own border colour.
 * Returns four corners in source pixels, or null when nothing page-like is found.
 */
export function detectDocumentCorners(canvas, { sensitivity = 30 } = {}) {
  const small = smallImageData(canvas, 420);
  const { gray, width, height } = grayFromImageData(small);

  // background = median of the outermost ring of pixels
  const ring = [];
  for (let x = 0; x < width; x++) {
    ring.push(gray[x], gray[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y++) {
    ring.push(gray[y * width], gray[y * width + width - 1]);
  }
  const bg = median(ring);

  const mask = new Uint8Array(width * height);
  let hits = 0;
  for (let i = 0; i < gray.length; i++) {
    if (Math.abs(gray[i] - bg) > sensitivity) {
      mask[i] = 1;
      hits++;
    }
  }
  const coverage = hits / (width * height);
  if (coverage < 0.05 || coverage > 0.94) return null;

  // Extreme-point quad: robust for pages that sit tilted on a contrasting surface.
  const corners = { tl: null, tr: null, br: null, bl: null };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const sum = x + y;
      const diff = x - y;
      if (!corners.tl || sum < corners.tl.v) corners.tl = { v: sum, x, y };
      if (!corners.br || sum > corners.br.v) corners.br = { v: sum, x, y };
      if (!corners.tr || diff > corners.tr.v) corners.tr = { v: diff, x, y };
      if (!corners.bl || diff < corners.bl.v) corners.bl = { v: diff, x, y };
    }
  }

  if (!corners.tl || !corners.br || !corners.tr || !corners.bl) return null;

  const scale = small.scale;
  const quad = [corners.tl, corners.tr, corners.br, corners.bl].map((p) => ({
    x: clamp(p.x * scale, 0, canvas.width),
    y: clamp(p.y * scale, 0, canvas.height),
  }));

  const area = quadArea(quad);
  const frame = canvas.width * canvas.height;
  if (area < frame * 0.08 || area > frame * 1.02) return null;
  if (!isConvex(quad)) return null;
  return quad;
}

export function quadArea(quad) {
  let sum = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    const c = quad[(i + 2) % quad.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cross);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export const fullFrameQuad = (canvas) => [
  { x: 0, y: 0 },
  { x: canvas.width, y: 0 },
  { x: canvas.width, y: canvas.height },
  { x: 0, y: canvas.height },
];

/* ─────────────────────── deskew ─────────────────────── */

/**
 * Estimate the skew of a scanned page by maximising the variance of the
 * horizontal projection profile over a range of candidate angles.
 */
export function estimateSkew(canvas, { maxAngle = 8, step = 0.25 } = {}) {
  const small = smallImageData(canvas, 500);
  const { gray, width, height } = grayFromImageData(small);

  // Otsu threshold → ink mask
  const histogram = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * histogram[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }

  const ink = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < threshold) ink.push(x, y);
    }
  }
  if (ink.length < 200) return 0;

  const cx = width / 2;
  const cy = height / 2;
  const bins = height;
  const scores = [];
  for (let angle = -maxAngle; angle <= maxAngle + 1e-9; angle += step) {
    const rad = (angle * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const profile = new Float64Array(bins);
    for (let i = 0; i < ink.length; i += 2) {
      const dx = ink[i] - cx;
      const dy = ink[i + 1] - cy;
      const ry = Math.round(dx * sin + dy * cos + cy);
      if (ry >= 0 && ry < bins) profile[ry]++;
    }
    let mean = 0;
    for (let i = 0; i < bins; i++) mean += profile[i];
    mean /= bins;
    let variance = 0;
    for (let i = 0; i < bins; i++) variance += (profile[i] - mean) ** 2;
    scores.push({ angle, variance });
  }

  scores.sort((a, b) => b.variance - a.variance);
  const winner = scores[0];
  const flat = scores.find((s) => Math.abs(s.angle) < 1e-9);
  if (!winner || Math.abs(winner.angle) < 0.3) return 0;
  // Only accept a genuine peak, not floating-point noise.
  const gain = winner.variance / (flat ? flat.variance : 1);
  if (gain < 1.02) return 0;
  return Number(winner.angle.toFixed(2));
}

/* ─────────────────────── rotation & trim ─────────────────────── */

export function rotate90(canvas, quarterTurns) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (!turns) return canvas;
  const swap = turns % 2 === 1;
  const out = createCanvas(swap ? canvas.height : canvas.width, swap ? canvas.width : canvas.height);
  const ctx = ctx2d(out);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

export function flip(canvas, horizontal = true) {
  const out = createCanvas(canvas.width, canvas.height);
  const ctx = ctx2d(out);
  if (horizontal) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, canvas.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/** Rotate by an arbitrary angle, expanding the canvas to fit. */
export function rotateArbitrary(canvas, degrees) {
  if (!degrees) return canvas;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const w = Math.ceil(canvas.width * cos + canvas.height * sin);
  const h = Math.ceil(canvas.width * sin + canvas.height * cos);
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/** Crop away uniform (paper-coloured) borders, keeping a small margin. */
export function trimBorders(canvas, { padding = 0.012 } = {}) {
  const small = smallImageData(canvas, 600);
  const { gray, width, height } = grayFromImageData(small);
  const ring = [];
  for (let x = 0; x < width; x++) ring.push(gray[x], gray[(height - 1) * width + x]);
  for (let y = 0; y < height; y++) ring.push(gray[y * width], gray[y * width + width - 1]);
  const bg = median(ring);
  const limit = Math.max(24, bg * 0.72);

  const colHits = new Int32Array(width);
  const rowHits = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < limit) {
        colHits[x]++;
        rowHits[y]++;
      }
    }
  }
  const minHits = 1;
  let left = 0;
  while (left < width && colHits[left] <= minHits) left++;
  let right = width - 1;
  while (right > left && colHits[right] <= minHits) right--;
  let top = 0;
  while (top < height && rowHits[top] <= minHits) top++;
  let bottom = height - 1;
  while (bottom > top && rowHits[bottom] <= minHits) bottom--;

  if (right <= left || bottom <= top) return canvas;

  const scale = small.scale;
  const marginX = (right - left) * padding * scale;
  const marginY = (bottom - top) * padding * scale;
  const x = clamp(left * scale - marginX, 0, canvas.width - 2);
  const y = clamp(top * scale - marginY, 0, canvas.height - 2);
  const w = clamp((right - left + 1) * scale + marginX * 2, 10, canvas.width - x);
  const h = clamp((bottom - top + 1) * scale + marginY * 2, 10, canvas.height - y);
  if (w > canvas.width * 0.98 && h > canvas.height * 0.98) return canvas;

  const out = createCanvas(Math.round(w), Math.round(h));
  ctx2d(out).drawImage(canvas, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 0, 0, out.width, out.height);
  return out;
}

/** Fraction of dark pixels — used to spot blank sheets the ADF may have pulled. */
export function inkRatio(canvas) {
  const small = smallImageData(canvas, 240);
  const { gray } = grayFromImageData(small);
  let dark = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] < 200) dark++;
  return dark / gray.length;
}

/* ─────────────────────── enhancement ─────────────────────── */

function integral(gray, width, height) {
  const out = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      out[(y + 1) * (width + 1) + (x + 1)] = out[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  return out;
}

function windowMean(integralImage, width, height, x, y, radius) {
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(width - 1, x + radius);
  const y1 = Math.min(height - 1, y + radius);
  const w = width + 1;
  const sum =
    integralImage[(y1 + 1) * w + (x1 + 1)] -
    integralImage[y0 * w + (x1 + 1)] -
    integralImage[(y1 + 1) * w + x0] +
    integralImage[y0 * w + x0];
  return sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
}

function percentileLevels(gray) {
  const histogram = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  const total = gray.length;
  const lowTarget = total * 0.006;
  const highTarget = total * 0.994;
  let acc = 0;
  let low = 0;
  let high = 255;
  for (let i = 0; i < 256; i++) {
    acc += histogram[i];
    if (acc >= lowTarget) {
      low = i;
      break;
    }
  }
  acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += histogram[i];
    if (acc >= highTarget) {
      high = i;
      break;
    }
  }
  if (high - low < 30) return { low: 0, high: 255 };
  return { low, high };
}

/**
 * Apply an enhancement preset and manual adjustments in a single pass.
 * Returns a new canvas.
 */
export function enhance(
  canvas,
  { filter = 'original', brightness = 0, contrast = 0, saturation = 0 } = {},
) {
  const ctx = ctx2d(canvas);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { width, height } = imageData;
  const px = imageData.data;
  const count = width * height;

  const gray = new Uint8ClampedArray(count);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
  }

  const brightnessShift = (brightness / 100) * 110;
  const contrastFactor =
    contrast === 0 ? 1 : (259 * (contrast * 1.6 + 255)) / (255 * (259 - contrast * 1.6));
  const satFactor = 1 + saturation / 100;

  if (filter === 'bw') {
    const integ = integral(gray, width, height);
    const radius = Math.max(8, Math.round(Math.min(width, height) / 14));
    const k = 0.12 - (contrast / 100) * 0.08 + (brightness / 100) * 0.06;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const mean = windowMean(integ, width, height, x, y, radius);
        const value = gray[i] < mean * (1 - k) ? 0 : 255;
        const di = i * 4;
        px[di] = px[di + 1] = px[di + 2] = value;
      }
    }
  } else if (filter === 'magic') {
    const integ = integral(gray, width, height);
    const radius = Math.max(12, Math.round(Math.min(width, height) / 9));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const bg = Math.max(1, windowMean(integ, width, height, x, y, radius));
        const gain = clamp(242 / bg, 0.85, 2.6);
        const di = i * 4;
        for (let c = 0; c < 3; c++) px[di + c] = clamp(px[di + c] * gain, 0, 255);
      }
    }
  }

  const isGray = filter === 'gray' || filter === 'bw';
  const levels = filter === 'enhance' ? percentileLevels(gray) : null;
  const span = levels ? Math.max(20, levels.high - levels.low) : 0;

  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    let r = px[i];
    let g = px[i + 1];
    let b = px[i + 2];

    if (levels) {
      r = ((r - levels.low) / span) * 255;
      g = ((g - levels.low) / span) * 255;
      b = ((b - levels.low) / span) * 255;
    }

    if (isGray || filter === 'bw') {
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      r = g = b = luma;
    }

    r = contrastFactor * (r - 128) + 128 + brightnessShift;
    g = contrastFactor * (g - 128) + 128 + brightnessShift;
    b = contrastFactor * (b - 128) + 128 + brightnessShift;

    if (satFactor !== 1 && !isGray && filter !== 'bw') {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * satFactor;
      g = luma + (g - luma) * satFactor;
      b = luma + (b - luma) * satFactor;
    }

    px[i] = clamp(r, 0, 255);
    px[i + 1] = clamp(g, 0, 255);
    px[i + 2] = clamp(b, 0, 255);
  }

  const out = createCanvas(width, height);
  ctx2d(out).putImageData(imageData, 0, 0);
  return out;
}

/* ─────────────────────── downscale & thumbs ─────────────────────── */

export function fitCanvas(canvas, maxEdge) {
  if (!maxEdge || Math.max(canvas.width, canvas.height) <= maxEdge) return canvas;
  const scale = maxEdge / Math.max(canvas.width, canvas.height);
  const out = createCanvas(canvas.width * scale, canvas.height * scale);
  const ctx = ctx2d(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

export function thumbnail(canvas, maxEdge = 340, quality = 0.7) {
  const small = fitCanvas(canvas, maxEdge);
  return small.toDataURL('image/jpeg', quality);
}

/* ─────────────────────── page rendering ─────────────────────── */

/**
 * Run the full pipeline for one page record and return a canvas.
 * `source` is the untouched original canvas/bitmap.
 */
export function renderPage(source, page, { maxEdge = 0, trim = false } = {}) {
  const base = source instanceof HTMLCanvasElement ? source : bitmapToCanvas(source);
  let canvas = base;

  const { crop, rotation = 0, flipH = false, filter = 'original', adjustments = {} } = page;

  if (crop && crop.applied && Array.isArray(crop.quad)) {
    canvas = warpPerspective(canvas, crop.quad);
  }

  if (rotation % 90 === 0 && rotation !== 0) {
    canvas = rotate90(canvas, rotation / 90);
    if (flipH) canvas = flip(canvas, true);
  } else {
    if (flipH) canvas = flip(canvas, true);
    if (rotation) canvas = rotateArbitrary(canvas, rotation);
  }

  if (maxEdge) canvas = fitCanvas(canvas, maxEdge);

  if (filter !== 'original' || adjustments.brightness || adjustments.contrast || adjustments.saturation) {
    canvas = enhance(canvas, { filter, ...adjustments });
  }

  if (trim || adjustments.autoCrop) canvas = trimBorders(canvas);
  return canvas;
}
