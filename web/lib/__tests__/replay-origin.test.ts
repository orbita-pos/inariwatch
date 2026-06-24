import { describe, it, expect } from "vitest";
import { isOriginAllowed, validateAllowedOriginEntry } from "../replay-origin";

describe("isOriginAllowed — backward compatibility", () => {
  it("allows any Origin when the allowlist is empty", () => {
    const decision = isOriginAllowed("https://attacker.example", []);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("no-allowlist");
  });

  it("allows any Origin when the allowlist is null / undefined", () => {
    expect(isOriginAllowed("https://foo.com", null).allowed).toBe(true);
    expect(isOriginAllowed("https://foo.com", undefined).allowed).toBe(true);
  });

  it("allows a missing Origin when the allowlist is empty (pre-0048 behaviour)", () => {
    expect(isOriginAllowed(null, []).allowed).toBe(true);
    expect(isOriginAllowed(undefined, []).allowed).toBe(true);
  });
});

describe("isOriginAllowed — exact match", () => {
  it("matches when scheme+host+port align", () => {
    const d = isOriginAllowed("https://app.example.com", ["https://app.example.com"]);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("exact-match");
  });

  it("collapses default ports so https://foo.com === https://foo.com:443", () => {
    expect(isOriginAllowed("https://foo.com:443", ["https://foo.com"]).allowed).toBe(true);
    expect(isOriginAllowed("https://foo.com", ["https://foo.com:443"]).allowed).toBe(true);
    expect(isOriginAllowed("http://foo.com:80", ["http://foo.com"]).allowed).toBe(true);
  });

  it("treats non-default ports as distinct", () => {
    expect(isOriginAllowed("https://foo.com:8443", ["https://foo.com"]).allowed).toBe(false);
  });

  it("rejects scheme mismatches (http vs https)", () => {
    expect(isOriginAllowed("http://foo.com", ["https://foo.com"]).allowed).toBe(false);
  });

  it("rejects different hosts", () => {
    expect(isOriginAllowed("https://evil.com", ["https://app.example.com"]).allowed).toBe(false);
  });

  it("is case-insensitive on host", () => {
    expect(isOriginAllowed("https://APP.Example.COM", ["https://app.example.com"]).allowed).toBe(true);
  });

  it("strips the trailing FQDN dot so example.com. === example.com", () => {
    // An attacker could otherwise send Origin: https://legit.com. to bypass an
    // entry stored as https://legit.com.
    expect(isOriginAllowed("https://legit.com.", ["https://legit.com"]).allowed).toBe(true);
    expect(isOriginAllowed("https://legit.com", ["https://legit.com."]).allowed).toBe(true);
  });

  it("trims and ignores empty entries in the allowlist", () => {
    const list = ["  ", "", "https://foo.com  "];
    // Empty strings are stripped; the trimmed https://foo.com remains.
    expect(isOriginAllowed("https://foo.com", list).allowed).toBe(true);
  });
});

describe("isOriginAllowed — wildcard subdomain", () => {
  const list = ["https://*.example.com"];

  it("matches a single subdomain label", () => {
    const d = isOriginAllowed("https://api.example.com", list);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("wildcard-match");
  });

  it("matches multi-label subdomains", () => {
    expect(isOriginAllowed("https://api.staging.example.com", list).allowed).toBe(true);
  });

  it("does NOT match the bare root domain", () => {
    expect(isOriginAllowed("https://example.com", list).allowed).toBe(false);
  });

  it("does NOT match unrelated hosts that happen to end in example.com", () => {
    expect(isOriginAllowed("https://fakeexample.com", list).allowed).toBe(false);
    expect(isOriginAllowed("https://example.com.evil.com", list).allowed).toBe(false);
  });

  it("respects scheme and port on wildcard entries", () => {
    expect(isOriginAllowed("http://api.example.com", list).allowed).toBe(false);
    expect(isOriginAllowed("https://api.example.com:8443", list).allowed).toBe(false);
  });

  it("combines wildcard + exact in the same list", () => {
    const combo = ["https://example.com", "https://*.example.com"];
    expect(isOriginAllowed("https://example.com", combo).allowed).toBe(true);
    expect(isOriginAllowed("https://api.example.com", combo).allowed).toBe(true);
    expect(isOriginAllowed("https://attacker.com", combo).allowed).toBe(false);
  });
});

describe("isOriginAllowed — error cases", () => {
  it("rejects when Origin is missing and allowlist is populated", () => {
    const d = isOriginAllowed(null, ["https://foo.com"]);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("missing-origin");
  });

  it("rejects when Origin cannot be parsed", () => {
    const d = isOriginAllowed("not a url", ["https://foo.com"]);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("invalid-origin");
  });

  it("rejects any Origin once the list is populated but nothing matches", () => {
    const d = isOriginAllowed("https://attacker.example", ["https://legit.com"]);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("not-in-allowlist");
  });
});

describe("validateAllowedOriginEntry", () => {
  it("accepts well-formed entries", () => {
    expect(validateAllowedOriginEntry("https://app.example.com")).toBeNull();
    expect(validateAllowedOriginEntry("http://localhost:3000")).toBeNull();
    expect(validateAllowedOriginEntry("https://*.example.com")).toBeNull();
    expect(validateAllowedOriginEntry("  https://app.example.com  ")).toBeNull();
  });

  it("rejects missing scheme", () => {
    expect(validateAllowedOriginEntry("app.example.com")).toMatch(/http/);
  });

  it("rejects empty / whitespace entries", () => {
    expect(validateAllowedOriginEntry("")).toMatch(/Empty/);
    expect(validateAllowedOriginEntry("   ")).toMatch(/Empty/);
    expect(validateAllowedOriginEntry("https://foo .com")).toMatch(/Whitespace/);
  });

  it("rejects multiple wildcards", () => {
    expect(validateAllowedOriginEntry("https://*.*.example.com")).toMatch(/Only one/);
  });

  it("rejects wildcard anywhere other than the host prefix", () => {
    expect(validateAllowedOriginEntry("https://api.*.example.com")).toMatch(/start of the host/);
  });

  it("rejects too-broad wildcards like *.com", () => {
    expect(validateAllowedOriginEntry("https://*.com")).toMatch(/too broad/);
  });

  it("rejects entries with paths / queries / fragments", () => {
    expect(validateAllowedOriginEntry("https://foo.com/path")).toMatch(/Path/);
    expect(validateAllowedOriginEntry("https://foo.com?x=1")).toMatch(/Query/);
    expect(validateAllowedOriginEntry("https://foo.com#frag")).toMatch(/Fragment/);
  });

  it("rejects values that are too long", () => {
    expect(validateAllowedOriginEntry("https://" + "a".repeat(300))).toMatch(/too long/);
  });
});
