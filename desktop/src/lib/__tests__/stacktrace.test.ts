import { describe, expect, it } from "vitest";

import {
  firstLocation,
  parseStacktraceLines,
  segmentByLocations,
} from "@/lib/stacktrace";

describe("parseStacktraceLines", () => {
  it("parses a Node V8 frame with function name", () => {
    const text =
      "TypeError: Cannot read property 'x' of undefined\n" +
      "    at handler (/srv/app/server.js:42:13)";
    const { matches } = parseStacktraceLines(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      file: "/srv/app/server.js",
      line: 42,
      col: 13,
      fn: "handler",
    });
  });

  it("parses multiple V8 frames in source order", () => {
    const text = [
      "    at outer (/srv/a.js:10:1)",
      "    at inner (/srv/b.js:20:1)",
      "    at deepest (/srv/c.js:30:1)",
    ].join("\n");
    const { matches } = parseStacktraceLines(text);
    expect(matches.map((m) => m.file)).toEqual([
      "/srv/a.js",
      "/srv/b.js",
      "/srv/c.js",
    ]);
    expect(matches.map((m) => m.line)).toEqual([10, 20, 30]);
  });

  it("parses a Python traceback", () => {
    const text =
      'Traceback (most recent call last):\n  File "/srv/app/main.py", line 88, in <module>\n    foo()';
    const { matches } = parseStacktraceLines(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      file: "/srv/app/main.py",
      line: 88,
    });
  });

  it("parses linter-style location with column", () => {
    const text = "src/lib/foo.ts:17:5: error TS2304: Cannot find name 'x'.";
    const { matches } = parseStacktraceLines(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      file: "src/lib/foo.ts",
      line: 17,
      col: 5,
    });
  });

  it("parses rustc-style location without column", () => {
    const text = "error: cannot move out of `x` in src/main.rs:9:1";
    const { matches } = parseStacktraceLines(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.file).toBe("src/main.rs");
    expect(matches[0]?.line).toBe(9);
  });

  it("parses Windows drive-letter paths", () => {
    const text = "    at handler (C:\\Users\\jesus\\src\\foo.rs:42:8)";
    const { matches } = parseStacktraceLines(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.file).toBe("C:\\Users\\jesus\\src\\foo.rs");
    expect(matches[0]?.line).toBe(42);
  });

  it("returns no matches for prose without locations", () => {
    expect(parseStacktraceLines("the alert says version 1.0:0 broke").matches).toEqual([]);
    expect(parseStacktraceLines("nothing here").matches).toEqual([]);
  });

  it("returns no matches for an empty string", () => {
    expect(parseStacktraceLines("").matches).toEqual([]);
  });

  it("does not double-match a single V8 location across patterns", () => {
    const text = "    at handler (/srv/app/server.js:42:13)";
    const { matches } = parseStacktraceLines(text);
    expect(matches).toHaveLength(1);
  });

  it("preserves raw lines so renderer can rebuild text", () => {
    const text = "line one\nline two\nline three";
    const { raw } = parseStacktraceLines(text);
    expect(raw).toEqual(["line one", "line two", "line three"]);
  });
});

describe("firstLocation", () => {
  it("returns the first location encountered", () => {
    const text =
      "    at outer (/srv/a.js:10:1)\n    at inner (/srv/b.js:20:1)";
    const loc = firstLocation(text);
    expect(loc?.file).toBe("/srv/a.js");
    expect(loc?.line).toBe(10);
  });

  it("returns null when no location is present", () => {
    expect(firstLocation("nothing here")).toBeNull();
    expect(firstLocation("")).toBeNull();
  });
});

describe("segmentByLocations", () => {
  it("returns a single text segment when no location matches", () => {
    const segs = segmentByLocations("plain prose, no path");
    expect(segs).toEqual([{ kind: "text", text: "plain prose, no path" }]);
  });

  it("returns an empty array for empty input", () => {
    expect(segmentByLocations("")).toEqual([]);
  });

  it("splits prose around a single location", () => {
    const text = "before src/x.ts:7:3 after";
    const segs = segmentByLocations(text);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: "text", text: "before " });
    expect(segs[1]).toMatchObject({
      kind: "location",
      location: { file: "src/x.ts", line: 7, col: 3 },
    });
    expect(segs[2]).toEqual({ kind: "text", text: " after" });
  });

  it("splits prose around two consecutive locations", () => {
    const text =
      "    at outer (/srv/a.js:10:1)\n    at inner (/srv/b.js:20:1)";
    const segs = segmentByLocations(text);
    // Expect: text + loc + text + loc + (optional trailing text)
    const locs = segs.filter((s) => s.kind === "location");
    expect(locs).toHaveLength(2);
    const recombined = segs
      .map((s) => (s.kind === "text" ? s.text : s.location.raw))
      .join("");
    expect(recombined).toBe(text);
  });
});
