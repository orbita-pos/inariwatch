import { describe, it, expect } from "vitest";
import { scrub } from "../pii-scrub";

describe("pii-scrub", () => {
  it("returns null for null/undefined/empty", () => {
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeNull();
    expect(scrub("")).toBeNull();
  });

  it("masks emails", () => {
    expect(scrub("user jane.doe+tag@acme.co reported bug")).toBe("user [email] reported bug");
  });

  it("masks OpenAI keys", () => {
    expect(scrub("apiKey: sk-proj-abc123def456ghi789jkl012mno345")).toContain("[openai-key]");
  });

  it("masks Anthropic keys", () => {
    expect(scrub("sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx")).toContain("[anthropic-key]");
  });

  it("masks Stripe keys (live + test)", () => {
    expect(scrub("sk_live_abc123def456ghi789jkl")).toContain("[stripe-key]");
    expect(scrub("pk_test_xyz789abc123def456ghi")).toContain("[stripe-key]");
  });

  it("masks GitHub PATs", () => {
    expect(scrub("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toContain("[github-pat]");
  });

  it("masks JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(scrub(`token: ${jwt}`)).toContain("[jwt]");
  });

  it("masks Bearer tokens in auth headers", () => {
    expect(scrub("Authorization: Bearer abcdef1234567890abcdef1234567890")).toContain("Bearer [REDACTED]");
  });

  it("masks AWS access keys (AKIA + ASIA)", () => {
    expect(scrub("AKIAIOSFODNN7EXAMPLE")).toContain("[aws-access-key]");
    expect(scrub("ASIAIOSFODNN7EXAMPLE")).toContain("[aws-access-key]");
  });

  it("truncates when maxChars provided", () => {
    const long = "x".repeat(1000);
    const result = scrub(long, { maxChars: 100 });
    expect(result!.length).toBeLessThanOrEqual(200);
    expect(result).toContain("[truncated");
  });
});
