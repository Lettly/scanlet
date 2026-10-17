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
- **It pairs itself.** Opening the panel from the sidebar needs no address and no
  code — the pairing code is seeded into the page for requests that actually came
  through Home Assistant's ingress.
- **A network port (8787)** for things that are not a browser: an iOS Shortcut,
  Tasker, `curl`, or the Scanlet browser extension. Those need the pairing code.
- **Bonjour discovery**, so the bridge can be found without reading logs.

## Using it

1. Open **Scanlet** from the sidebar.
2. Press **Scanner**, choose **Browser extension** or **Scanning bridge**, pick the
   printer, press **Scan**.

If no printer appears, add it by address — every eSCL/AirScan device on your network
will answer at `192.168.x.y` or `192.168.x.y:80`.

### The pairing code

Only the network port needs it. Find it in the add-on log, or in
`/data/scanlet-token`:

```
http://<your-home-assistant>:8787/#s=<the code>
```

Set your own in the add-on options if you would rather choose it.

### Scanning without opening Scanlet

```sh
curl -o scan.pdf 'http://homeassistant.local:8787/scan.pdf?printer=192.168.1.42&token=THE_CODE'
```

That is also the URL shape an iOS Shortcut uses (`Get Contents of URL` → `Save to
File`), which is how you scan to a folder from the lock screen.

### Finding it on the network

```sh
node tools/find-bridge.mjs                    # from a clone of the repository
dns-sd -B _scanlet._tcp                       # or with Apple's own tools
```

The bridge advertises `_scanlet._tcp` with its address, port and whether a code is
needed — never the code itself.

## Options

| Option | Default | Meaning |
|---|---|---|
| `token` | *(empty)* | The pairing code for the network port. Empty generates one and keeps it in `/data/scanlet-token`. |
| `printers` | `[]` | Addresses to add at startup, such as `192.168.1.42`. Handy if discovery misses a device. |
| `advertise` | `true` | Announce the bridge over Bonjour as `_scanlet._tcp`. |

## How it is put together

The add-on runs the same `bridge/scanlet-bridge.mjs` the standalone bridge does —
it adds no second implementation of anything, only the two listeners and the
pairing. The app itself is fetched from a pinned ref when the image is built, so
the image is reproducible and this folder stays small.

`host_network: true` is required: the bridge needs mDNS to find scanners and to
announce itself, and it needs to reach printers wherever they are on your network.

## Limits

- **One bridge per Home Assistant instance.** Nothing breaks with two, but they
  would fight over port 8787.
- **The app version is pinned to the image.** Updating the add-on brings a newer
  app; the sidebar panel will not change until then.
- **Firefox is not a consideration here** — this is a server-side component.
- Anything on your network that has the pairing code can scan. Keep it to yourself,
  as you would a password.
