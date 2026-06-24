import { config } from "dotenv";
config({ path: ".env.local" });
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Reads TOGETHER_API_KEY from .env.local and writes it as
// PLATFORM_TOGETHER_KEY into .env.sops.yaml.
// Usage: npx tsx scripts/set-together-key.ts

const value = process.env.TOGETHER_API_KEY;
if (!value) {
  console.error("TOGETHER_API_KEY not found in .env.local");
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
  console.error("web/.env.sops.yaml not found. Run from the web/ directory.");
  process.exit(1);
}

execFileSync(
  sopsBin,
  ["set", ".env.sops.yaml", '["PLATFORM_TOGETHER_KEY"]', JSON.stringify(value)],
  {
    env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

console.log("OK — PLATFORM_TOGETHER_KEY written to .env.sops.yaml");
console.log("Next: kamal env push");
