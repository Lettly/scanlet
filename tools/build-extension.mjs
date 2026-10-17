#!/usr/bin/env node
/*
 * Package the extension for a store submission.
 *
 *   node tools/build-extension.mjs            # validate, then write the zip
 *   node tools/build-extension.mjs --check    # validate only (for CI)
 *
 * The zip contains only what the extension needs at runtime — no README, no
 * tests, no listing assets. The checks are the ones a reviewer makes: Manifest
 * V3, a complete manifest, an icon at the size the store requires, no remotely
 * hosted code, and a permission list short enough to justify.
 *
 * Written with no dependencies, like the rest of the project: the zip is
 * assembled here rather than shelling out to `zip`.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

/** Everything the extension needs at runtime. */
const INCLUDED = ['manifest.json', 'options.html', 'icon-128.png'];
const INCLUDED_DIRS = ['src'];

const problems = [];
const warnings = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

/* ─────────────────────────── validation ─────────────────────────── */

function pngSize(file) {
  const header = fs.readFileSync(file).subarray(0, 24);
  if (header.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) fail(`manifest_version must be 3, not ${manifest.manifest_version}`);
  if (!manifest.name) fail('manifest has no name');
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) fail(`version "${manifest.version}" is not x.y.z`);
  if (!manifest.description) fail('manifest has no description');
  else if (manifest.description.length > 132) fail(`description is ${manifest.description.length} chars, the limit is 132`);
  if (manifest.name && manifest.name.length > 75) warn(`name is ${manifest.name.length} chars; the store listing name is capped at 45`);

  // Icons: the store wants a 128, and it has to actually be 128.
  const icon = manifest.icons?.['128'];
  if (!icon) fail('no 128x128 icon declared');
  else if (!fs.existsSync(path.join(EXT, icon))) fail(`icon ${icon} is missing`);
  else {
    const size = pngSize(path.join(EXT, icon));
    if (!size) fail(`${icon} is not a PNG`);
    else if (size.width !== 128 || size.height !== 128) fail(`${icon} is ${size.width}x${size.height}, expected 128x128`);
  }

  if (manifest.background?.service_worker) {
    if (!fs.existsSync(path.join(EXT, manifest.background.service_worker))) {
      fail(`service worker ${manifest.background.service_worker} is missing`);
    }
    if (manifest.background.type !== 'module') {
      warn('the service worker is not type: module, but it uses import statements');
    }
  } else {
    fail('no background.service_worker — MV3 requires one');
  }

  if (!manifest.content_scripts?.length) fail('no content_scripts: the page could never talk to the worker');
  for (const entry of manifest.content_scripts) {
    for (const file of entry.js || []) {
      if (!fs.existsSync(path.join(EXT, file))) fail(`content script ${file} is missing`);
    }
    for (const pattern of entry.matches || []) {
      if (pattern === '<all_urls>' || pattern === 'http://*/*' || pattern === 'https://*/*') {
        warn(`content_scripts match ${pattern} — a reviewer will ask why it runs everywhere`);
      } else if (/^[a-z]+:\/\/\*/.test(pattern)) {
        warn(`content_scripts match ${pattern} — a wildcard host runs on any site with that path`);
      }
    }
  }

  if (manifest.options_page && !fs.existsSync(path.join(EXT, manifest.options_page))) {
    fail(`options_page ${manifest.options_page} is missing`);
  }

  const required = ['storage'];
  for (const permission of manifest.permissions || []) {
    if (!required.includes(permission) && permission !== 'scripting') {
      warn(`permission "${permission}" needs a justification in the listing`);
    }
  }
  for (const permission of manifest.optional_host_permissions || []) {
    if (permission === '<all_urls>') warn('optional_host_permissions includes <all_urls>; narrower is easier to review');
  }
}

/** Manifest V3 forbids remotely hosted code, and reviewers scan for it. */
function scanForRemoteCode(files) {
  const offenders = [];
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(EXT, file), 'utf8');

    if (/\beval\s*\(/.test(source)) offenders.push(`${file}: uses eval()`);
    if (/new\s+Function\s*\(/.test(source)) offenders.push(`${file}: uses new Function()`);
    if (/import\s*\(\s*['"`]https?:/.test(source)) offenders.push(`${file}: dynamically imports a remote module`);
    if (/fetch\s*\(\s*['"`]https?:/.test(source)) offenders.push(`${file}: fetches a hard-coded remote URL`);
    if (/<script[^>]+src\s*=\s*['"`]https?:/i.test(source)) offenders.push(`${file}: includes a remote script`);
  }
  return offenders;
}

/* ─────────────────────────── zip ─────────────────────────── */

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

/** A minimal, well-formed zip: deflated entries, no zip64, no data descriptors. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x2821, 12); // date: 2000-01-01, for reproducible builds
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(useDeflate ? 8 : 0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x2821, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ─────────────────────────── main ─────────────────────────── */

const collect = () => {
  const files = [];
  for (const name of INCLUDED) {
    if (fs.existsSync(path.join(EXT, name))) files.push(name);
    else fail(`missing required file: ${name}`);
  }
  for (const dir of INCLUDED_DIRS) {
    const walk = (relative) => {
      for (const entry of fs.readdirSync(path.join(EXT, relative), { withFileTypes: true })) {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) walk(child);
        else files.push(child);
      }
    };
    if (fs.existsSync(path.join(EXT, dir))) walk(dir);
    else fail(`missing required directory: ${dir}`);
  }
  return files.sort();
};

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('No extension/manifest.json');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const files = collect();

  validateManifest(manifest);
  for (const offender of scanForRemoteCode(files)) fail(offender);

  // Listing copy lives with the listing, but the values must agree.
  const store = fs.existsSync(path.join(EXT, 'STORE.md'))
    ? fs.readFileSync(path.join(EXT, 'STORE.md'), 'utf8')
    : '';
  if (!store) warn('extension/STORE.md is missing — the listing copy and justifications live there');
  if (!fs.existsSync(path.join(EXT, 'privacy.html'))) warn('extension/privacy.html is missing — the store asks for a policy URL');

  console.log(`Scanlet extension ${manifest.version}`);
  console.log(`  name        ${manifest.name}`);
  console.log(`  description ${manifest.description}`);
  console.log(`  permissions ${(manifest.permissions || []).join(', ') || 'none'}`);
  console.log(`  optional    ${(manifest.optional_host_permissions || []).join(', ') || 'none'}`);
  console.log(`  matches     ${(manifest.content_scripts || []).flatMap((entry) => entry.matches).join(', ')}`);
  console.log('');

  for (const file of files) {
    const size = fs.statSync(path.join(EXT, file)).size;
    console.log(`  ${String(size).padStart(7)}  ${file}`);
  }
  console.log('');

  if (warnings.length) {
    console.log('Warnings');
    for (const message of warnings) console.log(`  ! ${message}`);
    console.log('');
  }

  if (problems.length) {
    console.log('Problems');
    for (const message of problems) console.log(`  ✗ ${message}`);
    process.exit(1);
  }

  console.log('✓ manifest, icons, no remote code, no missing files');
  if (values.check) {
    console.log('  (--check: no zip written)');
    return;
  }

  const entries = files.map((name) => ({ name, data: fs.readFileSync(path.join(EXT, name)) }));
  const zip = buildZip(entries);
  fs.mkdirSync(DIST, { recursive: true });
  const target = path.join(DIST, `scanlet-extension-${manifest.version}.zip`);
  fs.writeFileSync(target, zip);

  console.log('');
  console.log(`  ${path.relative(ROOT, target)}  ${(zip.length / 1024).toFixed(1)} kB`);
  console.log('  Upload that file: Chrome Web Store → Developer Dashboard → New item,');
  console.log('  or Microsoft Partner Center → Edge → Extensions → New extension.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
