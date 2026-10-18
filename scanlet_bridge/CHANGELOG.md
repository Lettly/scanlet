# Changelog

## 1.2.1

- **No more "not a driverless scanner" surprise.** A device the bridge finds but
  proves cannot answer eSCL (some publish `_scanner._tcp` for their own protocol)
  stays in the list, greyed, with the reason — instead of failing when it is
  picked.

## 1.2.0

- **Driver scanners, via SANE.** The image now carries `scanimage` (`sane-utils`)
  and `sane-airscan`, so the bridge lists and scans a scanner that has only a
  Linux driver — a Samsung M2070, say — as well as the driverless eSCL/AirScan
  kind. A vendor backend (Samsung's own) is not redistributable and stays the
  operator's to add. The base image moved from Alpine to Debian to carry this.

## 1.1.2

- **List every device the network advertises again.** Hiding a `_scanner._tcp`
  device that does not answer eSCL made a working printer look lost; it is shown
  again, and selecting it explains plainly that it is not a driverless scanner.

## 1.1.1

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
