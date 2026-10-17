# Store submission

Everything the Chrome Web Store and Edge Add-ons ask for, written out so
submitting is copy, paste and one file upload.

Artifact: **`dist/scanlet-extension-1.0.0.zip`** — build it with
`node tools/build-extension.mjs`, which validates the package before writing it.

---

## What only you can do

The **first** submission is manual: both stores need an account that proves who is
publishing, Chrome requires a one-time payment, and the item has to exist before the
API can update it. After that, Chrome updates publish themselves from CI — see
[Publishing from CI](#publishing-from-ci) below.

**Chrome Web Store**

1. Register as a developer at <https://chrome.google.com/webstore/devconsole>
   — **one-time US$5** fee, paid by you.
2. **New item** → upload `dist/scanlet-extension-1.0.0.zip`.
3. Fill the *Store listing* tab from the copy below.
4. Fill the *Privacy* tab from the answers below. This is the tab that gets
   extensions rejected, so it is worth reading rather than skimming.
5. *Distribution* tab: **Public**, all regions.
6. Submit for review. Expect a first review of a few days; updates are usually
   hours. If a reviewer asks a question, the justification wording below is
   usually enough.

**Edge Add-ons** (same zip, free, usually faster)

1. Register at <https://partner.microsoft.com/dashboard/microsoftedge/>.
2. *Extensions* → **New extension** → upload the same file.
3. The listing fields are almost identical to Chrome's; reuse the copy below.

Firefox needs a port, not just a re-upload — see the last section.

---

## Store listing

**Name** (45 characters max)

```
Scanlet Bridge
```

**Short description** (132 characters max)

```
Reach eSCL/AirScan printers from Scanlet with no server and no drivers. Nothing leaves your network.
```

**Category:** Productivity → Tools. **Language:** English.

**Detailed description**

```
Scanlet Bridge lets the Scanlet document scanner talk to your printer directly.

A web page cannot open a socket to a printer, and printers do not send the headers
a page needs to read their replies. This extension lifts that restriction: with your
permission it can reach a printer on your own network, so Scanlet can pull scans from
a flatbed, a document feeder or a duplexing ADF — the same driverless eSCL/AirScan
protocol your phone and Mac already use when they print.

Why you might want it:
• No local server. Unlike running a helper program, there is nothing to install,
  start, or keep running.
• No drivers, no vendor software.
• ADF and duplex come from the device, including multi-sheet jobs.
• Nothing to configure if your printer is on a typical home network.

How it works:
1. Install the extension and open its options page.
2. Press "Grant network access". Until you do, the extension does nothing at all.
3. Open Scanlet https://lettly.github.io/scanlet/
4. Scanner → Browser extension → pick your printer → Scan.

What it asks for, and why:
• "storage" — remembers which networks you asked it to search.
• Optional access to local addresses — needed to reach a printer, because printers
  live at whatever address your router gave them. It is optional, requested only when
  you press the button, and revocable at any time from the options page.

Privacy: scanning happens entirely on your machine. The extension talks only to
printers on your own network. There is no server, no account, no analytics, no
telemetry, and no remote code.

Scanlet itself — the camera capture, the page clean-up, the OCR and the PDF assembly —
is a separate web app that runs entirely in your browser. This extension only adds the
printer connection.
```

## Permission justifications

The dashboard asks for one per permission. Paste these.

**`storage`**

```
Stores which /24 network prefixes and device port the user asked the extension to
search. That is the only thing kept, it never leaves the device, and it is used solely
to know where to look for printers on the next discovery.
```

**Host permission: local addresses (`http://*/*`, `https://*/*`, requested at runtime)**

```
A printer is reached over HTTP with the driverless eSCL/AirScan protocol, but printers
have no fixed address — they sit wherever the user's router put them (192.168.1.x,
10.0.0.x, and so on), which match patterns cannot express without covering all hosts.
The permission is therefore declared as optional and is requested only when the user
presses "Grant network access" or adds a specific device by address, at which point
they can also restrict it to that one device. Requests go only to printers on the
user's own local network; nothing is sent anywhere else and no data is collected.
```

**Single purpose statement**

```
Connect the Scanlet web app to printers on the user's local network.
```

## Privacy tab answers

| Question | Answer |
|---|---|
| Does this item collect or use user data? | **No.** No personal data is collected, stored, or transmitted. The only persisted values are the network prefixes and port the user typed, held in `chrome.storage.local` on their machine. |
| Does it use remote code? | **No.** All code ships in the package. The build refuses to produce a zip containing `eval`, `new Function`, a remote `fetch` or a remote `import`. |
| Does it sell or transfer data to third parties? | **No.** |
| Does it use data for creditworthiness or lending? | **No.** |
| Certify compliance with the developer policies | Yes, once the two permissions above are justified |

**Privacy policy URL** — required because the extension reaches the network:

```
https://lettly.github.io/scanlet/extension/privacy.html
```

## Screenshots

Chrome accepts up to 5 at **1280×800**; at least one is required. The tile
(440×280) is optional.

`store/promo-1280x800.png` is a **designed listing graphic**, not a screenshot — it is
built from `store/listing.html` and shows no invented UI. It is enough to submit, but
real screenshots convert better. Take them like this:

1. `chrome://extensions` → Developer mode → **Load unpacked** → this `extension/` folder.
2. Open the options page and grant network access → screenshot the permission section.
3. Open Scanlet, press **Scanner**, choose **Browser extension**, press **Scan** while
   the ADF is loaded → screenshot the pages arriving.
4. Any screenshot tool is fine; resize to exactly 1280×800 before uploading.

## Versioning

The version in `manifest.json` must increase with every upload. Check the package
before shipping it:

```sh
node tools/build-extension.mjs     # validates, then writes dist/scanlet-extension-<version>.zip
node extension/test/messaging.test.mjs
```

## Publishing from CI

`.github/workflows/publish-extension.yml` keeps the store item up to date. It runs when
an **`extension-vX.Y.Z` tag** is pushed — where `X.Y.Z` is the version in
`manifest.json` — or by hand from the **Actions** tab (with an *upload only* checkbox to
stage a build without submitting it). It builds and validates the package, runs the
extension tests, then uploads it and submits it for review through
[`tools/publish-extension.mjs`](../tools/publish-extension.mjs).

It needs five repository secrets (**Settings → Secrets and variables → Actions**), all
from the OAuth setup above:

| Secret | Where it comes from |
|---|---|
| `CWS_PUBLISHER_ID` | Developer Dashboard → **Publisher → Settings** |
| `CWS_EXTENSION_ID` | the item's ID in the dashboard, or the number in its store URL |
| `CWS_CLIENT_ID` | the OAuth client (Google Cloud Console → **Credentials**) |
| `CWS_CLIENT_SECRET` | the same client |
| `CWS_REFRESH_TOKEN` | the OAuth Playground step above |

The tool refuses to publish when a release tag and the manifest disagree, so a
forgotten version bump fails the run instead of re-publishing the previous build. Try
it locally without touching the store:

```sh
node tools/publish-extension.mjs --dry-run    # builds and prints; sends nothing
```

Edge has no equivalent upload API wired here, so Edge updates stay manual for now.

## Self-hosting Scanlet

The extension injects its relay on the published app and on loopback (where the bridge
serves the app). If you serve Scanlet somewhere else, add that origin to
`content_scripts.matches` in `manifest.json` before building — for example
`https://scanlet.example.com/*`. Nothing else needs to change.

## Firefox

The same code will not drop straight in:

- Firefox MV3 wants `background.scripts` (an event page), not `service_worker`.
- `chrome.system.network` does not exist there either, so discovery falls back to the
  configured prefixes exactly as it already does.
- The `chrome.*` promise-returning calls used here are supported, but the worker's
  lifetime differs, so it needs testing rather than assuming.

I have not done that port, and I would not publish it without testing it on Firefox
first. Chrome, Edge and any other Chromium browser share the same package.
