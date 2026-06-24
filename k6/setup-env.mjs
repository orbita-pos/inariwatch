/**
 * Extracts k6 test environment from the InariWatch database.
 * Generates k6/.env with all required secrets.
 *
 * Usage: node k6/setup-env.mjs
 * Requires: web/.env.local with DATABASE_URL and ENCRYPTION_KEY
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load env vars from web/.env.local ────────────────────────────────────────

const envPath = resolve(__dirname, "../web/.env.local");
const envContent = readFileSync(envPath, "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (match) env[match[1]] = match[2];
}

const DATABASE_URL = env.DATABASE_URL;
const ENCRYPTION_KEY = env.ENCRYPTION_KEY;
const CRON_SECRET = env.CRON_SECRET;

if (!DATABASE_URL || !ENCRYPTION_KEY) {
  console.error("Missing DATABASE_URL or ENCRYPTION_KEY in web/.env.local");
  process.exit(1);
}

// ── Decryption (matches web/lib/crypto.ts) ──────────────────────────────────

function decrypt(encryptedValue) {
  if (!encryptedValue) return null;

  // The DB stores as JSON object { _enc: "enc:v1:iv:tag:ciphertext" }
  // or as raw string "enc:v1:iv:tag:ciphertext"
  let raw = encryptedValue;
  if (typeof encryptedValue === "object" && encryptedValue._enc) {
    raw = encryptedValue._enc;
  }
  if (typeof raw === "string" && raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed._enc) raw = parsed._enc;
    } catch {}
  }

  if (!raw || !raw.startsWith("enc:v1:")) return null;

  const parts = raw.split(":");
  // enc:v1:iv:tag:ciphertext
  const iv = Buffer.from(parts[2], "hex");
  const tag = Buffer.from(parts[3], "hex");
  const ciphertext = Buffer.from(parts[4], "hex");
  const key = Buffer.from(ENCRYPTION_KEY, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, null, "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── Query database ──────────────────────────────────────────────────────────

async function query(sql) {
  // Use Neon HTTP driver directly via fetch
  const url = new URL(DATABASE_URL);
  const host = url.hostname;
  const user = url.username;
  const password = url.password;
  const database = url.pathname.slice(1);

  // Neon serverless HTTP endpoint
  const neonHost = host.replace("-pooler", "");
  const httpUrl = `https://${neonHost}/sql`;

  const res = await fetch(httpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": DATABASE_URL,
    },
    body: JSON.stringify({ query: sql, params: [] }),
  });

  if (!res.ok) {
    // Fallback: try direct pg query via connection string
    console.error("Neon HTTP failed, trying psql-style query...");
    return null;
  }

  const data = await res.json();
  return data;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Extracting k6 environment from InariWatch database...\n");

  // Get first project integration with a webhook secret (for test workspace)
  let integrationId = "";
  let webhookSecret = "";
  let captureSecret = "";
  let mcpToken = "";

  try {
    // Try using pg module if available
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();

    // Get an integration with capture service
    const captureResult = await client.query(`
      SELECT id, webhook_secret, config_encrypted, service
      FROM project_integrations
      WHERE service = 'capture' AND is_active = true
      LIMIT 1
    `);

    if (captureResult.rows.length > 0) {
      const row = captureResult.rows[0];
      integrationId = row.id;
      if (row.webhook_secret) {
        try {
          captureSecret = decrypt(row.webhook_secret) || row.webhook_secret;
        } catch {
          captureSecret = row.webhook_secret;
        }
      }
    }

    // Get any integration with webhook secret (for sentry/vercel/github)
    const webhookResult = await client.query(`
      SELECT id, webhook_secret, service
      FROM project_integrations
      WHERE webhook_secret IS NOT NULL AND is_active = true AND service != 'capture'
      LIMIT 1
    `);

    if (webhookResult.rows.length > 0) {
      const row = webhookResult.rows[0];
      if (!integrationId) integrationId = row.id;
      if (row.webhook_secret) {
        try {
          webhookSecret = decrypt(row.webhook_secret) || row.webhook_secret;
        } catch {
          webhookSecret = row.webhook_secret;
        }
      }
    }

    // If no separate webhook, use capture secret for both
    if (!webhookSecret && captureSecret) webhookSecret = captureSecret;
    if (!captureSecret && webhookSecret) captureSecret = webhookSecret;

    // Get MCP token
    const mcpResult = await client.query(`
      SELECT token FROM mcp_tokens
      WHERE revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (mcpResult.rows.length > 0) {
      mcpToken = mcpResult.rows[0].token || "";
    }

    await client.end();
  } catch (err) {
    console.error("DB query failed:", err.message);
    console.log("\nFalling back to manual setup...");
    console.log("Please fill in the values manually in k6/.env");
  }

  // Generate .env
  const envOutput = `# InariWatch k6 Stress Test Environment
# Generated: ${new Date().toISOString()}
# Target: Production test workspace

BASE_URL=https://app.inariwatch.com
CRON_SECRET=${CRON_SECRET || ""}
API_TOKEN=${mcpToken}
INTEGRATION_ID=${integrationId}
WEBHOOK_SECRET=${webhookSecret}
CAPTURE_SECRET=${captureSecret}
SESSION_COOKIE=
`;

  const outputPath = resolve(__dirname, ".env");
  writeFileSync(outputPath, envOutput, "utf-8");

  console.log("Generated k6/.env:\n");
  console.log(`  BASE_URL=https://app.inariwatch.com`);
  console.log(`  CRON_SECRET=${CRON_SECRET ? "***" + CRON_SECRET.slice(-4) : "MISSING"}`);
  console.log(`  API_TOKEN=${mcpToken ? "***" + mcpToken.slice(-8) : "MISSING — create one in Settings > MCP"}`);
  console.log(`  INTEGRATION_ID=${integrationId || "MISSING — connect an integration first"}`);
  console.log(`  WEBHOOK_SECRET=${webhookSecret ? "***" + webhookSecret.slice(-4) : "MISSING"}`);
  console.log(`  CAPTURE_SECRET=${captureSecret ? "***" + captureSecret.slice(-4) : "MISSING"}`);
  console.log(`\nSaved to: ${outputPath}`);
}

main().catch(console.error);
