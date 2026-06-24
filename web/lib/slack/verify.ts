import crypto from "crypto";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";
const MAX_TIMESTAMP_DIFF = 5 * 60; // 5 minutes replay protection

/**
 * Verify a Slack request signature.
 * Returns the raw body string on success for downstream parsing.
 */
export async function verifySlackRequest(
  req: Request,
): Promise<{ valid: boolean; body: string }> {
  if (!SIGNING_SECRET) {
    return { valid: false, body: "" };
  }

  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!timestamp || !signature) {
    return { valid: false, body: "" };
  }

  // Replay protection
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > MAX_TIMESTAMP_DIFF) {
    return { valid: false, body: "" };
  }

  const body = await req.text();
  const sigBasestring = `v0:${timestamp}:${body}`;
  const computed = "v0=" + crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(sigBasestring, "utf8")
    .digest("hex");

  // Constant-time comparison
  const maxLen = Math.max(computed.length, signature.length);
  const aBuf = Buffer.alloc(maxLen);
  const bBuf = Buffer.alloc(maxLen);
  Buffer.from(computed).copy(aBuf);
  Buffer.from(signature).copy(bBuf);
  const valid = crypto.timingSafeEqual(aBuf, bBuf);

  return { valid, body };
}
