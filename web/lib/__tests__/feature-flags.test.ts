import { describe, it, expect, afterEach } from "vitest";
import { isReplayV2Enabled } from "../feature-flags";

describe("isReplayV2Enabled", () => {
  afterEach(() => {
    delete process.env.REPLAY_V2_ORGS;
  });

  it("returns false when env var is unset", () => {
    expect(isReplayV2Enabled("org_a")).toBe(false);
  });

  it("returns false when org id is null/undefined", () => {
    process.env.REPLAY_V2_ORGS = "org_a,org_b";
    expect(isReplayV2Enabled(null)).toBe(false);
    expect(isReplayV2Enabled(undefined)).toBe(false);
  });

  it("returns true when org id is in the allowlist", () => {
    process.env.REPLAY_V2_ORGS = "org_a,org_b,org_c";
    expect(isReplayV2Enabled("org_b")).toBe(true);
  });

  it("returns false when org id is not in the allowlist", () => {
    process.env.REPLAY_V2_ORGS = "org_a,org_b";
    expect(isReplayV2Enabled("org_other")).toBe(false);
  });

  it("returns true for any org when allowlist is *", () => {
    process.env.REPLAY_V2_ORGS = "*";
    expect(isReplayV2Enabled("any_org")).toBe(true);
    expect(isReplayV2Enabled("another_org")).toBe(true);
  });

  it("trims whitespace in the allowlist", () => {
    process.env.REPLAY_V2_ORGS = "  org_a , org_b  ,  org_c  ";
    expect(isReplayV2Enabled("org_b")).toBe(true);
  });
});
