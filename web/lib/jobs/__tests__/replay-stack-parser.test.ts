import { describe, it, expect } from "vitest";
import { parseStack, aggregateErrors, buildGithubLink } from "../replay-stack-parser";

describe("parseStack", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseStack(null)).toEqual([]);
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("")).toEqual([]);
  });

  it("parses V8 stack with named function", () => {
    const stack = `TypeError: foo is undefined
    at handleClick (https://app.com/_next/static/chunks/abc.js:42:7)
    at https://app.com/_next/static/chunks/anon.js:1:1`;
    const out = parseStack(stack);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      fnName: "handleClick",
      source: "https://app.com/_next/static/chunks/abc.js",
      line: 42,
      col: 7,
      mapped: null,
    });
    expect(out[1].fnName).toBeNull();
    expect(out[1].source).toBe("https://app.com/_next/static/chunks/anon.js");
  });

  it("parses SpiderMonkey stack", () => {
    const stack = `handleClick@https://app.com/foo.js:42:7
@https://app.com/bar.js:1:1`;
    const out = parseStack(stack);
    expect(out).toHaveLength(2);
    expect(out[0].fnName).toBe("handleClick");
    expect(out[0].source).toBe("https://app.com/foo.js");
    expect(out[0].line).toBe(42);
  });

  it("drops unparseable lines", () => {
    const stack = `Error: thing
this is not a stack frame
    at fn (https://x.com/y.js:1:1)
random garbage`;
    expect(parseStack(stack)).toHaveLength(1);
  });

  it("caps frame count to defend against bombs", () => {
    const lines = ["Error: deep"]
      .concat(Array.from({ length: 100 }, (_, i) => `    at fn${i} (https://x/y.js:${i}:1)`))
      .join("\n");
    expect(parseStack(lines, 50)).toHaveLength(50);
  });

  it("col is null when missing", () => {
    const out = parseStack("    at fn (https://x.com/y.js:42)");
    expect(out[0].col).toBeNull();
  });
});

describe("aggregateErrors", () => {
  const BASE = 1_700_000_000_000;

  it("groups by fingerprint and counts", () => {
    const out = aggregateErrors(
      [
        { fingerprint: "a", timestamp: BASE + 100, message: "first" },
        { fingerprint: "a", timestamp: BASE + 500, message: "second (ignored)" },
        { fingerprint: "b", timestamp: BASE + 200, message: "other" },
      ],
      BASE,
    );
    expect(out).toHaveLength(2);
    const a = out.find((e) => e.fingerprint === "a")!;
    expect(a.count).toBe(2);
    expect(a.message).toBe("first"); // first wins
    expect(a.firstTimestamp).toBe(100);
  });

  it("sorts by firstTimestamp ascending", () => {
    const out = aggregateErrors(
      [
        { fingerprint: "late", timestamp: BASE + 5000, message: "" },
        { fingerprint: "early", timestamp: BASE + 100, message: "" },
        { fingerprint: "mid", timestamp: BASE + 1000, message: "" },
      ],
      BASE,
    );
    expect(out.map((e) => e.fingerprint)).toEqual(["early", "mid", "late"]);
  });

  it("parses stacks of the first occurrence", () => {
    const out = aggregateErrors(
      [
        {
          fingerprint: "x",
          timestamp: BASE,
          message: "boom",
          stack: "Error: boom\n    at fn (https://app.com/foo.js:1:1)",
        },
      ],
      BASE,
    );
    expect(out[0].frames).toHaveLength(1);
    expect(out[0].frames[0].source).toBe("https://app.com/foo.js");
  });

  it("clamps negative relative timestamps to 0", () => {
    const out = aggregateErrors(
      [{ fingerprint: "x", timestamp: BASE - 1000, message: "early" }],
      BASE,
    );
    expect(out[0].firstTimestamp).toBe(0);
  });
});

describe("buildGithubLink", () => {
  const repo = { githubOwner: "orbita", githubRepo: "demo", branch: "main" };

  it("builds blob URL from absolute source URL", () => {
    expect(
      buildGithubLink({ source: "https://app.com/app/page.tsx", line: 42, ...repo }),
    ).toBe("https://github.com/orbita/demo/blob/main/app/page.tsx#L42");
  });

  it("works for repo-relative source paths", () => {
    expect(
      buildGithubLink({ source: "/app/page.tsx", line: 7, ...repo }),
    ).toBe("https://github.com/orbita/demo/blob/main/app/page.tsx#L7");
  });

  it("returns null for bundler chunks", () => {
    expect(
      buildGithubLink({
        source: "https://app.com/_next/static/chunks/abc.js",
        line: 1,
        ...repo,
      }),
    ).toBeNull();
  });

  it("returns null for browser-extension origins", () => {
    expect(
      buildGithubLink({
        source: "chrome-extension://aaa/foo.js",
        line: 1,
        ...repo,
      }),
    ).toBeNull();
  });

  it("returns null when source or repo info missing", () => {
    expect(buildGithubLink({ source: "", line: 1, ...repo })).toBeNull();
    expect(buildGithubLink({ source: "/x", line: 1, githubOwner: "", githubRepo: "" })).toBeNull();
  });

  it("defaults branch to main", () => {
    expect(
      buildGithubLink({ source: "/x.ts", line: 5, githubOwner: "o", githubRepo: "r" }),
    ).toContain("/blob/main/");
  });
});
