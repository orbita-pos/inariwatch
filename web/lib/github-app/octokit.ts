// GitHub App auth helpers — JWT minting + installation token retrieval.
//
// We avoid @octokit/app to keep the bundle small. The two operations we
// need (sign a JWT with the App's private key, then exchange it for an
// installation access token) are ~30 lines of Node `crypto`.
//
// Required env:
//   GITHUB_APP_ID            — numeric App ID from github.com/settings/apps/<slug>
//   GITHUB_APP_PRIVATE_KEY   — PEM, with newlines escaped as \n (we un-escape)
//   GITHUB_APP_WEBHOOK_SECRET — for webhook verification (used in /api/webhooks/github-app)

import { createSign, createHmac, timingSafeEqual } from "node:crypto";

const GITHUB_API = "https://api.github.com";

export function appConfig(): { appId: string; privateKey: string } {
  const appId = process.env.GITHUB_APP_ID;
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !rawKey) {
    throw new Error("GitHub App env not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).");
  }
  // Newlines are typically escaped as \n in env vars. Restore them.
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  return { appId, privateKey };
}

/**
 * Mint an App-level JWT (RS256). Valid 10 minutes per GitHub spec, but
 * we set 9 to leave margin for clock skew. Used to fetch installation
 * tokens — never make user-facing requests with this directly.
 */
export function mintAppJwt(): string {
  const { appId, privateKey } = appConfig();
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const enc = (obj: object) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const head = `${enc(header)}.${enc(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(head);
  const sig = signer.sign(privateKey)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${head}.${sig}`;
}

/**
 * Exchange an App JWT + installation_id for an installation access token.
 * The token is scoped to that one installation and expires in 1 hour.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const jwt = mintAppJwt();
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept:        "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`installation_token failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

/** Fetch helper that authenticates with an installation token. */
export async function ghFetch(
  token:   string,
  path:    string,
  init?:   RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Authorization", `token ${token}`);
  headers.set("Accept",        "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
}

/**
 * Verify a GitHub webhook payload. Header is `X-Hub-Signature-256`,
 * value is `sha256=<hmac>` of the raw body.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
