/* Scanlet — the app side of the share target.
 *
 * On Android, Scanlet can appear in any app's share sheet. The browser POSTs the
 * shared files to the service worker (see sw.js, which owns the write side of
 * this contract); the worker stashes them and sends the browser here with
 * `?shared=<id>`. This module reads that stash and hands the files to the
 * importer, which already knows what to do with images and PDFs.
 *
 * Safari does not implement share targets, so on iOS none of this ever runs —
 * there, use Import, the camera, or a Shortcut against the bridge.
 */

const SHARE_CACHE = 'scanlet-share';

/** Must resolve exactly like the key sw.js writes. */
const shareKey = (path) => new URL(`./__shared/${path}`, document.baseURI).toString();

/** The share id in the current URL, if we were opened by a share. */
export function sharedIdFromUrl(search = location.search) {
  const params = new URLSearchParams(search);
  return params.get('shared') || params.get('share') || '';
}

export const shareFailedFromUrl = (search = location.search) =>
  new URLSearchParams(search).get('share') === 'unreadable';

/**
 * Read a stashed share and remove it, so a reload cannot import it twice.
 * @returns {Promise<{files: File[], text: string, url: string}|null>}
 */
export async function takeSharedPayload(id) {
  if (!id || typeof caches === 'undefined') return null;
  const cache = await caches.open(SHARE_CACHE);
  const manifestResponse = await cache.match(shareKey(id));
  if (!manifestResponse) return null;

  let manifest = {};
  try {
    manifest = await manifestResponse.json();
  } catch {
    manifest = {};
  }

  const files = [];
  for (const [index, meta] of (manifest.files || []).entries()) {
    // eslint-disable-next-line no-await-in-loop
    const response = await cache.match(shareKey(`${id}/${index}`));
    if (!response) continue;
    // eslint-disable-next-line no-await-in-loop
    const blob = await response.blob();
    const name = meta.name || `shared-${index + 1}`;
    files.push(new File([blob], name, { type: meta.type || blob.type || 'application/octet-stream' }));
  }

  await Promise.all([
    cache.delete(shareKey(id)),
    ...(manifest.files || []).map((_, index) => cache.delete(shareKey(`${id}/${index}`))),
  ]);

  return { files, text: manifest.text || '', url: manifest.url || '' };
}

/** The first http(s) address in a shared text or url, if there is one. */
export function linkFromShare(text, url) {
  for (const candidate of [url, text]) {
    const match = /https?:\/\/[^\s"'<>]+/i.exec(String(candidate || ''));
    if (match) return match[0];
  }
  return '';
}

/** Turn a shared link into a File, so the ordinary importer can take over. */
export async function fileFromLink(link) {
  const response = await fetch(link, { mode: 'cors' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const blob = await response.blob();
  const name = decodeURIComponent(new URL(link).pathname.split('/').pop() || 'shared') || 'shared';
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}
