import { config } from "dotenv";
config({ path: ".env.local" });
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Update a single key in .env.sops.yaml with the value currently in
 * .env.local, without ever printing the value to stdout.
 *
 *   npx tsx scripts/update-sops-key.ts DATABASE_URL
 *
 * Assumes:
 *   - sops binary at C:/Users/jesus/bin/sops.exe (override with SOPS_BIN)
 *   - age key at %USERPROFILE%/.config/sops/age/keys.txt
 */
async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("Usage: npx tsx scripts/update-sops-key.ts <ENV_VAR_NAME>");
    process.exit(1);
  }

  const value = process.env[key];
  if (!value) {
    console.error(`${key} not found in .env.local`);
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
    console.error("web/.env.sops.yaml not found. Are you in the web/ directory?");
    process.exit(1);
  }

  // sops set expects the value as JSON, so a string becomes a quoted string.
  execFileSync(
    sopsBin,
    ["set", ".env.sops.yaml", `["${key}"]`, JSON.stringify(value)],
    {
      env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  console.log(`OK — ${key} updated in .env.sops.yaml`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
