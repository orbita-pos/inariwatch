import { describe, it, expect } from "vitest";
import { extractMentionEmails } from "../replay-mention";

describe("extractMentionEmails", () => {
  it("returns [] for empty / non-string", () => {
    expect(extractMentionEmails("")).toEqual([]);
  });

  it("extracts a single mention", () => {
    expect(extractMentionEmails("hey @jesus@orbita-pos.com check this")).toEqual([
      "jesus@orbita-pos.com",
    ]);
  });

  it("extracts multiple mentions", () => {
    expect(
      extractMentionEmails("@a@x.com and @b@y.io please look at this"),
    ).toEqual(["a@x.com", "b@y.io"]);
  });

  it("dedupes case-insensitively", () => {
    expect(
      extractMentionEmails("@John@Acme.com first then @JOHN@acme.COM again"),
    ).toEqual(["john@acme.com"]);
  });

  it("ignores plain emails (no @ prefix)", () => {
    expect(extractMentionEmails("contact john@acme.com later")).toEqual([]);
  });

  it("ignores @handle without an @domain", () => {
    expect(extractMentionEmails("@john said hi")).toEqual([]);
  });

  it("handles mentions at start, end, and around punctuation", () => {
    expect(
      extractMentionEmails("@a@x.com, then @b@y.com! Finally @c@z.com."),
    ).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  it("requires a TLD of 2+ chars (skips bare hostnames)", () => {
    expect(extractMentionEmails("@user@localhost ping")).toEqual([]);
    // 1-char TLD rejected
    expect(extractMentionEmails("@u@a.b ping")).toEqual([]);
    // 2-char TLD accepted (smallest that makes through)
    expect(extractMentionEmails("@u@a.io ping")).toEqual(["u@a.io"]);
  });
});
