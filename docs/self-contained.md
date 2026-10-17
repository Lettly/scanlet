# Self-contained

Scanlet ships its own copy of every library it uses. At runtime it makes **no
third-party request** — no CDN, no font service, no telemetry, no API. You can serve it
from GitHub Pages, a LAN bridge, a NAS, an intranet, or a USB stick, and pull the
network cable out.

You do not have to take that on trust: **⋮ → About Scanlet → Run diagnostics** ends with
`no third-party requests — all same-origin`, computed from the browser's own resource
timings, plus a HEAD check of every vendored file.

## What is vendored, and what it costs

| | |
|---|---|
| PDF.js (+ worker, CMaps, substitute fonts) | 3.7 MB |
| Tesseract.js (+ worker, SIMD WASM core) | 4.7 MB |
| English trained data | 10.9 MB |
| pdf-lib, JSZip, qrcode-generator | 0.6 MB |
| **Total** | **≈ 19.8 MB, 194 files** |

`vendor/MANIFEST.json` records every source URL, its SHA-256 and the exact package
versions, so a dependency update is reviewable as a diff rather than a leap of faith.

## Updating it

```sh
node tools/vendor.mjs                       # fetch what the app needs
node tools/vendor.mjs --check               # verify vendor/ against the manifest
node tools/vendor.mjs --langs eng,ita,deu   # add OCR languages
node tools/vendor.mjs --with-fallback-core  # also the non-SIMD OCR core
```

`--check` re-hashes every file, so it works as a CI guard against a tampered or
half-committed `vendor/`. Bump a version constant at the top of the script to upgrade a
package; the manifest then shows precisely what changed.

## OCR languages

Only English is vendored by default; the other 16 languages in the picker fetch their
trained data from the public CDN the first time you choose them. Everything else — the
engine, the worker, the WASM core — is always local.

To make another language local too, vendor it and the app will use it automatically:

```sh
node tools/vendor.mjs --langs eng,ita,deu
```

Nothing needs editing: the app reads `vendor/MANIFEST.json` to learn which languages are
on disk, and only reaches for the CDN for the ones that are not.

## What "self-contained" cannot mean here

- **Printer scanning still needs something outside the page.** A browser cannot open a
  socket to a printer. That is the extension (one folder, no server, no dependencies) or
  the bridge (one file, no dependencies). Neither fetches anything at runtime. Every
  other feature — camera, import, OCR, cleaning, PDF assembly — is in the page.
- **The service worker pre-caches about 2 MB** (the app plus the small libraries) and
  lets the large ones — OCR core, trained data, CMaps — arrive on first use of the
  feature that needs them. So the app is *complete* offline, and *fully* offline once you
  have used OCR once.
- **`file://` does not work**, vendored or not: ES modules and service workers need an
  origin. Serve the folder — `python3 -m http.server` is enough.

## A single-file build

If you want one HTML file to carry around, it is possible, but it is strictly worse and
I have not shipped one:

- a service worker cannot be registered from inline or `blob:` code, so you would lose
  the offline shell **and the Android share target**;
- the OCR core and trained data would have to be inlined as base64, roughly doubling
  them, for a file well over 40 MB;
- the manifest and icons would become data URLs, so "Add to Home Screen" loses its icon
  on some platforms.

The vendored folder gives the same offline guarantee with none of those losses. If you
specifically need the single file, `tools/vendor.mjs` plus an inliner over
`assets/js/*.js` is the start of it — say so and I will build it.
