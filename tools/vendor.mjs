#!/usr/bin/env node
/*
 * Vendor Scanlet's third-party libraries into `vendor/`.
 *
 *   node tools/vendor.mjs                      # everything the app needs
 *   node tools/vendor.mjs --langs eng,ita      # extra OCR languages
 *   node tools/vendor.mjs --with-fallback-core # also the non-SIMD OCR core
 *   node tools/vendor.mjs --check              # verify what is on disk
 *
 * After this, the app makes no third-party request at runtime: it works offline
 * from any static host, from a LAN bridge, or from a USB stick. `vendor/MANIFEST.json`
 * records every source URL and its SHA-256, so an update is reviewable as a diff.
 *
 * The OCR language files are the bulky part (about 11 MB each). Only English is
 * fetched by default; add others with --langs, or just drop the `.traineddata.gz`
 * file into vendor/tessdata/ yourself.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENDOR = path.join(ROOT, 'vendor');

const PDFJS = '3.11.174';
const PDFLIB = '1.17.1';
const TESSERACT = '5.1.1';
const TESSERACT_CORE = '5.1.1';
const JSZIP = '3.10.1';
const QRCODE = '1.4.4';
const TESSDATA = '4.0.0';

const jsdelivr = (pkg) => `https://cdn.jsdelivr.net/npm/${pkg}`;

/** Fixed, single-file items. */
function fixedItems({ fallbackCore }) {
  const items = [
    { dest: 'pdfjs/pdf.min.js', url: jsdelivr(`pdfjs-dist@${PDFJS}/build/pdf.min.js`) },
    { dest: 'pdfjs/pdf.worker.min.js', url: jsdelivr(`pdfjs-dist@${PDFJS}/build/pdf.worker.min.js`) },
    { dest: 'pdf-lib/pdf-lib.min.js', url: jsdelivr(`pdf-lib@${PDFLIB}/dist/pdf-lib.min.js`) },
    { dest: 'jszip/jszip.min.js', url: jsdelivr(`jszip@${JSZIP}/dist/jszip.min.js`) },
    { dest: 'qrcode-generator/qrcode.min.js', url: jsdelivr(`qrcode-generator@${QRCODE}/qrcode.min.js`) },
    { dest: 'tesseract/tesseract.min.js', url: jsdelivr(`tesseract.js@${TESSERACT}/dist/tesseract.min.js`) },
    { dest: 'tesseract/worker.min.js', url: jsdelivr(`tesseract.js@${TESSERACT}/dist/worker.min.js`) },
    {
      dest: 'tesseract/tesseract-core-simd.wasm.js',
      url: jsdelivr(`tesseract.js-core@${TESSERACT_CORE}/tesseract-core-simd.wasm.js`),
    },
  ];
  if (fallbackCore) {
    items.push({
      dest: 'tesseract/tesseract-core.wasm.js',
      url: jsdelivr(`tesseract.js-core@${TESSERACT_CORE}/tesseract-core.wasm.js`),
    });
  }
  return items;
}

/** Directory listings, from jsDelivr's API. */
async function directoryItems(pkg, folder, destPrefix) {
  const response = await fetch(`https://data.jsdelivr.com/v1/packages/npm/${pkg}?structure=flat`);
  if (!response.ok) throw new Error(`Could not list ${pkg}: HTTP ${response.status}`);
  const { files } = await response.json();
  const prefix = `/${folder}/`;
  return files
    .filter((file) => file.name.startsWith(prefix))
    .map((file) => ({
      dest: path.join(destPrefix, file.name.slice(prefix.length)),
      url: jsdelivr(`${pkg}${file.name}`),
      bytes: file.size,
    }));
}

async function download(item) {
  const response = await fetch(item.url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${item.url}`);
  const body = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const target = path.join(VENDOR, item.dest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const changed = !existing || !existing.equals(body);
  if (changed) fs.writeFileSync(target, body);
  return { dest: item.dest, url: item.url, bytes: body.length, sha256, changed };
}

const human = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  const { values } = parseArgs({
    options: {
      langs: { type: 'string', default: 'eng' },
      'with-fallback-core': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
  });

  const manifestPath = path.join(VENDOR, 'MANIFEST.json');
  if (values.check) {
    if (!fs.existsSync(manifestPath)) {
      console.error('No vendor/MANIFEST.json — run `node tools/vendor.mjs` first.');
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let missing = 0;
    let mismatched = 0;
    for (const entry of manifest.files) {
      const target = path.join(VENDOR, entry.dest);
      if (!fs.existsSync(target)) {
        missing++;
        console.log(`  missing   ${entry.dest}`);
        continue;
      }
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      if (sha256 !== entry.sha256) {
        mismatched++;
        console.log(`  altered   ${entry.dest}`);
      }
    }
    const ok = !missing && !mismatched;
    console.log(
      ok
        ? `\nvendor/ matches its manifest (${manifest.files.length} files, ${human(manifest.bytes)})`
        : `\n${missing} missing, ${mismatched} altered`,
    );
    process.exit(ok ? 0 : 1);
  }

  console.log(`vendoring into ${path.relative(process.cwd(), VENDOR)}/`);

  const items = [
    ...fixedItems({ fallbackCore: values['with-fallback-core'] }),
    ...(await directoryItems(`pdfjs-dist@${PDFJS}`, 'standard_fonts', 'pdfjs/standard_fonts')),
    ...(await directoryItems(`pdfjs-dist@${PDFJS}`, 'cmaps', 'pdfjs/cmaps')),
  ];

  const languages = values.langs
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  for (const language of languages) {
    items.push({
      dest: `tessdata/${language}.traineddata.gz`,
      url: `https://tessdata.projectnaptha.com/${TESSDATA}/${language}.traineddata.gz`,
    });
  }

  const files = [];
  let bytes = 0;
  let written = 0;
  for (const item of items) {
    try {
      const record = await download(item);
      files.push(record);
      bytes += record.bytes;
      if (record.changed) written++;
      process.stdout.write(`\r  ${files.length}/${items.length} files · ${human(bytes)}`);
    } catch (error) {
      console.error(`\n  failed: ${item.dest} — ${error.message}`);
      process.exitCode = 1;
    }
  }
  process.stdout.write('\n');

  const manifest = {
    generated: new Date().toISOString(),
    packages: {
      'pdfjs-dist': PDFJS,
      'pdf-lib': PDFLIB,
      'tesseract.js': TESSERACT,
      'tesseract.js-core': TESSERACT_CORE,
      jszip: JSZIP,
      'qrcode-generator': QRCODE,
      tessdata: TESSDATA,
    },
    languages,
    files: files.sort((a, b) => a.dest.localeCompare(b.dest)),
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`  ${files.length} files, ${human(manifest.bytes)} total, ${written} written`);
  console.log(`  manifest: vendor/MANIFEST.json`);
  if (!languages.includes('eng')) {
    console.log('  note: English is not included — OCR will fall back to the CDN.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
