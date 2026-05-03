// v0.3 S5 — E.164 → JID conversion invariants. Testing the helper
// directly avoids spinning up a Baileys socket.

import { describe, expect, it } from "vitest";

import { e164ToJid } from "../src/session.js";

describe("e164ToJid", () => {
  it("strips the leading + and produces an @s.whatsapp.net JID", () => {
    expect(e164ToJid("+5215551234567")).toBe("5215551234567@s.whatsapp.net");
  });

  it("strips spaces and dashes", () => {
    expect(e164ToJid("+52 155 5123-4567")).toBe(
      "5215551234567@s.whatsapp.net",
    );
  });

  it("rejects too-short numbers", () => {
    expect(() => e164ToJid("12345")).toThrow(/invalid phone number/);
  });

  it("rejects empty input", () => {
    expect(() => e164ToJid("")).toThrow(/invalid phone number/);
  });
});
