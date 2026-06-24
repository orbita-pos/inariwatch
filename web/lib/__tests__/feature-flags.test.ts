import { describe, it, expect, afterEach } from "vitest";
import { isReplayV2Enabled } from "../feature-flags";

describe("isReplayV2Enabled — legacy single-axis (org id)", () => {
  afterEach(() => {
    delete process.env.REPLAY_V2_ORGS;
    delete process.env.REPLAY_V2_USERS;
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

describe("isReplayV2Enabled — two-axis context object", () => {
  afterEach(() => {
    delete process.env.REPLAY_V2_ORGS;
    delete process.env.REPLAY_V2_USERS;
  });

  it("returns false when no flag axis matches and both ids are null", () => {
    expect(isReplayV2Enabled({ organizationId: null, userId: null })).toBe(false);
  });

  it("matches on the org axis alone", () => {
    process.env.REPLAY_V2_ORGS = "org_a";
    expect(isReplayV2Enabled({ organizationId: "org_a", userId: "user_anyone" })).toBe(true);
  });

  it("matches on the user axis alone (personal-workspace path)", () => {
    process.env.REPLAY_V2_USERS = "user_b";
    expect(isReplayV2Enabled({ organizationId: null, userId: "user_b" })).toBe(true);
  });

  it("returns false when only the wrong axis matches the wrong id", () => {
    process.env.REPLAY_V2_ORGS = "org_a";
    process.env.REPLAY_V2_USERS = "user_b";
    expect(isReplayV2Enabled({ organizationId: "org_other", userId: "user_other" })).toBe(false);
  });

  it("either-or: matches when EITHER axis matches", () => {
    process.env.REPLAY_V2_ORGS = "org_a";
    process.env.REPLAY_V2_USERS = "user_b";
    expect(isReplayV2Enabled({ organizationId: "org_a", userId: "user_other" })).toBe(true);
    expect(isReplayV2Enabled({ organizationId: "org_other", userId: "user_b" })).toBe(true);
  });

  it("user-axis wildcard `*` enables every personal viewer", () => {
    process.env.REPLAY_V2_USERS = "*";
    expect(isReplayV2Enabled({ organizationId: null, userId: "any_user" })).toBe(true);
  });

  it("missing user axis env var doesn't affect org-axis match", () => {
    process.env.REPLAY_V2_ORGS = "org_a";
    expect(isReplayV2Enabled({ organizationId: "org_a", userId: null })).toBe(true);
  });

  it("backward-compat: single-axis call still works alongside two-axis", () => {
    process.env.REPLAY_V2_ORGS = "org_a";
    expect(isReplayV2Enabled("org_a")).toBe(true);
    expect(isReplayV2Enabled({ organizationId: "org_a", userId: null })).toBe(true);
  });
});
