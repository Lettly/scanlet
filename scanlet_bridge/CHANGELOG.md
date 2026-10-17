# Changelog

## 1.0.0

- First release: the Scanlet bridge as a Home Assistant add-on.
- Scanlet appears in the sidebar over Home Assistant's https, and pairs itself
  through ingress — no address, no pairing code.
- A network listener on port 8787 for Shortcuts, Tasker, `curl` and the browser
  extension, guarded by a pairing code.
- Advertises itself over Bonjour as `_scanlet._tcp`, so `tools/find-bridge.mjs`
  and `dns-sd` can find it without reading logs.
- The pairing code is generated once and kept in `/data/scanlet-token`.
