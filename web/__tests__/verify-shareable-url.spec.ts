/**
 * Sesión 29 — Playwright e2e: shareable URL flow.
 *
 * verify.inariwatch.com surfaces a `Share this verification` button
 * after a successful PASS. Clicking it copies a URL of shape
 *
 *   https://verify.inariwatch.com/r/<base64-receipt>
 *
 * (or `/verify/r/<base64>` on the root domain). Opening that URL
 * directly should run the verifier on the embedded receipt without
 * any user interaction — the receipt round-trips through the URL
 * itself, no server-side state.
 *
 * The test mints a real Ed25519 keypair via @noble/curves, encodes
 * the receipt into the URL segment, opens the page, and asserts
 * the PASS block renders without the user touching the textarea.
 *
 * Skipped automatically when no Next dev server is reachable —
 * `PLAYWRIGHT_BASE_URL` defaults to `http://localhost:3000` so a
 * developer running `npm run test:e2e` after `npm run dev` gets the
 * full coverage; CI without a server still passes the suite as a
 * skipped test.
 */

import { test, expect } from "@playwright/test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function signedDigest(receiptId: string): Uint8Array {
  return sha256(new TextEncoder().encode(receiptId));
}

function buildSignedReceipt(seedByte: number, receiptId: string): string {
  const seed = new Uint8Array(32).fill(seedByte);
  const pubkey = ed25519.getPublicKey(seed);
  const signature = ed25519.sign(signedDigest(receiptId), seed);
  return JSON.stringify({
    version: "eap-1",
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

function encodeShareable(rawJson: string): string {
  const bytes = new TextEncoder().encode(rawJson);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const RECEIPT_ID =
  "9af1d4c0a3b87216c5e9d2087f3a1b8c4d6e9072f8a51c3b6d4e7f01a2c5d6e8";

test.describe("verify shareable URL", () => {
  test("opens /verify/r/<base64> and renders PASS without paste", async ({ page }) => {
    const json = buildSignedReceipt(7, RECEIPT_ID);
    const segment = encodeShareable(json);

    const navResult = await page
      .goto(`/verify/r/${segment}`, { waitUntil: "domcontentloaded", timeout: 5_000 })
      .catch((err) => err);
    if (navResult instanceof Error) {
      test.skip(true, `Next dev server not reachable: ${navResult.message}`);
      return;
    }

    const result = page.getByTestId("verify-result");
    await expect(result).toBeVisible({ timeout: 10_000 });
    await expect(result).toHaveAttribute("data-outcome", "signed");
    await expect(result).toContainText("Signature verified");
    await expect(result).toContainText(RECEIPT_ID);
  });

  test("/verify renders the disclosure footer", async ({ page }) => {
    const navResult = await page
      .goto(`/verify`, { waitUntil: "domcontentloaded", timeout: 5_000 })
      .catch((err) => err);
    if (navResult instanceof Error) {
      test.skip(true, `Next dev server not reachable: ${navResult.message}`);
      return;
    }

    await expect(
      page.getByText(/NOT cryptographically committed/i),
    ).toBeVisible();
    await expect(page.getByText(/Verify any Inari AI fix receipt/i)).toBeVisible();
  });
});
