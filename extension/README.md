# Scanlet bridge (browser extension)

A Chrome/Edge extension that lets **Scanlet reach eSCL / AirScan printers directly**.
No local server, no drivers, nothing to run in a terminal.

## Why this can exist at all

Scanlet is a web page, and a web page cannot read a printer's reply: printers send no
CORS headers, so the browser throws the response away. An extension is not bound by
that rule — with host permission it can `fetch` any address it likes. That one
difference is what makes the plugin a real replacement for the local bridge, and the
only reason it needs a permission prompt.

## Install (unpacked, for now)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → pick this `extension/` folder.
4. Open the extension's **Options** and press **Grant network access**. Nothing is
   probed or fetched before you do.

Then open [Scanlet](https://lettly.github.io/scanlet/), press **Scanner**, choose
**Browser extension**. Printers found on your network are listed; anything missed can
be added by address.

## What it asks for, and why

| Permission | Why |
|---|---|
| `storage` | remembering the `/24` prefixes you want swept |
| **optional** host access to `http://*/*` and `https://*/*` | so the worker can talk to printers at whatever address they are on |

Host access is **optional**: it is requested only when you press *Grant network
access*, and you can revoke it at any time from the options page. Until then the
extension does nothing at all.

## Finding printers

There is no mDNS here — an extension has no multicast socket — so the extension
probes. It sweeps the `/24` prefixes from the options page, or, if the browser
exposes `chrome.system.network`, whatever network it is actually attached to.

That means discovery is a few hundred quick HTTP requests. It is fast on a home
network and pointless on a large corporate one, where mDNS is blocked anyway:
there, add the printer by address, which needs a single request.

## How it is put together

```
manifest.json      MV3: optional host permissions, content script on the app URL
src/escl.js        eSCL client over fetch — no chrome.*, so it is testable in Node
src/discovery.js   subnet enumeration and probing
src/worker.js      the service worker: permissions, orchestration, streaming
src/content.js     relays window messages to the worker and back
options.html       permission, prefixes, and a "find printers now" button
```

The page cannot call `chrome.runtime`, so a content script carries messages between
the two. A scan of an ADF job streams **one message per sheet** (base64) rather than
one huge blob, so a long document never hits a message size limit.

## Tests

```sh
node extension/test/escl.test.mjs        # the printer layer, against a mock scanner
node extension/test/messaging.test.mjs   # the worker's message protocol
```

Everything that talks to a printer lives in `escl.js` and `discovery.js`, which
depend only on `fetch` — so the tests drive them against the same mock scanner the
bridge uses, with no browser in the loop. That covers printer-id round-trips,
capability parsing, the scan region arithmetic, ADF streaming, probing and progress.

`messaging.test.mjs` goes further and covers the wiring: it puts a fake `chrome` in
front of the real `src/worker.js`, calls the listener that module registers, and checks
the whole protocol — ping, unknown requests, add-by-address, capabilities, a streamed
scan, the permission gate, and a sweep that finds nothing. It exists because it caught
a real bug: the request-correlation id and the printer id shared one field, so
`capabilities` and `scan` never matched a reply and hung until their timeout.

## Publishing

`STORE.md` in this folder has the listing copy, the permission justifications and the
privacy-tab answers, plus the upload steps for both stores. The package is built with:

```sh
node tools/build-extension.mjs        # validates, then writes dist/scanlet-extension-<version>.zip
```

That refuses to write a zip that would be rejected: wrong manifest version, a missing
or mis-sized icon, a missing content script, or any remotely hosted code (`eval`,
`new Function`, a remote `fetch` or `import`).

Chrome updates publish themselves once the item exists: push an `extension-v<version>`
tag and `.github/workflows/publish-extension.yml` uploads and submits it for review.
The five store secrets it needs, and the manual first-submission steps, are in
`STORE.md`.

## Limitations

- **Chrome and Edge only.** Firefox has no equivalent of the optional-host-permission
  flow and blocks cross-origin fetches from extension pages differently; use the
  bridge there.
- Discovery is by sweep, not mDNS, so it only covers the prefixes you list.
- The content script is injected on the Scanlet app URLs listed in `manifest.json`.
  If you self-host Scanlet somewhere else, add that URL to `content_scripts.matches`.
