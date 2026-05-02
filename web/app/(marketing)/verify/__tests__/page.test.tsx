// @vitest-environment happy-dom
/**
 * Sesión 29 — `/verify` client UI behaviour.
 *
 * The page is a thin shell over the `<VerifyClient />` interactive
 * component. The page itself only renders metadata + the disclosure
 * footer + the marketing nav, so the meaningful behaviour to lock in
 * tests is the client component:
 *
 *   1. Pasting a valid signed receipt and clicking Verify renders a
 *      "Signature verified" PASS block with the expected key_id.
 *   2. Pasting a tampered signature renders a "Signature invalid" FAIL
 *      block with the disclosure-aware copy.
 *   3. Pasting an unsigned receipt renders the Merkle-only PASS block
 *      (distinct from collapsing into FAIL).
 *   4. Pasting unparseable text renders a Malformed FAIL block.
 *   5. The Disclosure footer copy is present on the page shell — both
 *      "NOT cryptographically committed" and the metadata field list.
 *
 * Crypto is real (`@noble/curves/ed25519`) so the test doubles as a
 * contract check against the S28 Rust verifier.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ed25519 } from "@noble/curves/ed25519.js";

import { hexEncode, signedDigest, EAP_FORMAT_VERSION } from "@/lib/eap-verify";
import { VerifyClient } from "../verify-client";
import VerifyPage from "../page";

const RECEIPT_ID =
  "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8";

function buildSignedJson(seedByte: number, receiptId = RECEIPT_ID): string {
  const seed = new Uint8Array(32).fill(seedByte);
  const pubkey = ed25519.getPublicKey(seed);
  const digest = signedDigest(receiptId);
  const signature = ed25519.sign(digest, seed);
  return JSON.stringify({
    version: EAP_FORMAT_VERSION,
    receipt_id: receiptId,
    merkle_root: receiptId,
    signed: true,
    signature: hexEncode(signature),
    public_key: hexEncode(pubkey),
    attestor: "inariwatch",
    timestamp: "2026-05-01T00:00:00Z",
    model: "gpt-5.4",
  });
}

beforeEach(() => {
  cleanup();
});

describe("<VerifyClient />", () => {
  it("renders a signed PASS block when the user pastes a valid receipt", () => {
    const json = buildSignedJson(7);
    render(<VerifyClient />);

    const textarea = screen.getByTestId("receipt-json") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: json } });
    fireEvent.click(screen.getByTestId("verify-button"));

    const result = screen.getByTestId("verify-result");
    expect(result.dataset.outcome).toBe("signed");
    expect(result.textContent).toMatch(/Signature verified/);
    expect(result.textContent).toMatch(/key_id/);
    // The receipt_id row should render the full hex.
    expect(result.textContent).toContain(RECEIPT_ID);
  });

  it("renders a FAIL block with signature-invalid for a tampered receipt", () => {
    const json = buildSignedJson(7);
    const tampered = json.replace(
      /"signature":"([0-9a-f]+)"/,
      (_m, sig: string) => {
        const last = sig.slice(-1);
        const flipped = last === "0" ? "1" : "0";
        return `"signature":"${sig.slice(0, -1)}${flipped}"`;
      },
    );

    render(<VerifyClient />);
    const textarea = screen.getByTestId("receipt-json") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: tampered } });
    fireEvent.click(screen.getByTestId("verify-button"));

    const result = screen.getByTestId("verify-result");
    expect(result.dataset.outcome).toBe("signature-invalid");
    expect(result.textContent).toMatch(/Signature invalid/);
    expect(result.textContent).toMatch(/does NOT verify/);
  });

  it("renders Merkle-only PASS for an unsigned receipt", () => {
    const json = JSON.stringify({
      version: EAP_FORMAT_VERSION,
      receipt_id: RECEIPT_ID,
      merkle_root: RECEIPT_ID,
      signed: false,
      attestor: "inariwatch",
    });

    render(<VerifyClient />);
    fireEvent.change(
      screen.getByTestId("receipt-json"),
      { target: { value: json } },
    );
    fireEvent.click(screen.getByTestId("verify-button"));

    const result = screen.getByTestId("verify-result");
    expect(result.dataset.outcome).toBe("merkle-only");
    expect(result.textContent).toMatch(/Merkle-only/);
    expect(result.textContent).toMatch(/no attestor identity/);
  });

  it("renders Malformed FAIL for unparseable JSON", () => {
    render(<VerifyClient />);
    fireEvent.change(
      screen.getByTestId("receipt-json"),
      { target: { value: "{ not json" } },
    );
    fireEvent.click(screen.getByTestId("verify-button"));

    const result = screen.getByTestId("verify-result");
    expect(result.dataset.outcome).toBe("malformed");
    expect(result.textContent).toMatch(/Malformed/);
  });
});

describe("<VerifyPage />", () => {
  it("renders the disclosure footer copy in plain English", () => {
    const { container } = render(<VerifyPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/NOT cryptographically committed/);
    expect(text).toMatch(/prompt_hash/);
    expect(text).toMatch(/files_read/);
    expect(text).toMatch(/Merkle root/);
    expect(text).toMatch(/SHA-256\(receipt_id\)/);
  });

  it("renders the hero title", () => {
    const { container } = render(<VerifyPage />);
    expect(container.textContent).toMatch(/Verify any Inari AI fix receipt/);
  });
});
