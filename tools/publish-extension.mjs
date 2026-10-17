#!/usr/bin/env node
/*
 * Publish the packaged extension to the Chrome Web Store.
 *
 *   node tools/publish-extension.mjs                # build, upload, submit for review
 *   node tools/publish-extension.mjs --dry-run      # build and print, touch no network
 *   node tools/publish-extension.mjs --upload-only  # upload, do not submit
 *   node tools/publish-extension.mjs --zip dist/x.zip
 *
 * Credentials come from the environment — GitHub Actions secrets in CI, your
 * shell locally:
 *
 *   CWS_PUBLISHER_ID  CWS_EXTENSION_ID
 *   CWS_CLIENT_ID     CWS_CLIENT_SECRET     CWS_REFRESH_TOKEN
 *
 * They are the OAuth client and refresh token from the Chrome Web Store API
 * setup; extension/STORE.md has the steps. No dependencies — the OAuth refresh
 * and the API v2 calls are plain `fetch`, like the rest of the project.
 *
 * The store can only *update* an item that already exists, so the very first
 * upload is done once in the developer dashboard. After that this tool owns it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

const API = 'https://chromewebstore.googleapis.com';
const UPLOAD_API = 'https://chromewebstore.googleapis.com/upload';

const log = (message) => console.log(`[publish] ${message}`);

/** The version a release tag names, e.g. `extension-v1.2.3` → `1.2.3`. */
export function versionFromTag(tag) {
  return /^extension-v(\d+(?:\.\d+){0,3})$/.exec(String(tag || ''))?.[1] || null;
}

function readManifest() {
  const file = path.join(EXT, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('no extension/manifest.json to publish');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The package for `version`, building it first if it is not already there. */
function ensureZip(version, explicit) {
  const target = explicit
    ? path.resolve(explicit)
    : path.join(DIST, `scanlet-extension-${version}.zip`);
  if (!fs.existsSync(target)) {
    log('building the extension package…');
    const built = spawnSync(process.execPath, [path.join(HERE, 'build-extension.mjs')], {
      stdio: 'inherit',
    });
    if (built.status !== 0) throw new Error('build-extension.mjs failed — refusing to publish');
  }
  if (!fs.existsSync(target)) throw new Error(`no package to publish at ${target}`);
  return target;
}

function requireCredentials() {
  const names = [
    'CWS_PUBLISHER_ID',
    'CWS_EXTENSION_ID',
    'CWS_CLIENT_ID',
    'CWS_CLIENT_SECRET',
    'CWS_REFRESH_TOKEN',
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(', ')} — these are the Chrome Web Store API secrets; ` +
        'see extension/STORE.md for how to obtain them',
    );
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

/* ─────────────────────────── the Chrome Web Store API ─────────────────────────── */

const errorText = (body, status) =>
  body?.error?.message || body?.error_description || body?.error || `HTTP ${status}`;

/** Exchange the refresh token for a short-lived access token. */
async function accessToken({ clientId, clientSecret, refreshToken }) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`could not get an access token: ${errorText(body, response.status)}`);
  }
  return body.access_token;
}

/** Upload the package. Returns `{ uploadState, crxVersion }`. */
async function upload(name, zipPath, token) {
  const data = fs.readFileSync(zipPath);
  log(`uploading ${path.basename(zipPath)} (${(data.length / 1024).toFixed(1)} kB)…`);
  const response = await fetch(`${UPLOAD_API}/v2/${name}:upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
    body: data,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`upload rejected: ${errorText(body, response.status)}`);
  return body;
}

/** The item's current state, including the last async upload state. */
async function fetchStatus(name, token) {
  const response = await fetch(`${API}/v2/${name}:fetchStatus`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`could not read item status: ${errorText(body, response.status)}`);
  return body;
}

/** An upload that reports IN_PROGRESS settles asynchronously; poll until it does. */
async function waitForUpload(name, token, { attempts = 20, delay = 3000 } = {}) {
  let status = await fetchStatus(name, token);
  for (let i = 0; i < attempts && status.lastAsyncUploadState === 'IN_PROGRESS'; i++) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    status = await fetchStatus(name, token);
  }
  return status;
}

/** Submit the uploaded revision. */
async function publish(name, token) {
  const response = await fetch(`${API}/v2/${name}:publish`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ blockOnWarnings: false }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`publish rejected: ${errorText(body, response.status)}`);
  return body;
}

/* ─────────────────────────── main ─────────────────────────── */

async function main() {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'upload-only': { type: 'boolean', default: false },
      zip: { type: 'string', default: '' },
    },
  });

  const manifest = readManifest();
  const version = manifest.version;

  // A release tag must name the version being shipped, so a forgotten bump
  // cannot quietly re-publish the previous one.
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME || '' : '';
  const tagged = versionFromTag(tag);
  if (tagged && tagged !== version) {
    throw new Error(`tag ${tag} names ${tagged}, but the manifest says ${version} — bump it first`);
  }

  const zipPath = ensureZip(version, values.zip);
  log(`Scanlet extension ${version}`);
  log(`package ${path.relative(ROOT, zipPath)}`);

  const uploadOnly = values['upload-only'] || process.env.CWS_UPLOAD_ONLY === 'true';
  if (values['dry-run']) {
    log(`dry run: ${uploadOnly ? 'would upload' : 'would upload and publish'}, nothing sent`);
    return;
  }

  const env = requireCredentials();
  const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
  const token = await accessToken({
    clientId: env.CWS_CLIENT_ID,
    clientSecret: env.CWS_CLIENT_SECRET,
    refreshToken: env.CWS_REFRESH_TOKEN,
  });

  const uploaded = await upload(name, zipPath, token);
  log(`upload: ${uploaded.uploadState || 'unknown'}${uploaded.crxVersion ? ` (v${uploaded.crxVersion})` : ''}`);
  if (uploaded.uploadState === 'FAILED' || uploaded.uploadState === 'NOT_FOUND') {
    throw new Error('the store rejected the package');
  }
  if (uploaded.uploadState === 'IN_PROGRESS') {
    const settled = await waitForUpload(name, token);
    log(`upload: ${settled.lastAsyncUploadState || 'unknown'}`);
    if (settled.lastAsyncUploadState !== 'SUCCEEDED') {
      throw new Error(`the upload did not succeed (${settled.lastAsyncUploadState || 'unknown'})`);
    }
  }

  if (uploadOnly) {
    log('uploaded; not submitted for review');
    return;
  }

  const result = await publish(name, token);
  log(`submitted for review: ${result.state || 'OK'}`);
  for (const warning of result.warningInfo?.warnings || []) {
    log(`  warning ${warning.reason}: ${warning.description}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[publish] ${error.message}`);
    process.exit(1);
  });
}
