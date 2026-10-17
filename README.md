# Scanlet

**A private document scanner and PDF toolkit that runs entirely in your browser.**
No account, no upload, no server. Scanlet is a static site — drop it on GitHub
Pages and it works.

> Scan it on your phone, tidy it on your laptop, export a searchable PDF. The
> files never leave the device.

---

## What it does

**Capture**

- **Camera** — live preview with automatic page-edge detection, perspective
  correction (draggable corner handles), multi-shot capture and an auto-shoot guide.
- **Import** — images (JPEG, PNG, WebP, GIF, BMP, HEIC where the browser can decode
  it) and PDFs, the latter rendered page by page with PDF.js. Drag and drop anywhere.
- **Network scanners** — real flatbed, ADF and duplex scanning over eSCL/AirScan via
  an optional local bridge (see below). Blank sheets pulled by an ADF are detected
  and dropped automatically.

**Clean up**

- **Enhance** — auto-levels, contrast and saturation in one pass.
- **Grayscale** and **adaptive black & white** — a local-mean threshold that
  survives uneven lighting far better than a global one.
- **Magic** — divides out the local background, flattening shadows and grey casts.
- **Deskew** — estimates skew by maximising the horizontal projection profile.
- **Auto-crop** — trims the uniform paper border.
- Rotate by 90° or by any angle, flip, reorder by drag and drop, duplicate, split a
  document in two, extract pages to a new document. Everything is non-destructive:
  originals are kept, and every step can be reverted or baked in later.

**Recognise**

- OCR with Tesseract.js in 17 language configurations, run page by page in the
  browser.
- The recognised text is embedded as an invisible layer in the exported PDF, so the
  result is searchable and copy-pasteable in any reader — plus plain-text export.

**Assemble a PDF**

- Page sizes A3–A5 / Letter / Legal, or fit-to-content; portrait, landscape or
  automatic per page; configurable margins.
- 1-up, 2-up, 4-up and 2-up landscape book layouts; booklet helper (insert blanks
  for back-to-back printing).
- JPEG or PNG encoding with a quality slider, optional downsampling to a target DPI.
- Searchable text layer, page numbers, diagonal watermark, per-page bookmarks
  (a proper PDF outline), full document metadata (title, author, subject, keywords).
- Three one-click presets: *scanned doc*, *archive*, *smallest*.
- Live size estimate before you build.

**Keep**

- Multiple documents in IndexedDB, autosaved.
- Export a project bundle (`.scanlet.zip`, originals + edit recipes) and reopen it
  later or on another machine.
- Export pages as PNGs in a zip.
- Installable PWA with an offline app shell, plus a light/dark theme.

---

## The honest bit about scanning

A web page cannot open a socket to a printer, and browsers cannot speak mDNS.
That is a platform limit, not a Scanlet one. So there are three ways to get a real
scan in:

| Path | Needs | Works for |
|---|---|---|
| **Camera** | nothing | Anything with a lens — phone, laptop |
| **Import** | the file already exists | Scans pushed to SMB/FTP/email/cloud |
| **Bridge** | one `node` command on your own machine | Flatbed / ADF / duplex pull scanning |

Without the bridge, Scanlet is still a complete scanner-on-your-phone and PDF
workbench. With it, "Scan from a printer" pulls pages straight from any device that
speaks **eSCL** — the driverless protocol behind Apple AirScan, also implemented by
SANE's `escl` backend. No vendor drivers, no SDKs.

---

## Running the bridge (optional, for network scanning)

```sh
node bridge/scanlet-bridge.mjs          # listens on 127.0.0.1:8787
```

Zero dependencies, Node 18+. It discovers scanners over Bonjour
(`_uscan._tcp`, `_uscans._tcp`, `_scanner._tcp`) and exposes a small CORS-enabled
HTTP API on the loopback interface. In Scanlet, open **Scanner → Connect**; your
printers appear in a list. If Bonjour is blocked on your network, type an address
such as `192.168.1.42` and press **Probe**.

```sh
node bridge/scanlet-bridge.mjs --port 9090   # different port
node bridge/scanlet-bridge.mjs --quiet       # no logging
```

The bridge binds to `127.0.0.1` only, talks only to printers on your local network,
and stores nothing. The application itself still runs entirely in the tab.

### Trying it without a printer

```sh
node bridge/test/mock-scanner.mjs --render      # a fake eSCL scanner on :8199
node bridge/scanlet-bridge.mjs                  # then add 127.0.0.1:8199 in the UI
node bridge/test/bridge.test.mjs                # or run the end-to-end test
```

---

## Run it locally

It is a static site — no build step, no bundler, no `node_modules`.

```sh
python3 -m http.server 8899
# then open http://127.0.0.1:8899
```

Open `index.html` directly and most of it works, but the camera and the bridge both
need a real origin, so serve it over HTTP.

## Deploy it

Any static host will do. For GitHub Pages: push this repository, then in
**Settings → Pages** choose **Deploy from a branch → main → / (root)** — that is
exactly how the [live demo](https://lettly.github.io/scanlet/) is published. The
included `.github/workflows/ci.yml` runs the test suite on every push; it does not
need to touch Pages.

Everything is relative-pathed, so it works at `https://user.github.io/scanlet/`
without configuration. No `.nojekyll` processing issues — the repo ships one anyway.

## Test it

```sh
npm test        # bridge + client: discovery, capabilities, multipart scan pages
```

There is also an in-app smoke test: **⋮ → About Scanlet → Run diagnostics** checks
perspective warp, edge detection, adaptive B&W, deskew, border trim, rotation, PDF
export (including outline, text layer, watermark and N-up) and IndexedDB.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘/Ctrl + O` | Import files |
| `⌘/Ctrl + A` | Select all pages |
| `⌘/Ctrl + Z` | Undo |
| `⌘/Ctrl + E` | Export PDF |
| `[` / `]` | Rotate selection left / right |
| `1`–`5` | Original, Enhance, Gray, B&W, Magic |
| `Enter` | Open the selected page in the editor |
| `Delete` | Delete the selection |
| `Esc` | Close the open dialog |

Double-click a page for the corner editor; right-click for the page menu.

---

## How it is put together

```
index.html              app shell + all dialogs
assets/app.css          one stylesheet, CSS custom properties for theming
assets/js/
  main.js               bootstrap: store, UI, service worker
  app.js                controller: views, modals, every user action
  store.js              IndexedDB persistence + in-memory state
  imaging.js            the pipeline: warp, deskew, filters, trim, thumbs
  capture.js            getUserMedia capture + live edge suggestion
  pdfs.js               PDF.js import, pdf-lib export
  ocr.js                Tesseract.js worker pool
  bridge.js             client for the optional local bridge
sw.js                   offline app shell + runtime caching for CDN libraries
bridge/                 the local scanning bridge (Node, no dependencies)
icons/                  generated PNG icons (tools/make_icons.py)
```

A page is two things: the **untouched original blob** in IndexedDB, and a small
**edit recipe** (corners, rotation, filter, adjustments, OCR result) in the document
record. Rendering applies the recipe on the fly; "bake edits" rewrites the original.
That is what makes every operation reversible and the storage cheap.

Rendering a page runs:

```
original → perspective warp → rotation/flip → downscale → enhancement → border trim
```

Third-party libraries are loaded from jsDelivr and cached by the service worker on
first use, so the repository stays small but the app still works offline after the
first visit:

| Library | Used for |
|---|---|
| [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 | rendering imported PDFs |
| [pdf-lib](https://pdf-lib.js.org/) 1.17.1 | writing the exported PDF |
| [Tesseract.js](https://tesseract.projectnaptha.com/) 5.1.1 | OCR |
| [JSZip](https://stuk.github.io/jszip/) 3.10.1 | page and project bundles |

## Privacy

There is no backend, no analytics, no telemetry, and no third-party requests other
than the CDN fetches for the libraries above. Documents, page images and recognised
text live in your browser's IndexedDB until you delete them. The optional bridge is
the only component that touches the network, it runs on your machine, and it talks
only to printers you point it at.

## Limits worth knowing

- **Duplex and ADF come from the device**, through eSCL. Devices that only support
  vendor protocols are out of reach without a driver-based helper.
- **The OCR text layer uses the standard PDF fonts** (WinAnsi), so searchable text is
  written for Latin-script languages. Recognised text in other scripts is still
  exported to `.txt`, but is not embedded invisibly in the PDF.
- **Very large batches** are bounded by browser memory; pages are processed a few at
  a time and originals are kept in IndexedDB, not in memory.
- **No PDF encryption** yet. If you need password-protected output, run the result
  through `qpdf`/`pdftk` afterwards.
- **HEIC** import depends on the browser being able to decode it (Safari can, most
  others cannot).

## Licence

MIT — see [LICENSE](LICENSE).
