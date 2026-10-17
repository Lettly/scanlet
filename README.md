# Scanlet

**A private document scanner and PDF toolkit that runs entirely in your browser.**
No account, no upload, no server holding your documents. Scanlet is a static site —
host it on GitHub Pages and it works everywhere, including on a phone.

> Scan it on your phone, tidy it on your laptop, export a searchable PDF. The
> documents never leave your devices.

---

## What it does

**Capture**

- **Camera** — live preview with automatic page-edge detection, perspective
  correction (draggable corner handles), multi-shot capture and an auto-shoot guide.
- **Import** — images (JPEG, PNG, WebP, GIF, BMP, HEIC where the browser can decode
  it) and PDFs, the latter rendered page by page with PDF.js. Drag and drop anywhere.
- **Network scanners** — flatbed, ADF and duplex pull scanning over eSCL/AirScan,
  either through the **browser extension** (no server) or the **bridge** (works on
  every browser, and can serve Scanlet to your phone). Blank sheets pulled by an ADF
  are detected and dropped automatically.

**Clean up**

- **Enhance** — auto-levels, contrast and saturation in one pass.
- **Grayscale** and **adaptive black & white** — a local-mean threshold that survives
  uneven lighting far better than a global one.
- **Magic** — divides out the local background, flattening shadows and grey casts.
- **Deskew** — estimates skew by maximising the horizontal projection profile.
- **Auto-crop** — trims the uniform paper border.
- Rotate by 90° or any angle, flip, reorder by drag and drop, duplicate, split a
  document in two, extract pages to a new one. Nothing is destructive: originals are
  kept, and every step can be reverted or baked in later.

**Recognise**

- OCR with Tesseract.js in 17 language configurations, run page by page in the browser.
- The recognised text is embedded as an invisible layer in the exported PDF, so the
  result is searchable and copy-pasteable in any reader — plus plain-text export.

**Assemble a PDF**

- Page sizes A3–A5 / Letter / Legal, or fit-to-content; portrait, landscape or
  automatic per page; configurable margins.
- 1-up, 2-up, 4-up and 2-up landscape book layouts; booklet helper for back-to-back
  printing.
- JPEG or PNG encoding with a quality slider, and optional downsampling to a target DPI.
- Searchable text layer, page numbers, diagonal watermark, per-page bookmarks (a real
  PDF outline) and full document metadata.
- Three one-click presets and a live size estimate before you build.

**Keep**

- Multiple documents in IndexedDB, autosaved, with an installable PWA and offline shell.
- Export a project bundle (`.scanlet.zip`) and reopen it later or on another machine.
- Export pages as PNGs in a zip, or print straight from the browser.

---

## How scanning reaches a printer

A web page cannot open a socket to a printer, cannot ask about printers over mDNS, and
— because printers send no CORS headers — cannot even read the reply to an HTTP
request. That is a platform limit, not a Scanlet one, and it is the whole reason the
choices below exist.

| Path | Needs | Works for |
|---|---|---|
| **Camera** | nothing | anything with a lens, phone or laptop |
| **Import** | the file already exists | scans pushed to SMB / FTP / email / cloud |
| **Extension** | one click in Chrome/Edge | this computer, any eSCL printer, no server |
| **Bridge** | one `node` command | any browser, and **other devices on your network** |

### The plugin (no server)

`extension/` is a Chrome/Edge extension. An extension *can* read a printer's reply
when you grant it host access, so the plugin replaces the local server entirely:

1. Download `scanlet-extension-1.0.0.zip` from the
   [latest release](../../releases/latest) and unzip it, or use the `extension/`
   folder as-is.
2. `chrome://extensions` → Developer mode → **Load unpacked** → the unzipped folder.
3. Options (the toolbar button opens them) → **Grant network access**.
4. In Scanlet: **Scanner → Browser extension**.

Discovery is a sweep of the `/24` prefixes you list, because an extension has no mDNS
socket. See [`extension/README.md`](extension/README.md) for the permission model.

It is packaged and ready to submit, but **not yet published to either store** — the
stores need a developer account and, for Chrome, a one-time fee, so that last click is
yours. [`extension/STORE.md`](extension/STORE.md) holds the listing copy, the permission
justifications and the privacy-tab answers; `node tools/build-extension.mjs` produces a
validated zip and refuses to write one that would be rejected.

### The bridge

```sh
node bridge/scanlet-bridge.mjs            # this machine only (127.0.0.1:8787)
node bridge/scanlet-bridge.mjs --lan      # also serves Scanlet to your phone
node bridge/scanlet-bridge.mjs --lan --tls  # …over https, for the full PWA
```

One file, no dependencies, Node 18+. It discovers scanners over Bonjour
(`_uscan._tcp`, `_uscans._tcp`, `_scanner._tcp`) and drives them with **eSCL** — the
driverless protocol Apple AirScan and SANE's `escl` backend use. No vendor drivers, no
SDKs.

In the default mode it is a private helper on the loopback interface. With `--lan` it
becomes a small scan server that **also serves the Scanlet app**, so any device on
your network can open it and scan. Access is gated by a pairing code, which the bridge
prints inside the link:

```
Open Scanlet on this machine:  http://127.0.0.1:8787/#s=TKrnnFUsQM-u
Open Scanlet on your phone:    http://192.168.1.50:8787/#s=TKrnnFUsQM-u
```

Scanlet reads that `#s=` code on load, pairs itself, strips it from the address bar and
shows a QR code so the next device can join with one scan.

| Flag | Meaning |
|---|---|
| `--lan` | listen on the network and serve the app, with a pairing code |
| `--tls` | serve over https with a generated self-signed certificate |
| `--token <code>` | use a fixed pairing code instead of a random one |
| `--port`, `--host`, `--quiet` | as you would expect |
| `--app <dir>`, `--no-serve` | where the app lives, or do not serve it at all |

Beyond the app's own API, one URL scans on demand — for Shortcuts, Tasker, `curl` or a
cron job:

```sh
curl -o scan.pdf 'http://192.168.1.50:8787/scan.pdf?printer=192.168.1.42&token=CODE'
```

It asks the *device* for a PDF, so a multi-page ADF job comes back as one document; if
the device cannot, you get the first page as an image and an `x-scanlet-format` header
saying so. `GET /certificate.pem` serves the TLS certificate so a phone can install and
trust it.

The bridge also **advertises itself over Bonjour** (`_scanlet._tcp`) with its address,
port, version and whether a pairing code is needed — never the code itself. A browser
cannot browse mDNS, so this is not how the app finds it; it is how everything *else*
can. From a clone:

```sh
node tools/find-bridge.mjs          # name, address, port, and whether a code is needed
dns-sd -B _scanlet._tcp             # or with Apple's own tools
```

Run the bridge with `--name scanlet` and it is reachable at `scanlet.local` too, which
an app served over plain http will guess automatically. Turn it off with
`--no-advertise`.

### Home Assistant

There is an add-on, so the bridge can live on the machine that is already on all the
time:

**Settings → Add-ons → Add-on store → ⋮ → Repositories** →
`https://github.com/Lettly/scanlet` → install **Scanlet Bridge**.

You then get Scanlet **in the Home Assistant sidebar**, over Home Assistant's own
https. That is the best mobile story in this repository: an https address is a secure
origin, so the camera, the offline shell and *Add to Home Screen* all work, and because
the panel and the API are the same origin there is nothing to configure — the add-on
seeds the pairing code into the page for requests that came through ingress.

It keeps the network listener on port 8787 for Shortcuts, Tasker, `curl` and the
extension, and advertises itself on the network like any other bridge. See
[`scanlet_bridge/README.md`](scanlet_bridge/README.md) for the options.

### Mobile: iPhone and Android

**A browser on a phone still cannot reach a printer on its own** — no sockets, no mDNS,
and the same CORS wall. No PWA can change that, and neither platform offers a web app a
way around it. So the bridge serves the app, and each platform gets an extra native
integration:

| | iPhone / iPad | Android |
|---|---|---|
| Camera in an installed app | ✅ Add to Home Screen | ✅ install prompt |
| Scan from a network printer | ✅ `--lan --tls` | ✅ `--lan` (or `--tls`) |
| Scan from another app into Scanlet | ➖ no share targets in Safari | ✅ **share sheet → Scanlet** |
| Scan straight to Files, unattended | ✅ **Shortcut + `/scan.pdf`** | ✅ Tasker, `curl` |
| Home-screen shortcuts | ➖ | ✅ manifest `shortcuts` |
| Desktop-style extension | ❌ | ❌ Chrome for Android has no extensions |

- **Android** can receive shared files: pick **Scanlet** in any app's share sheet. The
  service worker takes the POST, stashes it, and the app imports it.
- **iOS** has no share targets, so the bridge answers a single URL —
  `/scan.pdf?printer=192.168.1.42&token=…` — which a Shortcut can fetch and save to
  Files, straight from a printer, with no app open.
- **`--tls` is what makes the address a secure origin**: camera, offline shell and
  **Add to Home Screen** all need it. Plain `--lan` still scans.

Full detail, including the certificate-trust steps iOS needs and the exact native-app
recipe if you want one: **[docs/mobile.md](docs/mobile.md)**.

Storage is per-origin, so documents kept at the bridge's address are separate from
documents kept at the GitHub Pages address. Pick one and stay there.

### Trying it without a printer

```sh
node bridge/test/mock-scanner.mjs --render   # a fake eSCL scanner on :8199
node bridge/scanlet-bridge.mjs               # then add 127.0.0.1:8199 in the UI
npm test                                     # both test suites
```

---

## Run it locally

It is a static site — no build step, no bundler, no `node_modules`.

```sh
node tools/serve.mjs          # http://127.0.0.1:8899
```

Use that rather than `python3 -m http.server`: it sends the headers production would,
so the shell and the service worker are never cached and everything else is revalidated
with an ETag. A bare static server sends no cache headers at all, which means your
browser caches your own JavaScript by heuristic and a reload quietly serves the previous
build — hiding exactly the staleness bugs this app has been bitten by.

Opening `index.html` directly works for import and export, but the camera and the
bridge both need a real origin, so serve it over HTTP.

## Deploy it

Any static host will do. For GitHub Pages: push this repository, then in
**Settings → Pages** choose **Deploy from a branch → main → / (root)** — that is
exactly how the [live demo](https://lettly.github.io/scanlet/) is published. The
included `.github/workflows/ci.yml` runs the tests on every push; it does not need to
touch Pages.

## Test it

```sh
npm test    # bridge end-to-end + the extension + the Home Assistant add-on
```

- `bridge/test/bridge.test.mjs` drives a private bridge, a paired LAN bridge, a
  PDF-refusing device and the Bonjour responder against a mock eSCL scanner, with the
  real client module — so multipart parsing, token auth, static serving,
  path-traversal refusal, the single-URL scan endpoints, the certificate route and the
  advertisement are all covered.
- `extension/test/escl.test.mjs` drives the extension's `fetch`-only modules against
  the same mock, covering capability parsing, scan-region arithmetic and ADF streaming.
- `extension/test/messaging.test.mjs` puts a fake `chrome` in front of the real service
  worker and drives its whole message protocol.
- `scanlet_bridge/test/addon.test.mjs` runs the add-on entry point as a child process
  and checks both of its listeners, including that Home Assistant's ingress header is
  the only thing that gets the pairing code handed to it.

Two things are exercised in a browser rather than in Node, because they need one:
**⋮ → About Scanlet → Run diagnostics** covers the whole image and PDF pipeline *and*
verifies self-containment (it HEAD-checks all 194 vendored files and reports any
resource that did not come from this origin), and `tests/share-post.html` submits the
Android share target's POST so the worker-stash-then-import path can be driven from a
desktop.

`node tools/vendor.mjs --check` re-hashes `vendor/` against its manifest, and
`node tools/build-extension.mjs --check` validates the extension package; CI runs both
on every push.

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
  bridge.js             clients for the bridge and the browser extension
  qr.js                 QR codes, for handing a session to another device
  share.js              the app side of the Android share target
sw.js                   offline shell and the share endpoint; revalidates app code,
                        caches pinned libraries hard
bridge/                 the scanning bridge (Node, no dependencies)
bridge/test/            mock eSCL scanner + its end-to-end tests
extension/              the Chrome/Edge plugin (MV3)
extension/test/         tests for its printer layer and message protocol
docs/mobile.md          what works on iOS and Android, and what does not
docs/self-contained.md  what is vendored, its size, and how to update it
repository.yaml         the Home Assistant add-on repository manifest
scanlet_bridge/         the Home Assistant add-on (config.yaml, Dockerfile, run.mjs)
tests/share-post.html   manual harness for the share target
vendor/                 the vendored libraries (see docs/self-contained.md)
icons/, tools/          generated PNG icons, the icon generator, and the scripts:
                        tools/vendor.mjs, tools/serve.mjs, tools/build-extension.mjs,
                        tools/find-bridge.mjs
```

A page is two things: the **untouched original blob** in IndexedDB, and a small **edit
recipe** (corners, rotation, filter, adjustments, OCR result) in the document record.
Rendering applies the recipe on the fly; *bake edits* rewrites the original. That is
what makes every operation reversible and the storage cheap.

Rendering a page runs:

```
original → perspective warp → rotate/flip → downscale → enhancement → border trim
```

Third-party libraries are **vendored into `vendor/`** and loaded from there, so the app
makes no third-party request at runtime — see
[docs/self-contained.md](docs/self-contained.md) for what is included, the size, and how
to update it:

| Library | Used for |
|---|---|
| [PDF.js](https://mozilla.github.io/pdf.js/) 3.11.174 | rendering imported PDFs (+ CMaps and substitute fonts) |
| [pdf-lib](https://pdf-lib.js.org/) 1.17.1 | writing the exported PDF |
| [Tesseract.js](https://tesseract.projectnaptha.com/) 5.1.1 | OCR (+ its WASM core and English trained data) |
| [JSZip](https://stuk.github.io/jszip/) 3.10.1 | page and project bundles |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 | pairing QR codes |

## Privacy and self-containment

There is no backend, no analytics, no telemetry, and **no third-party request at
runtime** — every library is vendored into `vendor/`, so the app runs with the network
unplugged. Documents, page images and recognised text live in your browser's storage
until you delete them.

Run **⋮ → About Scanlet → Run diagnostics** and the last line confirms it from the
browser's own resource timings: `no third-party requests — all same-origin`.

The bridge and the extension are the only components that touch the network at all, and
they talk only to printers you point them at. The bridge keeps its pairing code in the
URL **fragment**, which is never sent to a server, logged, or leaked as a referrer.
See [docs/self-contained.md](docs/self-contained.md) for what is vendored, how to
update it, and how to make more OCR languages local.

## Limits worth knowing

- **A phone browser cannot scan a printer by itself.** Use the bridge's `--lan` mode,
  or the camera. This is a platform limit that no web app can work around.
- **Plain-http `--lan` is not a secure origin**, so on a phone you lose the camera, the
  offline cache and PWA installation. Add `--tls` for those, and trust the certificate
  on iOS (see [docs/mobile.md](docs/mobile.md)).
- **Share targets and home-screen shortcuts are Android-only** — Safari implements
  neither. On iOS, the equivalent is a Shortcut against `/scan.pdf`.
- **No native iOS or Android app ships here.** The recipe, and the single interface a
  native shell has to implement, is in [docs/mobile.md](docs/mobile.md).
- **Anyone with the pairing link can use your printers.** Treat it like a password;
  it is printed rather than emailed for that reason. Do not expose the bridge to the
  internet.
- **The extension is Chrome/Edge only**, and finds printers by sweeping the prefixes
  you give it rather than by mDNS.
- **Duplex and ADF come from the device**, through eSCL. Devices that support only
  vendor protocols need a driver-based helper.
- **The OCR text layer uses the standard PDF fonts** (WinAnsi), so searchable text is
  written for Latin-script languages. Other scripts are still exported to `.txt` but
  not embedded invisibly.
- **No PDF encryption** yet. Run the result through `qpdf` or `pdftk` if you need a
  password.
- **HEIC** import depends on the browser being able to decode it (Safari can, most
  others cannot).

## Licence

MIT — see [LICENSE](LICENSE).
