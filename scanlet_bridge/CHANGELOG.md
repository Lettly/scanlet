# Changelog

## 1.1.1

- **Only offer a scanner it can actually drive.** A `_scanner._tcp` advert is
  only a guess at eSCL — some devices publish it for their own protocol (a
  Samsung M2070 does) — so the bridge now confirms each such device answers
  eSCL before listing it.
- A device that answers with a non-HTTP protocol no longer surfaces Node's
  cryptic *"Parse Error: Expected HTTP/, RTSP/ or ICE/"*; it is reported as not
  being a driverless scanner.

## 1.1.0

- **No more pairing codes.** The network is the only security: the add-on answers
  any device that can reach it, on the sidebar panel and on port 8787 alike. The
  `token` option is gone, and nothing is seeded into the panel any more.
- Scanlet finds the bridge on its own — the sidebar panel talks to it behind Home
  Assistant's ingress path, and any other device on the network finds it at
  `home-assistant.local` or through Scanlet's network sweep.

## 1.0.0

- First release: the Scanlet bridge as a Home Assistant add-on.
- Scanlet appears in the sidebar over Home Assistant's https, and pairs itself
  through ingress — no address, no pairing code.
- A network listener on port 8787 for Shortcuts, Tasker, `curl` and the browser
  extension, guarded by a pairing code.
- Advertises itself over Bonjour as `_scanlet._tcp`, so `tools/find-bridge.mjs`
  and `dns-sd` can find it without reading logs.
- The pairing code is generated once and kept in `/data/scanlet-token`.
