#!/usr/bin/env node
/**
 * Seed a throw-away project + iwk_pub_v1_ token for the visual-report
 * Playwright e2e test. Idempotent — re-running returns the same token.
 *
 * Why a dedicated seeder instead of going through the dashboard wizard:
 * Playwright can't easily drive the OAuth signup flow without a real
 * email + confirmation step. For a SDK smoke test we just need a token
 * pair we can throw at the endpoint.
 *
 * Run from `web/`:
 *   node scripts/seed-visual-report-test.mjs
 *
 * Output (single JSON line, easy to consume from shell):
 *   {"projectId":"...","token":"iwk_pub_v1_..."}
 */

import { config } from "dotenv";
import { randomUUID, randomBytes, createHash } from "crypto";
import { Client } from "pg";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `quiet: true` suppresses dotenv's "injecting env" stdout chatter so the
// final console.log JSON is the *only* thing the caller has to parse.
config({ path: resolve(__dirname, "..", ".env.local"), quiet: true });

const SEED_USER_EMAIL  = "visual-report-test@inariwatch.local";
const SEED_USER_NAME   = "Visual Report Test User";
const SEED_PROJECT_KEY = "visual-report-e2e-test";

const TOKEN_PREFIX = "iwk_pub_v1_";

function mintToken() {
  // 32 bytes base64url ≈ 43 chars. Prefix → 12 chars total.
  const raw = randomBytes(32).toString("base64url");
  return TOKEN_PREFIX + raw;
}

function sha256Hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // 1) Test user (idempotent on email).
  let userRes = await client.query(
    "SELECT id FROM users WHERE email = $1 LIMIT 1",
    [SEED_USER_EMAIL],
  );
  let userId;
  if (userRes.rows.length) {
    userId = userRes.rows[0].id;
  } else {
    userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, name, plan, email_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'free', now(), now(), now())`,
      [userId, SEED_USER_EMAIL, SEED_USER_NAME],
    );
  }

  // 2) Test project (idempotent on (user_id, slug)).
  let projRes = await client.query(
    "SELECT id FROM projects WHERE user_id = $1 AND slug = $2 LIMIT 1",
    [userId, SEED_PROJECT_KEY],
  );
  let projectId;
  if (projRes.rows.length) {
    projectId = projRes.rows[0].id;
  } else {
    projectId = randomUUID();
    await client.query(
      `INSERT INTO projects (id, user_id, name, slug, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [projectId, userId, "Visual Report E2E", SEED_PROJECT_KEY],
    );
  }

  // 3) Project token. Reuse the most recent live token for this project
  //    if one exists so re-running the seeder doesn't pile up rows.
  const existing = await client.query(
    `SELECT id FROM project_tokens
      WHERE project_id = $1 AND revoked_at IS NULL
   ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );

  let token;
  if (existing.rows.length) {
    // Existing token's plaintext is unrecoverable (only the hash is
    // stored). Revoke + mint a fresh one so we can emit the plaintext.
    await client.query(
      "UPDATE project_tokens SET revoked_at = now() WHERE id = $1",
      [existing.rows[0].id],
    );
  }

  token = mintToken();
  const tokenHash = sha256Hex(token);
  const tokenPrefix = token.slice(0, 24);

  await client.query(
    `INSERT INTO project_tokens (
       id, project_id, token_hash, token_prefix, scope,
       created_via, device_label, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      randomUUID(),
      projectId,
      tokenHash,
      tokenPrefix,
      ["capture:write"],
      "e2e-seed",
      "visual-report-test",
    ],
  );

  // Single JSON line so callers can `JSON.parse(stdout)`.
  console.log(JSON.stringify({ projectId, token }));
} finally {
  await client.end();
}
