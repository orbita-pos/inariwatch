import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ENGINE,
  isCodeIntelEngineActive,
  resolveCodeIntelEngine,
} from "../flag";

const ORIGINAL = process.env.CODE_INTEL_V2;

beforeEach(() => {
  delete process.env.CODE_INTEL_V2;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CODE_INTEL_V2;
  else process.env.CODE_INTEL_V2 = ORIGINAL;
});

describe("resolveCodeIntelEngine", () => {
  it("defaults to v1 (off) when env var is unset", () => {
    expect(resolveCodeIntelEngine()).toBe("off");
    expect(DEFAULT_ENGINE).toBe("off");
  });

  it("returns each known engine literal", () => {
    process.env.CODE_INTEL_V2 = "on";
    expect(resolveCodeIntelEngine()).toBe("on");

    process.env.CODE_INTEL_V2 = "shadow";
    expect(resolveCodeIntelEngine()).toBe("shadow");

    process.env.CODE_INTEL_V2 = "off";
    expect(resolveCodeIntelEngine()).toBe("off");
  });

  it("normalizes case and whitespace", () => {
    process.env.CODE_INTEL_V2 = "  ON  ";
    expect(resolveCodeIntelEngine()).toBe("on");

    process.env.CODE_INTEL_V2 = "Shadow";
    expect(resolveCodeIntelEngine()).toBe("shadow");
  });

  it("fails closed to off for unknown values (typo protection)", () => {
    process.env.CODE_INTEL_V2 = "true";
    expect(resolveCodeIntelEngine()).toBe("off");

    process.env.CODE_INTEL_V2 = "v2";
    expect(resolveCodeIntelEngine()).toBe("off");

    process.env.CODE_INTEL_V2 = "yes";
    expect(resolveCodeIntelEngine()).toBe("off");
  });

  it("ignores ctx in Phase 1.5 (per-workspace overrides come in Phase 3)", () => {
    process.env.CODE_INTEL_V2 = "shadow";
    expect(resolveCodeIntelEngine({ workspaceId: "w1", projectId: "p1" })).toBe("shadow");
  });
});

describe("isCodeIntelEngineActive", () => {
  it("treats off as inactive, anything else as active", () => {
    expect(isCodeIntelEngineActive("off")).toBe(false);
    expect(isCodeIntelEngineActive("shadow")).toBe(true);
    expect(isCodeIntelEngineActive("on")).toBe(true);
  });
});
