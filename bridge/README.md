# Scanlet scanning bridge

One file, no dependencies, Node 18+.

```sh
node scanlet-bridge.mjs
# → Scanlet bridge 1.0.0
# → Listening on http://127.0.0.1:8787
```

Then open Scanlet, press **Scanner**, and press **Connect**.

## Why it exists

A browser cannot open a TCP socket to a printer and cannot send mDNS queries, so
real pull scanning needs a process outside the sandbox. This one discovers
scanners over Bonjour and drives them with **eSCL / AirScan** — the driverless
protocol Apple AirScan and SANE's `escl` backend use. No vendor drivers, no SDKs.

It binds to `127.0.0.1` only, talks only to printers on the local network, and
keeps nothing on disk.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, version and the current device list |
| `GET` | `/printers` | re-scan (add `?refresh` to force) |
| `POST` | `/probe` | reach a device by address: `{ "address": "192.168.1.42:80" }` |
| `GET` | `/printers/:id/capabilities` | normalised sources, colour modes, resolutions, duplex |
| `POST` | `/printers/:id/scan` | run a job; responds with one image part per page |

Scan options: `resolution`, `colorMode` (`RGB24` / `Grayscale8` /
`BlackAndWhite1`), `inputSource` (`Platen` / `Feeder`), `duplex`, `format`,
`pageSize`.

The scan response is `multipart/mixed`, one part per page, so a multi-sheet ADF job
arrives as a single response. Every route answers CORS preflights — including
`Access-Control-Allow-Private-Network`, which Chrome's Local Network Access
permission requires.

## Flags

```
--lan          listen on the network and serve Scanlet to other devices
--tls          serve over https with a generated self-signed certificate
--port <n>     default 8787
--host <ip>    default 127.0.0.1
--name <label> the Bonjour name to advertise (and answer to, as <label>.local)
--quiet        log nothing
```

With `--lan` there is no pairing code: anyone who can reach the bridge can scan, so
the network itself is the boundary. Keep port 8787 off the public internet.

## Development

```sh
node test/mock-scanner.mjs --render     # fake eSCL scanner with rendered pages
node test/bridge.test.mjs               # end-to-end test against that mock
```

The test drives the real HTTP API with the real client module
(`../assets/js/bridge.js`), so the multipart parsing the browser relies on is
covered too.
