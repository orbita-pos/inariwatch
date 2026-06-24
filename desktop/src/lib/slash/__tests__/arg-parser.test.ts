import { describe, expect, it } from "vitest";

import {
  completeEnumValue,
  filterEnumValues,
  parseEnumContext,
} from "../arg-parser";

describe("parseEnumContext", () => {
  it("returns null for non-slash input", () => {
    expect(parseEnumContext("hello world")).toBeNull();
    expect(parseEnumContext("")).toBeNull();
  });

  it("returns null when no args have been typed yet", () => {
    expect(parseEnumContext("/projects")).toBeNull();
  });

  it("returns null when args contain no recognised flag", () => {
    expect(parseEnumContext("/projects --foo=bar")).toBeNull();
  });

  it("returns null when the flag's arg type is not enum", () => {
    // `/install <path>` has only a positional path arg — no flags, so
    // no enum context can match. Confirm this returns null even when
    // the input looks flag-like.
    expect(parseEnumContext("/install --path=C:/x")).toBeNull();
  });

  it("returns null when the command is not in the manifest", () => {
    expect(parseEnumContext("/notarealcmd --integration=capture")).toBeNull();
  });

  it("activates for /projects --integration= with empty partial", () => {
    const ctx = parseEnumContext("/projects --integration=");
    expect(ctx).not.toBeNull();
    expect(ctx!.arg.flag).toBe("integration");
    expect(ctx!.partial).toBe("");
    expect(ctx!.valueStart).toBe("/projects --integration=".length);
    expect(ctx!.valueEnd).toBe("/projects --integration=".length);
  });

  it("captures the partial value when the user has started typing", () => {
    const ctx = parseEnumContext("/projects --integration=cap");
    expect(ctx).not.toBeNull();
    expect(ctx!.partial).toBe("cap");
    expect(ctx!.valueStart).toBe(
      "/projects --integration=cap".length - 3,
    );
    expect(ctx!.valueEnd).toBe("/projects --integration=cap".length);
  });

  it("is case-insensitive on the flag name", () => {
    const ctx = parseEnumContext("/projects --Integration=Cap");
    expect(ctx).not.toBeNull();
    // Partial keeps the original case to splice-replace cleanly later,
    // but the parser stores its lower-cased form for filtering.
    expect(ctx!.partial).toBe("cap");
  });

  it("closes once whitespace appears after the value", () => {
    expect(parseEnumContext("/projects --integration=capture ")).toBeNull();
  });

  it("activates on /theme --mode=... (utility enum example)", () => {
    // Theme uses a positional enum (no flag) — confirm the parser
    // does NOT misfire for positional enums. Only --flag= form
    // matches; positional args fall through to the normal slash flow.
    expect(parseEnumContext("/theme dark")).toBeNull();
  });

  it("does not match when the equals sign is missing", () => {
    expect(parseEnumContext("/projects --integration")).toBeNull();
  });

  it("does not match when the leading -- is missing", () => {
    expect(parseEnumContext("/projects integration=capture")).toBeNull();
  });

  it("requires whitespace before --flag (not glued to command)", () => {
    expect(parseEnumContext("/projects--integration=capture")).toBeNull();
  });
});

describe("filterEnumValues", () => {
  it("returns every enum value when partial is empty", () => {
    const ctx = parseEnumContext("/projects --integration=")!;
    const filtered = filterEnumValues(ctx);
    expect(filtered).toContain("capture");
    expect(filtered).toContain("vercel");
    expect(filtered).toContain("github");
    expect(filtered.length).toBe(7);
  });

  it("filters by includes (case-insensitive)", () => {
    const ctx = parseEnumContext("/projects --integration=cap")!;
    expect(filterEnumValues(ctx)).toEqual(["capture"]);
  });

  it("returns empty when nothing matches", () => {
    const ctx = parseEnumContext("/projects --integration=zzz")!;
    expect(filterEnumValues(ctx)).toEqual([]);
  });

  it("matches mid-string (not just prefix)", () => {
    // Add a value containing 'er' to exercise mid-string include:
    // 'vercel' has 'er' at index 1.
    const ctx = parseEnumContext("/projects --integration=er")!;
    const result = filterEnumValues(ctx);
    expect(result).toContain("vercel");
  });
});

describe("completeEnumValue", () => {
  it("splices the value in place of the partial + adds trailing space", () => {
    const input = "/projects --integration=cap";
    const ctx = parseEnumContext(input)!;
    expect(completeEnumValue(input, ctx, "capture")).toBe(
      "/projects --integration=capture ",
    );
  });

  it("handles empty partial (user just typed =)", () => {
    const input = "/projects --integration=";
    const ctx = parseEnumContext(input)!;
    expect(completeEnumValue(input, ctx, "vercel")).toBe(
      "/projects --integration=vercel ",
    );
  });

  it("preserves text after the value when valueEnd < input.length", () => {
    // In v1 valueEnd is always input.length, but the splice math must
    // not regress if a future "cursor mid-value" extension fires this
    // path — pin the contract.
    const input = "/projects --integration=cap --extra";
    // Synthesize a context that points to the `cap` slice only.
    const valueStart = "/projects --integration=".length;
    const valueEnd = valueStart + "cap".length;
    const synthetic = {
      arg: {
        name: "integration",
        type: "enum" as const,
        required: false,
        description: "",
        enumValues: ["capture"],
        flag: "integration",
      },
      partial: "cap",
      valueStart,
      valueEnd,
    };
    expect(completeEnumValue(input, synthetic, "capture")).toBe(
      "/projects --integration=capture  --extra",
    );
  });
});
