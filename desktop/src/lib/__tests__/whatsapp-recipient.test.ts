/**
 * Tests for the /whatsapp pure helpers (matchByDisplayName +
 * parseWhatsAppArgs). The IPC-touching `resolveWhatsAppRecipient`
 * is integration-tested via slash-dispatch.test.ts with the resolver
 * stubbed at the dispatcher boundary.
 */

import { describe, expect, it } from "vitest";

import {
  matchByDisplayName,
  parseWhatsAppArgs,
  type WhatsAppPaired,
} from "../whatsapp-recipient";

const MOM: WhatsAppPaired = {
  entity_id: "e-mom",
  display_name: "Mom",
  phone: "+5215511112222",
  redacted: "+52 ••••2222",
};
const MONICA: WhatsAppPaired = {
  entity_id: "e-monica",
  display_name: "Monica",
  phone: "+5215533334444",
  redacted: "+52 ••••4444",
};
const CARLOS_M: WhatsAppPaired = {
  entity_id: "e-carlos-m",
  display_name: "Carlos M",
  phone: "+5215555556666",
  redacted: "+52 ••••6666",
};
const CARLOS_R: WhatsAppPaired = {
  entity_id: "e-carlos-r",
  display_name: "Carlos R",
  phone: "+5215577778888",
  redacted: "+52 ••••8888",
};

const ALL = [MOM, MONICA, CARLOS_M, CARLOS_R];

describe("matchByDisplayName", () => {
  it("returns empty for empty query", () => {
    expect(matchByDisplayName("", ALL)).toEqual([]);
    expect(matchByDisplayName("   ", ALL)).toEqual([]);
  });

  it("does exact case-insensitive match (highest priority)", () => {
    expect(matchByDisplayName("Mom", ALL)).toEqual([MOM]);
    expect(matchByDisplayName("MOM", ALL)).toEqual([MOM]);
    expect(matchByDisplayName("monica", ALL)).toEqual([MONICA]);
  });

  it("exact match takes precedence over prefix matches that include it", () => {
    // "Mom" is exact for MOM; "Monica" starts with "mo" too. Exact
    // wins so the user can target "Mom" without disambiguation.
    expect(matchByDisplayName("Mom", ALL)).toEqual([MOM]);
  });

  it("falls back to first-word prefix match", () => {
    expect(matchByDisplayName("mo", ALL)).toEqual([MOM, MONICA]);
  });

  it("matches first-word for multi-word display names", () => {
    // "Carlos M" + "Carlos R" both have first word "Carlos".
    expect(matchByDisplayName("car", ALL)).toEqual([CARLOS_M, CARLOS_R]);
    expect(matchByDisplayName("Carlos", ALL)).toEqual([CARLOS_M, CARLOS_R]);
  });

  it("returns empty for queries that don't prefix any first word", () => {
    expect(matchByDisplayName("xyz", ALL)).toEqual([]);
  });

  it("trims surrounding whitespace from the query", () => {
    expect(matchByDisplayName("  mom  ", ALL)).toEqual([MOM]);
  });
});

describe("parseWhatsAppArgs", () => {
  it("rejects empty args", () => {
    const r = parseWhatsAppArgs("");
    expect("error" in r && r.error).toMatch(/Recipient.*required/i);
  });

  it("rejects whitespace-only args", () => {
    const r = parseWhatsAppArgs("   ");
    expect("error" in r && r.error).toMatch(/Recipient.*required/i);
  });

  it("rejects single-token args (no message body)", () => {
    const r = parseWhatsAppArgs("Mom");
    expect("error" in r && r.error).toMatch(/Message body required/i);
  });

  it("splits on first whitespace, message keeps whitespace", () => {
    expect(parseWhatsAppArgs("Mom Hola, llego tarde")).toEqual({
      recipient: "Mom",
      message: "Hola, llego tarde",
    });
  });

  it("preserves multi-word messages with multiple spaces", () => {
    expect(parseWhatsAppArgs("Carlos En  20  minutos llego")).toEqual({
      recipient: "Carlos",
      message: "En  20  minutos llego",
    });
  });

  it("trims trailing whitespace from message body", () => {
    expect(parseWhatsAppArgs("Mom Hola   ")).toEqual({
      recipient: "Mom",
      message: "Hola",
    });
  });

  it("preserves emoji + punctuation in messages", () => {
    expect(parseWhatsAppArgs("Mom 🎉 todo bien!")).toEqual({
      recipient: "Mom",
      message: "🎉 todo bien!",
    });
  });

  it("recipient takes the first token only (no quoting)", () => {
    // "Carlos M Hola" → recipient="Carlos", message="M Hola".
    // This is a known limitation: multi-word display names need
    // exact-match (handled by the resolver, not the parser).
    expect(parseWhatsAppArgs("Carlos M Hola")).toEqual({
      recipient: "Carlos",
      message: "M Hola",
    });
  });

  it("E.164 numbers parse as recipient", () => {
    expect(parseWhatsAppArgs("+5215512345678 hi")).toEqual({
      recipient: "+5215512345678",
      message: "hi",
    });
  });
});
