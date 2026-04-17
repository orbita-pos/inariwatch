/**
 * Tests for @inariwatch/capture FullTrace module (session id propagation).
 *
 * Run from web/ because capture has no test runner of its own and is linked
 * via `file:../capture`. We stub the browser globals manually rather than
 * pulling in jsdom — the surface fulltrace.ts touches is small enough that
 * a hand-rolled mock is faster and easier to reason about than a full DOM.
 *
 * What we assert:
 *   - The resolution order (window > cookie > storage > generate)
 *   - injectSessionHeader respects same-origin and the cross-origin opt-in
 *   - injectSessionHeader never mutates the caller's init or overwrites a
 *     header the caller explicitly set
 *   - SDK is a no-op outside the browser (server-side renders, edge runtime)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initFullTrace,
  getSessionId,
  setSessionId,
  injectSessionHeader,
  __resetFullTraceForTesting,
} from "@inariwatch/capture";

// ── Mutable browser stubs ──────────────────────────────────────────────────

let cookieStore = "";
const sessionStore = new Map<string, string>();
let windowGlobals: Record<string, unknown> = {};

function setupBrowser(opts?: { hostname?: string; protocol?: string }) {
  cookieStore = "";
  sessionStore.clear();
  windowGlobals = {};

  vi.stubGlobal("window", windowGlobals);
  vi.stubGlobal("document", {
    get cookie() { return cookieStore; },
    set cookie(v: string) {
      const [pair] = v.split(";");
      const [name, value] = pair.split("=");
      // Naive parser is fine — fulltrace only writes single name=value
      // pairs and never expects others to be merged. Real browser behavior
      // is a single-pair set per assignment.
      const without = cookieStore
        .split("; ")
        .filter((c) => !c.startsWith(`${name}=`))
        .filter(Boolean)
        .join("; ");
      cookieStore = without ? `${without}; ${name}=${value}` : `${name}=${value}`;
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => sessionStore.set(k, v),
    removeItem: (k: string) => sessionStore.delete(k),
  });
  vi.stubGlobal("location", {
    hostname: opts?.hostname ?? "app.inariwatch.com",
    protocol: opts?.protocol ?? "https:",
    href: `${opts?.protocol ?? "https:"}//${opts?.hostname ?? "app.inariwatch.com"}/`,
  });
}

function teardownBrowser() {
  vi.unstubAllGlobals();
  cookieStore = "";
  sessionStore.clear();
  windowGlobals = {};
}

beforeEach(() => {
  __resetFullTraceForTesting();
  teardownBrowser();
});

// ── Server-side / no-window behavior ───────────────────────────────────────

describe("server-side (no window)", () => {
  it("getSessionId returns null when uninitialized", () => {
    expect(getSessionId()).toBeNull();
  });

  it("initFullTrace is a no-op outside the browser", () => {
    initFullTrace();
    expect(getSessionId()).toBeNull();
  });

  it("injectSessionHeader returns the input init unchanged when no session is active", () => {
    const init = { method: "POST", body: "x" };
    expect(injectSessionHeader("/api/x", init)).toBe(init);
  });
});

// ── Resolution order ───────────────────────────────────────────────────────

describe("session id resolution order", () => {
  it("uses window.__INARIWATCH_SESSION__ when set (replay package compatibility)", () => {
    setupBrowser();
    (windowGlobals as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__ = "fromreplay123";

    initFullTrace();
    expect(getSessionId()).toBe("fromreplay123");
  });

  it("falls back to the iw_session cookie when no window var", () => {
    setupBrowser();
    cookieStore = "iw_session=fromcookie456";

    initFullTrace();
    expect(getSessionId()).toBe("fromcookie456");
  });

  it("falls back to sessionStorage when no window var or cookie", () => {
    setupBrowser();
    sessionStore.set("iw_session", "fromstorage789");

    initFullTrace();
    expect(getSessionId()).toBe("fromstorage789");
  });

  it("generates a new UUID when no source is present", () => {
    setupBrowser();
    initFullTrace();
    const id = getSessionId();
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("propagates the resolved id to all three storages so the next reader is fast", () => {
    setupBrowser();
    (windowGlobals as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__ = "winsource";

    initFullTrace();

    expect(cookieStore).toContain("iw_session=winsource");
    expect(sessionStore.get("iw_session")).toBe("winsource");
    expect((windowGlobals as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__).toBe("winsource");
  });

  it("is idempotent — calling initFullTrace twice keeps the same id", () => {
    setupBrowser();
    initFullTrace();
    const first = getSessionId();
    initFullTrace();
    expect(getSessionId()).toBe(first);
  });
});

// ── setSessionId ───────────────────────────────────────────────────────────

describe("setSessionId", () => {
  it("re-anchors the active id and writes it to all storages", () => {
    setupBrowser();
    initFullTrace();

    setSessionId("manualid12345");
    expect(getSessionId()).toBe("manualid12345");
    expect(cookieStore).toContain("iw_session=manualid12345");
    expect(sessionStore.get("iw_session")).toBe("manualid12345");
    expect((windowGlobals as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__).toBe("manualid12345");
  });

  it("ignores empty values (defensive — never null out an active session)", () => {
    setupBrowser();
    initFullTrace();
    const original = getSessionId();

    setSessionId("");
    expect(getSessionId()).toBe(original);
  });
});

// ── injectSessionHeader ────────────────────────────────────────────────────

describe("injectSessionHeader (same-origin behavior)", () => {
  beforeEach(() => {
    setupBrowser({ hostname: "app.inariwatch.com" });
    initFullTrace();
    setSessionId("session12345");
  });

  it("injects the header on relative URLs (always same-origin)", () => {
    const result = injectSessionHeader("/api/checkout");
    const headers = new Headers(result?.headers);
    expect(headers.get("X-IW-Session-Id")).toBe("session12345");
  });

  it("injects the header on absolute same-origin URLs", () => {
    const result = injectSessionHeader("https://app.inariwatch.com/api/x");
    const headers = new Headers(result?.headers);
    expect(headers.get("X-IW-Session-Id")).toBe("session12345");
  });

  it("does NOT inject on cross-origin URLs by default", () => {
    const init = { method: "POST" };
    const result = injectSessionHeader("https://api.stripe.com/v1/charges", init);
    expect(result).toBe(init); // same reference = unchanged
  });

  it("preserves caller-provided headers", () => {
    const result = injectSessionHeader("/api/x", {
      headers: { Authorization: "Bearer abc" },
    });
    const headers = new Headers(result?.headers);
    expect(headers.get("Authorization")).toBe("Bearer abc");
    expect(headers.get("X-IW-Session-Id")).toBe("session12345");
  });

  it("does NOT overwrite an X-IW-Session-Id header the caller explicitly set", () => {
    const result = injectSessionHeader("/api/x", {
      headers: { "X-IW-Session-Id": "callerset999" },
    });
    const headers = new Headers(result?.headers);
    expect(headers.get("X-IW-Session-Id")).toBe("callerset999");
  });

  it("never mutates the caller's init object", () => {
    const init: RequestInit = { method: "POST", headers: { Authorization: "Bearer abc" } };
    const initCopy = JSON.parse(JSON.stringify(init));

    injectSessionHeader("/api/x", init);

    expect(init).toEqual(initCopy);
  });
});

describe("injectSessionHeader (cross-origin opt-in)", () => {
  it("injects on cross-origin URLs when allowCrossOrigin is true", () => {
    setupBrowser({ hostname: "app.inariwatch.com" });
    initFullTrace({ allowCrossOrigin: true });
    setSessionId("crossorigin1");

    const result = injectSessionHeader("https://api.example.com/v1/data");
    const headers = new Headers(result?.headers);
    expect(headers.get("X-IW-Session-Id")).toBe("crossorigin1");
  });

  it("still injects on same-origin when allowCrossOrigin is true (no regression)", () => {
    setupBrowser({ hostname: "app.inariwatch.com" });
    initFullTrace({ allowCrossOrigin: true });
    setSessionId("crossorigin2");

    const result = injectSessionHeader("/api/x");
    const headers = new Headers(result?.headers);
    expect(headers.get("X-IW-Session-Id")).toBe("crossorigin2");
  });
});
