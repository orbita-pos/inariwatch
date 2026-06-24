/**
 * Visual Report module tests — verifies the integration shape, ring buffers,
 * and capture-context output without booting a real browser. We mock the
 * minimum globals (window, document, performance, console patching points)
 * to exercise the public surface end-to-end in a Node process.
 *
 * Run from `capture/`:
 *   npm run build && node --test test/visual-report.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── Browser-like global setup ────────────────────────────────────────────────

function installBrowserGlobals() {
  const listeners = new Map();
  const fakeDoc = {
    readyState: "complete",
    addEventListener: (ev, cb) => listeners.set(ev, cb),
    querySelector: () => null,
    activeElement: null,
    body: null,
  };
  const fakeWin = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    location: { href: "https://example.com/dashboard?token=abc&page=2#anchor" },
    addEventListener: () => {},
    fetch: undefined,
    XMLHttpRequest: undefined,
    __NEXT_DATA__: { buildId: "build-xyz" },
  };
  const fakePerf = {
    now: () => Date.now(),
    getEntriesByType: () => [],
    memory: { usedJSHeapSize: 10_000_000, totalJSHeapSize: 50_000_000, jsHeapSizeLimit: 500_000_000 },
  };
  // Some globals (navigator) are non-writable in newer Node — use
  // defineProperty so we can replace them per test.
  const define = (key, value) => {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  };
  define("window", fakeWin);
  define("document", fakeDoc);
  define("location", fakeWin.location);
  define("navigator", { userAgent: "TestAgent/1.0" });
  define("performance", fakePerf);
  define("PerformanceObserver", undefined);
}

function teardownBrowserGlobals() {
  for (const key of ["window", "document", "location", "navigator", "performance", "PerformanceObserver"]) {
    try {
      Object.defineProperty(globalThis, key, {
        value: undefined,
        writable: true,
        configurable: true,
      });
    } catch {
      // Some Node versions lock certain globals — best effort.
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("visualReportIntegration: returns an Integration with name='VisualReport'", async () => {
  installBrowserGlobals();
  try {
    const { visualReportIntegration } = await import("../dist/visual-report/index.js");
    const integ = visualReportIntegration({});
    assert.equal(integ.name, "VisualReport");
    assert.equal(typeof integ.setup, "function");
  } finally {
    teardownBrowserGlobals();
  }
});

test("visualReportIntegration: setup() is a no-op on the server (no window)", async () => {
  // No browser globals installed.
  const { visualReportIntegration } = await import("../dist/visual-report/index.js");
  const integ = visualReportIntegration({});
  // Must not throw.
  integ.setup({});
});

test("rings: console ring captures recent entries, capped at 50", async () => {
  installBrowserGlobals();
  try {
    const { installConsoleRing, readConsoleRing } = await import("../dist/visual-report/rings.js");
    installConsoleRing();
    installConsoleRing(); // idempotent — must not double-patch

    for (let i = 0; i < 60; i++) {
      console.log(`test entry ${i}`);
    }
    const ring = readConsoleRing();
    assert.ok(ring.length <= 50, `ring should be capped at 50, got ${ring.length}`);
    assert.equal(ring[ring.length - 1].args[0], "test entry 59");
    assert.equal(ring[ring.length - 1].level, "log");
  } finally {
    teardownBrowserGlobals();
  }
});

test("rings: network ring captures fetch calls + status", async () => {
  installBrowserGlobals();
  try {
    let fetchCalls = 0;
    globalThis.window.fetch = async () => {
      fetchCalls++;
      return new Response("{}", { status: 201 });
    };
    const { installNetworkRing, readNetworkRing } = await import("../dist/visual-report/rings.js");
    installNetworkRing();

    await globalThis.window.fetch("https://api.example.com/widgets", { method: "POST" });
    await globalThis.window.fetch("https://api.example.com/items");

    assert.equal(fetchCalls, 2);
    const ring = readNetworkRing();
    const fetchEntries = ring.filter((e) => e.source === "fetch");
    assert.equal(fetchEntries.length, 2);
    assert.equal(fetchEntries[0].url, "https://api.example.com/widgets");
    assert.equal(fetchEntries[0].method, "POST");
    assert.equal(fetchEntries[0].status, 201);
    assert.equal(fetchEntries[1].method, "GET");
  } finally {
    teardownBrowserGlobals();
  }
});

test("captureContext: produces a bundle with url, viewport, buildId, capturedAt", async () => {
  installBrowserGlobals();
  try {
    const { captureContext } = await import("../dist/visual-report/capture-context.js");
    const bundle = await captureContext();

    // Hash + sensitive query stripping
    assert.ok(!bundle.url.includes("#"));
    assert.ok(bundle.url.includes("token=%5Bredacted%5D") || bundle.url.includes("token=[redacted]"));

    assert.deepEqual(bundle.viewport, { width: 1280, height: 800, dpr: 2 });
    assert.equal(bundle.buildId, "build-xyz");
    assert.equal(typeof bundle.capturedAt, "number");
    assert.equal(bundle.userAgent, "TestAgent/1.0");
    assert.equal(typeof bundle.captureMs, "number");

    assert.ok(Array.isArray(bundle.console));
    assert.ok(Array.isArray(bundle.network));

    assert.ok(bundle.memory);
    assert.equal(bundle.memory.used, 10_000_000);
  } finally {
    teardownBrowserGlobals();
  }
});

test("upload: returns ok:false with helpful error when token missing", async () => {
  // No browser globals; uploadVisualReport runs anywhere fetch exists.
  const { uploadVisualReport } = await import("../dist/visual-report/upload.js");
  const result = await uploadVisualReport({
    config:      {},                                  // no token, no DSN
    screenshot:  "data:image/webp;base64,XYZ",
    description: "test",
    bundle:      /** @type {any} */ ({
      url: "https://x",
      userAgent: "",
      viewport: { width: 0, height: 0, dpr: 1 },
      buildId: null,
      capturedAt: 0,
      focused: null,
      console: [],
      network: [],
      captureMs: 0,
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /token/i);
});

test("upload: returns ok:false with helpful error when projectId missing", async () => {
  const { uploadVisualReport } = await import("../dist/visual-report/upload.js");
  const result = await uploadVisualReport({
    config:      { token: "iwk_pub_v1_AAAAAAAAAAAA" },  // token but no projectId
    screenshot:  "data:image/webp;base64,XYZ",
    description: "test",
    bundle:      /** @type {any} */ ({
      url: "https://x",
      userAgent: "",
      viewport: { width: 0, height: 0, dpr: 1 },
      buildId: null,
      capturedAt: 0,
      focused: null,
      console: [],
      network: [],
      captureMs: 0,
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /projectId/i);
});

test("upload: parses token + projectId + host from DSN URL", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({ ok: true, reportId: "r1", alertId: "a1" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const { uploadVisualReport } = await import("../dist/visual-report/upload.js");
    const result = await uploadVisualReport({
      config: {
        dsn: "https://iwk_pub_v1_BBBBBBBBBBBB@example.com/capture/11111111-2222-3333-4444-555555555555",
      },
      screenshot:  "data:image/webp;base64,XYZ",
      description: "modal won't close",
      bundle:      /** @type {any} */ ({
        url: "https://x",
        userAgent: "",
        viewport: { width: 0, height: 0, dpr: 1 },
        buildId: null,
        capturedAt: 0,
        focused: null,
        console: [],
        network: [],
        captureMs: 5,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.reportId, "r1");
    assert.equal(result.alertId, "a1");
    assert.equal(
      captured.url,
      "https://example.com/api/capture/user-report/11111111-2222-3333-4444-555555555555",
    );
    assert.equal(captured.init.headers["Authorization"], "Bearer iwk_pub_v1_BBBBBBBBBBBB");
    assert.equal(captured.init.method, "POST");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.description, "modal won't close");
    assert.equal(body.screenshot, "data:image/webp;base64,XYZ");
  } finally {
    if (origFetch) globalThis.fetch = origFetch;
    else delete globalThis.fetch;
  }
});
