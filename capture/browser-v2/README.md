# @inariwatch/capture-browser (v2)

Browser SDK for [InariWatch](https://inariwatch.com).

Payload-compatible with the Node, Python, Go, Rust, Java, and C# SDKs in this monorepo. Same DSN, same event schema, **byte-identical fingerprint algorithm** so an error in the browser dedupes against the same error thrown in any backend service.

## Quick start

```html
<script type="module">
  import { init, captureException } from "https://cdn.example.com/@inariwatch/capture-browser/dist/index.js";

  init({
    dsn: "https://SECRET@app.inariwatch.com/capture/PROJECT_ID",
    environment: "production",
    release: "1.0.0",
  });

  window.addEventListener("error", (e) => captureException(e.error));
</script>
```

## What's in v2 vs v1

- **FullTrace session correlation** — `X-IW-Session-Id` header is auto-attached to every fetch/XHR, so backend events from the same user session correlate to the front-end event that triggered them.
- **Web Vitals** — LCP, FID, CLS, INP, TTFB are captured as breadcrumbs on every nav.
- **Fetch/XHR auto-intercept** — every HTTP call becomes a breadcrumb (URL scrubbed, secrets stripped).
- **Service Worker offline buffering** — events queued when offline and flushed when the connection returns.

## Auto-init

Drop `import "@inariwatch/capture-browser/auto"` and the SDK reads `window.__INARIWATCH__.dsn` (or a `meta[name="inariwatch:dsn"]` tag) and starts.

## License

MIT.
