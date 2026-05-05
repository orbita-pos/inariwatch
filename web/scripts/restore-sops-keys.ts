/**
 * One-shot restore script for accidentally-deleted sops keys.
 *
 * Reads the encrypted .env.sops.yaml at a given git commit, decrypts
 * it into memory only (never to stdout / stderr / disk in plaintext
 * past the brief sops-input window), extracts the named keys, and
 * re-encrypts them into the current .env.sops.yaml via `sops set`.
 *
 * Used to recover INARIWATCH_DSN + INARIWATCH_REDACT after the
 * chore/sops-add-github-app-oauth-secrets PR overwrote them with a
 * stale base.
 *
 * Usage:
 *   npx tsx scripts/restore-sops-keys.ts <git-sha> KEY1 [KEY2 ...]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const [sha, ...keys] = process.argv.slice(2);
  if (!sha || keys.length === 0) {
    console.error("Usage: npx tsx scripts/restore-sops-keys.ts <git-sha> KEY1 [KEY2 ...]");
    process.exit(1);
  }

  const sopsBin =
    process.env.SOPS_BIN ||
    (process.platform === "win32" ? "C:/Users/jesus/bin/sops.exe" : "sops");
  const ageKeyFile =
    process.env.SOPS_AGE_KEY_FILE ||
    (process.platform === "win32"
      ? `${process.env.USERPROFILE}/.config/sops/age/keys.txt`
      : `${process.env.HOME}/.config/sops/age/keys.txt`);

  if (!existsSync(ageKeyFile)) {
    console.error(`Age key file not found at ${ageKeyFile}`);
    process.exit(1);
  }
  if (!existsSync(".env.sops.yaml")) {
    console.error(".env.sops.yaml not found — run from web/ directory.");
    process.exit(1);
  }

  // Pull the historic encrypted blob into memory.
  const oldEncrypted = execFileSync(
    "git",
    ["show", `${sha}:web/.env.sops.yaml`],
    { encoding: "utf8" },
  );

  // sops needs a file path. Write the (still-encrypted) blob to a
  // temp file in the OS temp dir, decrypt to a memory string, delete.
  const tmpFile = join(tmpdir(), `sops-restore-${process.pid}-${Date.now()}.yaml`);
  writeFileSync(tmpFile, oldEncrypted, { mode: 0o600 });

  let decrypted: string;
  try {
    decrypted = execFileSync(sopsBin, ["decrypt", tmpFile], {
      env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile },
      encoding: "utf8",
    });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }
  }

  // Parse YAML lines for the keys we want. Values are simple strings
  // in this file (no multi-line blocks for these particular keys).
  for (const key of keys) {
    const line = decrypted
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}: `));
    if (!line) {
      console.error(`Key ${key} not found at ${sha}`);
      process.exit(1);
    }
    const value = line.slice(`${key}: `.length);

    execFileSync(
      sopsBin,
      ["set", ".env.sops.yaml", `["${key}"]`, JSON.stringify(value)],
      {
        env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    console.log(`OK — ${key} restored`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
