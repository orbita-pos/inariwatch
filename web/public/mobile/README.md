# Mobile PWA static assets (S12)

- `manifest.webmanifest` — W3C app manifest. Linked from `/mobile/layout.tsx`.
- `sw.js` — service worker (cache shell + web-push handler).
- `icon.svg` — design source for the maskable icon. Convert to:
  - `icon-192.png` (192×192)
  - `icon-512.png` (512×512)
  using `npx sharp-cli` or any SVG → PNG tool. PNGs are the format
  required by the PWA install flow on Android Chrome / iOS Safari;
  the SVG alone is not accepted as a maskable icon.

The two PNGs are not committed because we don't have final art yet —
the install prompt still works without them on Chrome (falls back to
the favicon) but iOS Safari needs them for add-to-home-screen.
Replace the `icon.svg` then export PNGs before shipping.
