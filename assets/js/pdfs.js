/* Scanlet — PDF in and out.
 *
 * Import renders pages with PDF.js; export assembles pages with pdf-lib,
 * including a hidden OCR text layer, page numbers, watermarks, N-up layouts,
 * metadata and an outline.
 */

import { createCanvas, ctx2d, canvasToBlob, clamp, safeFilename } from './util.js';

export const PDFJS_VERSION = '3.11.174';
export const PDFLIB_VERSION = '1.17.1';
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;

let workerConfigured = false;
function pdfjs() {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('The PDF reader is still loading — try again in a moment.');
  if (!workerConfigured) {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    workerConfigured = true;
  }
  return lib;
}

function pdfLib() {
  const lib = window.PDFLib;
  if (!lib) throw new Error('The PDF writer is still loading — try again in a moment.');
  return lib;
}

export const pdfEnginesReady = () => Boolean(window.pdfjsLib && window.PDFLib);

/* ─────────────────────────── import ─────────────────────────── */

export async function importPdfFile(file, { onProgress, targetMaxEdge = 2400 } = {}) {
  const lib = pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await lib.getDocument({ data, isEvalSupported: false }).promise;
  const out = [];
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = clamp(targetMaxEdge / Math.max(base.width, base.height), 0.5, 4);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = ctx2d(canvas);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
      out.push({ canvas, blob, width: canvas.width, height: canvas.height });
      onProgress?.(number, pdf.numPages);
    }
  } finally {
    pdf.destroy?.();
  }
  return out;
}

/* ─────────────────────────── page geometry ─────────────────────────── */

const MM = 72 / 25.4;
export const SHEET_SIZES = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
};

const mmToPt = (mm) => mm * MM;

/* ─────────────────────────── text helpers ─────────────────────────── */

/** Keep only characters the standard PDF fonts can encode. */
function encodable(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\u0000-\u00FF]/g, ' ');
}

/* ─────────────────────────── export ─────────────────────────── */

export const DEFAULT_EXPORT = {
  layout: '1',
  pageSize: 'A4',
  orientation: 'auto',
  margin: 0,
  quality: 82,
  imageFormat: 'image/jpeg',
  maxDpi: 300,
  searchable: true,
  pageNumbers: false,
  watermark: false,
  watermarkText: 'CONFIDENTIAL',
  bookmarks: true,
  metadata: true,
  back2back: false,
  title: '',
  author: '',
  subject: '',
  keywords: '',
};

/**
 * Build the PDF.
 * @param {Array} pages        page records from the document
 * @param {object} options     export options (see DEFAULT_EXPORT)
 * @param {(page:object)=>Promise<HTMLCanvasElement>} renderCanvas
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf(pages, options, { renderCanvas, onProgress, onWarning } = {}) {
  const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFArray, PDFNumber, PDFString, PDFDict } =
    pdfLib();
  const opts = { ...DEFAULT_EXPORT, ...options };
  const doc = await PDFDocument.create();

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const marginPt = mmToPt(opts.margin);
  const layout = String(opts.layout);
  const columns = layout === '2' || layout === '2l' ? 2 : layout === '4' ? 2 : 1;
  const rows = layout === '4' ? 2 : 1;
  const perSheet = columns * rows;

  // Group source pages into sheets.
  const sheets = [];
  for (let i = 0; i < pages.length; i += perSheet) sheets.push(pages.slice(i, i + perSheet));
  if (!sheets.length) sheets.push([]);

  const outlineEntries = [];
  let sheetNumber = 0;

  for (const group of sheets) {
    sheetNumber++;
    // Rendered bitmaps for this sheet, with their aspect ratios.
    const rendered = [];
    for (const page of group) {
      // eslint-disable-next-line no-await-in-loop
      const canvas = await renderCanvas(page);
      rendered.push(canvas);
    }

    const aspect = rendered.length ? rendered[0].width / rendered[0].height : 1;

    let [sheetW, sheetH] = sheetDimensions(opts, rendered, columns, rows);
    const landscapeWanted =
      opts.orientation === 'landscape' ||
      (opts.orientation === 'auto' && columns === 1 && aspect > 1.02) ||
      layout === '2l';
    if (landscapeWanted && sheetH > sheetW) [sheetW, sheetH] = [sheetH, sheetW];
    if (opts.orientation === 'portrait' && sheetW > sheetH) [sheetW, sheetH] = [sheetH, sheetW];

    const page = doc.addPage([sheetW, sheetH]);
    const contentW = sheetW - marginPt * 2;
    const contentH = sheetH - marginPt * 2;
    const cellW = contentW / columns;
    const cellH = contentH / rows;

    for (let index = 0; index < rendered.length; index++) {
      const canvas = rendered[index];
      const col = columns === 2 && layout === '2l' ? index : index % columns;
      const row = layout === '2l' ? 0 : Math.floor(index / columns);
      const cellX = marginPt + col * cellW;
      const cellY = marginPt + (rows - 1 - row) * cellH;

      const scale = Math.min(cellW / canvas.width, cellH / canvas.height);
      const drawW = canvas.width * scale;
      const drawH = canvas.height * scale;
      const x = cellX + (cellW - drawW) / 2;
      const y = cellY + (cellH - drawH) / 2;

      // eslint-disable-next-line no-await-in-loop
      const image = await embedCanvas(doc, canvas, opts);
      page.drawImage(image, { x, y, width: drawW, height: drawH });

      if (opts.searchable && group[index]?.ocr) {
        drawTextLayer(page, group[index].ocr, { x, y, width: drawW, height: drawH, font });
      }
    }

    if (group[0]) outlineEntries.push({ title: `Page ${sheetNumber}`, ref: page.ref });

    if (opts.watermark && opts.watermarkText) {
      page.drawText(encodable(opts.watermarkText), {
        x: sheetW * 0.1,
        y: sheetH * 0.24,
        size: Math.min(sheetW, sheetH) * 0.14,
        font: bold,
        color: rgb(0.45, 0.45, 0.5),
        opacity: 0.16,
        rotate: degrees(Math.atan2(sheetH * 0.35, sheetW * 0.8) * (180 / Math.PI)),
      });
    }

    if (opts.pageNumbers) {
      const label = String(sheetNumber);
      const size = 9;
      const textWidth = font.widthOfTextAtSize(label, size);
      page.drawText(label, {
        x: (sheetW - textWidth) / 2,
        y: Math.max(8, marginPt / 2),
        size,
        font,
        color: rgb(0.35, 0.35, 0.4),
      });
    }

    onProgress?.(sheetNumber, sheets.length);

    if (opts.back2back) {
      doc.addPage([sheetW, sheetH]);
    }
  }

  if (opts.metadata) {
    const title = opts.title || 'Scan';
    doc.setTitle(title);
    doc.setAuthor(opts.author || '');
    doc.setSubject(opts.subject || '');
    doc.setKeywords(String(opts.keywords || '').split(',').map((k) => k.trim()).filter(Boolean));
    doc.setProducer('Scanlet');
    doc.setCreator('Scanlet');
    doc.setCreationDate(new Date());
    doc.setModificationDate(new Date());
  }

  if (opts.bookmarks && outlineEntries.length) {
    try {
      writeOutline(doc, outlineEntries, { PDFName, PDFArray, PDFNumber, PDFString, PDFDict });
    } catch (error) {
      /* an outline is a nicety — never fail the export over it */
      onWarning?.(`outline skipped: ${error.message}`);
    }
  }

  return doc.save({ useObjectStreams: true });
}

function sheetDimensions(opts, rendered, columns, rows) {
  if (opts.pageSize !== 'fit' && SHEET_SIZES[opts.pageSize]) return [...SHEET_SIZES[opts.pageSize]];
  const assumedDpi = Number(opts.maxDpi) || 200;
  const first = rendered[0];
  const w = first ? (first.width * 72) / assumedDpi : SHEET_SIZES.A4[0];
  const h = first ? (first.height * 72) / assumedDpi : SHEET_SIZES.A4[1];
  return [w * columns, h * rows];
}

async function embedCanvas(doc, canvas, opts) {
  const type = opts.imageFormat === 'image/png' ? 'image/png' : 'image/jpeg';
  const quality = clamp(Number(opts.quality) / 100, 0.2, 1);
  const blob = await canvasToBlob(canvas, type, quality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return type === 'image/png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

/** Draw the invisible OCR text so the PDF is searchable and selectable. */
function drawTextLayer(page, ocr, { x, y, width, height, font }) {
  if (!ocr?.words?.length || !ocr.imageWidth || !ocr.imageHeight) return;
  const sx = width / ocr.imageWidth;
  const sy = height / ocr.imageHeight;

  for (const word of ocr.words) {
    const { x0, y0, x1, y1 } = word.bbox || {};
    if (x0 === undefined) continue;
    const text = encodable(word.text);
    if (!text.trim()) continue;
    const size = clamp((y1 - y0) * sy * 0.86, 2, 200);
    const px = x + x0 * sx;
    const py = y + height - y1 * sy;
    try {
      page.drawText(text, { x: px, y: py, size, font, opacity: 0 });
    } catch {
      /* a single unencodable word should not abort the page */
    }
  }
}

/** Add a flat outline: one entry per sheet, all children of the root. */
function writeOutline(doc, entries, { PDFName, PDFArray, PDFNumber, PDFString, PDFDict }) {
  const context = doc.context;
  const rootRef = context.nextRef();
  const itemRefs = entries.map(() => context.nextRef());

  entries.forEach((entry, index) => {
    const item = PDFDict.withContext(context);
    item.set(PDFName.of('Title'), PDFString.of(entry.title));
    item.set(PDFName.of('Parent'), rootRef);
    if (index > 0) item.set(PDFName.of('Prev'), itemRefs[index - 1]);
    if (index < entries.length - 1) item.set(PDFName.of('Next'), itemRefs[index + 1]);
    const dest = PDFArray.withContext(context);
    dest.push(entry.ref);
    dest.push(PDFName.of('Fit'));
    item.set(PDFName.of('Dest'), dest);
    context.assign(itemRefs[index], item);
  });

  const root = PDFDict.withContext(context);
  root.set(PDFName.of('Type'), PDFName.of('Outlines'));
  root.set(PDFName.of('First'), itemRefs[0]);
  root.set(PDFName.of('Last'), itemRefs[itemRefs.length - 1]);
  root.set(PDFName.of('Count'), PDFNumber.of(entries.length));
  context.assign(rootRef, root);

  const catalog = doc.context.lookup(doc.context.trailerInfo.Root);
  catalog.set(PDFName.of('Outlines'), rootRef);
}

/* ─────────────────────────── naming ─────────────────────────── */

export function exportName(doc, options) {
  return `${safeFilename(options?.title || doc.name || 'scan', 'scan')}.pdf`;
}
