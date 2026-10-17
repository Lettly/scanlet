# Scanlet Bridge

Runs the [Scanlet](https://lettly.github.io/scanlet/) scanning bridge on your Home
Assistant box, and puts Scanlet in the sidebar.

Scanlet is a document scanner in a web page: it captures, straightens, cleans up,
OCRs and assembles PDFs. It cannot reach a printer by itself, because a web page
cannot open a socket or read a printer's reply — so it needs a bridge, and this is
that bridge, without a second machine to keep running.

## What you get

- **Scanlet in the sidebar**, over Home Assistant's own https. That matters more
  than it sounds: an https address is a *secure origin*, so the camera, the offline
  cache and **Add to Home Screen** all work on a phone. It is also the same origin
  as the bridge API, so there is nothing to configure and no mixed-content problem.
- **Nothing to pair.** Opening the panel from the sidebar connects straight to the
  bridge behind Home Assistant's ingress path.
- **A network port (8787)** for things that are not a browser: an iOS Shortcut,
  Tasker, `curl`, or the Scanlet browser extension. It needs no code either.
- **Bonjour discovery**, so the bridge can be found without reading logs. It advertises
  `_scanlet._tcp` on your network, and answers on the Home Assistant host as well —
  usually `http://homeassistant.local:8787/`.

## Using it

1. Open **Scanlet** from the sidebar.
2. Press **Scanner**, choose **Browser extension** or **Scanning bridge**, pick the
   printer, press **Scan**.

If no printer appears, add it by address — every eSCL/AirScan device on your network
will answer at `192.168.x.y` or `192.168.x.y:80`.

### No pairing, by design

There is no pairing code. Opening the sidebar panel connects straight to the bridge,
and the network port is open to your LAN. Anyone who can reach the add-on can use your
printers, so the network is the boundary — do not expose port 8787 to the internet.

### Finding it from another device

A phone that is not in the sidebar opens Scanlet at the add-on's own address,
`http://homeassistant.local:8787/` (or whatever your Home Assistant host is called), and
it connects with no setup. Scanlet's network search also sweeps the LAN and tries the
usual `.local` names, including `homeassistant.local` — from an https page too: the
browser asks permission to reach your local network first (Chrome's *Local network
access* prompt), and once allowed the bridge answers. The sidebar panel needs neither:
it talks to the bridge behind Home Assistant's ingress path.

### Scanning without opening Scanlet

```sh
curl -o scan.pdf 'http://homeassistant.local:8787/scan.pdf?printer=192.168.1.42'
```

That is also the URL shape an iOS Shortcut uses (`Get Contents of URL` → `Save to
File`), which is how you scan to a folder from the lock screen.

### Finding it on the network

```sh
node tools/find-bridge.mjs                    # from a clone of the repository
dns-sd -B _scanlet._tcp                       # or with Apple's own tools
```

The bridge advertises `_scanlet._tcp` with its address, port and version, and nothing
secret.

## Options

| Option | Default | Meaning |
|---|---|---|
| `printers` | `[]` | Addresses to add at startup, such as `192.168.1.42`. Handy if discovery misses a device. |
| `advertise` | `true` | Announce the bridge over Bonjour as `_scanlet._tcp`. |

## How it is put together

The add-on runs the same `bridge/scanlet-bridge.mjs` the standalone bridge does — it
adds no second implementation of anything, only the two listeners. The app itself is
fetched from a pinned ref when the image is built, so the image is reproducible and
this folder stays small.

`host_network: true` is required: the bridge needs mDNS to find scanners and to
announce itself, and it needs to reach printers wherever they are on your network.

## Limits

- **One bridge per Home Assistant instance.** Nothing breaks with two, but they
  would fight over port 8787.
- **The app version is pinned to the image.** Updating the add-on brings a newer
  app; the sidebar panel will not change until then.
- **Firefox is not a consideration here** — this is a server-side component.
- **Anyone who can reach port 8787 can scan.** There is no pairing code; keep the
  add-on off the public internet.
