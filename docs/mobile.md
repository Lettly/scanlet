# Scanlet on a phone

The short version of the wall: **no web page can open a socket to a printer, ask about
printers over mDNS, or read a printer's HTTP reply** (printers send no CORS headers).
None of that changes on a phone, and neither iOS nor Android offers a way for a web
app to step around it. So the honest answer is a matrix, not a promise.

| | iPhone / iPad | Android |
|---|---|---|
| Camera scan in an installed app | ✅ Add to Home Screen | ✅ install prompt |
| **Scan from a network printer** | ✅ bridge `--lan --tls` | ✅ bridge `--lan` (or `--tls`) |
| **Receive a scan from another app** | ➖ Safari has no share targets | ✅ share sheet → Scanlet |
| **Scan straight to Files, unattended** | ✅ Shortcut + `/scan.pdf` | ✅ share sheet, Tasker, `curl` |
| Home-screen shortcuts | ➖ | ✅ manifest `shortcuts` |
| Desktop-style extension | ❌ | ❌ Chrome for Android has no extensions |

Everything in that table except the last row is implemented in this repository. The two
rows with ❌/➖ are platform limits, explained below with what to do instead.

---

## iPhone / iPad

### 1. Camera scanning — works now, nothing to install

Open the app in Safari and **Share → Add to Home Screen**. Scanlet ships the
`apple-mobile-web-app-*` meta tags and an `apple-touch-icon`, so it launches as a
standalone window without Safari's chrome. The camera path (edge detection, corner
handles, multi-shot, then OCR and PDF) is the same code as on the desktop.

### 2. Scanning from a printer — the bridge, over TLS

```sh
node bridge/scanlet-bridge.mjs --lan --tls
```

Open the link it prints on the phone. Safari warns about the self-signed certificate
once; accept it. That address is now a **secure origin**, which is what iOS requires for:

- the camera (`getUserMedia`),
- the service worker and the offline shell,
- **Add to Home Screen** as a real app.

Without `--tls` you can still scan from a printer on the phone — the app is served over
plain http and scanning is just HTTP to the bridge — but you lose all three of the above.

### 3. Scan → Files, without opening anything: a Shortcut

The bridge can scan on demand from a single URL, which is exactly what a Shortcut can
call.

1. **Shortcuts → +** and name it *Scan to Files*.
2. Add **Get Contents of URL**, set the URL to:

   ```
   https://192.168.1.50:8787/scan.pdf?printer=192.168.1.42
   ```

   `192.168.1.50` is the machine running the bridge; `printer=` is the printer, and can
   be a plain address. Drop `printer=` when the bridge knows exactly one device.
3. Add **Save File**, destination *Files*.
4. Optionally add it to the Home Screen or to Siri.

A device that can assemble a PDF server-side (most ADFs can) returns a genuine
multi-page PDF. If it cannot, the bridge asks for an image instead and tells you so in
an `x-scanlet-format` header rather than handing you a mislabelled `.pdf`.

Two things to know:

- **The certificate must be trusted, not merely accepted.** URLSession — which
  Shortcuts uses — does not offer the "proceed anyway" button Safari does. Download it
  at `http://192.168.1.50:8787/certificate.pem`, install the profile, then enable it in
  **Settings → General → About → Certificate Trust Settings**. (Plain `http://` in the
  Shortcut may also work; TLS is the reliable path.)
- Scanning **pulls the next sheet**, so an ADF Shortcut consumes paper. Fine for
  "scan the form I just fed in"; not something to put on a timer.

### What does not work on iOS, and why

- **"Share → Scanlet" does not exist.** Web Share Target is not implemented in Safari,
  so a web app cannot be a share destination. Use the Shortcut above, or Import.
- **No extension can help.** Safari web extensions on iOS run against the same web APIs
  as a page; there is no socket or mDNS API to grant them.
- **A web app cannot run a background server.** iOS suspends it, so the bridge cannot
  live inside the PWA on iOS.

### If you want a real iOS app

The scanning engine, the UI, OCR and PDF assembly are done and reusable. A native shell
needs:

- a **`WKWebView`** pointing at the same UI (bundled, or the Pages URL),
- a native **`ScanClient`** implementing the one interface in the next section,
- **`NSLocalNetworkUsageDescription`** plus **`NSBonjourServices`**
  (`_uscan._tcp`, `_uscans._tcp`) in `Info.plist` — iOS prompts for local network access
  the first time,
- `NWBrowser`/`NWConnection` (or plain `URLSession`) for eSCL.

No special entitlement is needed for local-network access, and this is a legitimate App
Store category.

---

## Android

### 1. Install the PWA

Chrome shows the install prompt for the HTTPS origin — the Pages URL, or the bridge with
`--tls`. The manifest ships `display_override`, `shortcuts` and an `id`, so the installed
app opens standalone and long-pressing the icon offers **Import**, **Camera** and
**Printer** directly.

### 2. Share a scan straight into Scanlet

This is the Android-only trick worth knowing. Scanlet registers as a **share target**, so
any app can hand it files:

> scan with Mopria / Google Drive / your printer's own app → **Share** → **Scanlet**

How it works, because it is not obvious:

1. `manifest.webmanifest` declares `share_target` → `POST multipart/form-data` → `./share`.
2. The **service worker** receives it. A service worker is the only way a web app can
   receive a POST at all.
3. The worker stashes the files in the **Cache API** and answers with a `303` to
   `index.html?shared=<id>`.
4. The app reads the stash, imports the files with the ordinary importer, and deletes it
   so a reload cannot double-import.

`tests/share-post.html` submits the same POST from a form, so this path can be exercised
on a desktop without a phone.

Web Share Target is Chromium-only, so this works on Android (and Chrome OS) and not on
iOS. Shared *links* are handled too, when the site allows the fetch.

### 3. Scanning from a printer

```sh
node bridge/scanlet-bridge.mjs --lan        # http is enough to scan
node bridge/scanlet-bridge.mjs --lan --tls  # also camera, offline, install
```

### 4. Unattended scanning

Anything that can fetch a URL can pull a scan: Tasker, HTTP Request Shortcuts, a cron
job, `curl -o scan.pdf 'http://192.168.1.50:8787/scan.pdf?printer=192.168.1.42'`.

### What does not work on Android, and why

- **Chrome for Android has no extension support**, so the plugin (`extension/`) is a
  desktop tool. The bridge covers Android instead.
- **No mDNS from the browser**, which is why the extension finds printers by sweeping and
  the bridge does the Bonjour query itself.

### If you want a real Android app

- **WebView** + `NsdManager` (mDNS) + `OkHttp`, or **Capacitor** with a native plugin —
  same shape as the iOS recipe.
- Permissions: `INTERNET` for HTTP to a printer. `NsdManager` needs no extra permission;
  `NEARBY_WIFI_DEVICES` is for the Wi-Fi scanning APIs and is not needed here.
- Android has no local-network prompt, so there is no equivalent of the iOS permission
  dance.

---

## The one interface a native shell implements

Both existing ways to reach a printer implement the same small contract, so a native app
is a third implementation rather than a rewrite:

```js
discover({ onPrinter })            // → printers: [{ id, name, address, port, path, secure }]
capabilities(id)                   // → { sources, colorModes, resolutions, duplex, maxima }
probeAddress('192.168.1.42')       // → { printer, caps }
scan(id, options, { onPage })      // → one page at a time: { blob, mime }
```

- `assets/js/bridge.js` — `BridgeClient` (the Node bridge, or a LAN bridge)
- `assets/js/bridge.js` — `ExtensionClient` (the browser plugin, over `postMessage`)
- `extension/src/escl.js` — the `fetch`-only eSCL core a native shell would port

The UI never knows which one it is talking to: `app.js` picks a client and calls the same
four methods.

## What was not built

**No native iOS or Android app.** Building one needs Xcode and the Android SDK, and it
cannot be built or verified in this repository's environment — a shipped-but-untested
native app would be worse than none. What that shell has to do is written out above:
one WebView, one `Info.plist`/manifest entry, and the four methods.

## Worth knowing either way

- **Storage is per origin.** Documents kept at `https://lettly.github.io/scanlet/` are
  separate from documents kept at the bridge's address. Pick one and stay there.
- **Do not expose the bridge to the internet.** Anyone who can reach it can use your
  printers — there is no pairing code, the network itself is the boundary.
