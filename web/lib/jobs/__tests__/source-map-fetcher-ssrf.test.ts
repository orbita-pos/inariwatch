import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSourceMaps } from "../source-map-fetcher";

/**
 * Regression tests for the SSRF gate added after the post-implementation
 * security review. The fetcher resolves a JS URL from a user-submitted
 * stack frame into `<url>.map` and fetches it server-side — without the
 * `isSafeUrl` gate this would reach IMDS / RFC1918 / loopback.
 *
 * We intercept `global.fetch` to prove that for blocked URLs the fetcher
 * NEVER calls fetch at all (returns null via the "skipped" branch before
 * network), and for allowed URLs it DOES call fetch.
 */

describe("source-map-fetcher SSRF gate", () => {
  const originalFetch = global.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Simulate a harmless 404 so the resolver returns `raw: null` for
    // any URL that DID make it past the gate. The point is to observe
    // WHETHER fetch was called, not what it returned.
    fetchSpy = vi.fn(async () => new Response("", { status: 404 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const DENIED = [
    // AWS / Azure / GCP instance metadata
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/role.js",
    // RFC1918 private ranges
    "http://10.0.0.5:6379/chunk.js",
    "http://192.168.1.1/bundle.js",
    "http://172.16.0.10/chunk.js",
    // Loopback
    "http://localhost:5432/app.js",
    "http://127.0.0.1:8080/main.js",
    // Internal TLDs
    "http://kubernetes.default.svc/api.js",
    "http://my-service.internal/bundle.js",
    // Octal / decimal IP encodings (cloud-metadata bypass)
    "http://0177.0.0.1/admin.js",
    "http://2130706433/admin.js",
  ];

  it.each(DENIED)("never fetches %s", async (url) => {
    const out = await fetchSourceMaps([url]);
    expect(out.get(url)).toBeNull();
    // Critical assertion — fetch was never even attempted
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a legitimate public HTTPS URL to reach fetch", async () => {
    const out = await fetchSourceMaps(["https://app.example.com/bundle.js"]);
    // Map URL ends with .js.map; the 404 mock means `raw` ends up null,
    // BUT fetch WAS called (gate allowed it through).
    expect(out.get("https://app.example.com/bundle.js")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toBe("https://app.example.com/bundle.js.map");
  });

  it("rejects non-http(s) schemes (javascript:, file:, data:) before the gate", async () => {
    const out = await fetchSourceMaps([
      "javascript:alert(1).js",
      "file:///etc/passwd.js",
      "data:text/javascript,alert(1).js",
    ]);
    // None should have been fetched
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.size).toBe(3);
    for (const v of out.values()) expect(v).toBeNull();
  });

  it("rejects URLs without a .js suffix (nothing maps to .map)", async () => {
    await fetchSourceMaps(["https://app.example.com/styles.css"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
