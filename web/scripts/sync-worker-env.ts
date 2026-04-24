import { config } from "dotenv";
config({ path: ".env.local" });
import { spawnSync } from "node:child_process";

/**
 * Atomically update a single KEY=VALUE line in /opt/inari-worker/.env on
 * inari-staging and restart the systemd service.
 *
 *   npx tsx scripts/sync-worker-env.ts DATABASE_URL
 *
 * Safety-critical design:
 *   1. Secret value never touches stdout on this side.
 *   2. Secret value never appears in argv of any local or remote process
 *      (so it's invisible to `ps aux`).
 *   3. A remote helper script is scp'd to /tmp first (script contains NO
 *      secret data), then invoked via ssh with the secret piped via stdin
 *      ONLY — bash never tries to execute the value as a command.
 *   4. Worker env file update is atomic (awk → tmp → mv).
 *   5. Remote /tmp helper is deleted after.
 */
async function main() {
  const key = process.argv[2];
  if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) {
    console.error("Usage: npx tsx scripts/sync-worker-env.ts <KEY>");
    process.exit(1);
  }

  const sopsBin =
    process.env.SOPS_BIN ||
    (process.platform === "win32" ? "C:/Users/jesus/bin/sops.exe" : "sops");
  const ageKey =
    process.env.SOPS_AGE_KEY_FILE ||
    (process.platform === "win32"
      ? `${process.env.USERPROFILE}/.config/sops/age/keys.txt`
      : `${process.env.HOME}/.config/sops/age/keys.txt`);

  const decrypt = spawnSync(sopsBin, ["-d", "--extract", `["${key}"]`, ".env.sops.yaml"], {
    env: { ...process.env, SOPS_AGE_KEY_FILE: ageKey },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (decrypt.status !== 0 || !decrypt.stdout) {
    console.error(`sops decrypt failed: ${decrypt.stderr?.slice(0, 300) ?? "?"}`);
    process.exit(1);
  }
  const value = decrypt.stdout.replace(/\r?\n$/, "");
  console.log(`  decrypted ${key} from sops (${value.length} chars — not shown)`);

  // Remote helper script. Zero secret content. Reads value from stdin only.
  // awk handles arbitrary characters in the value because -v binding happens
  // through env, not shell expansion.
  const remoteScript = `#!/bin/bash
set -euo pipefail
KEY="$1"
ENV_FILE=/opt/inari-worker/.env
[ -f "$ENV_FILE" ] || { echo "env file missing: $ENV_FILE" >&2; exit 1; }

# Read the new value from stdin (single line, possibly with special chars).
IFS= read -r NEW_VALUE
[ -z "$NEW_VALUE" ] && { echo "empty value received on stdin" >&2; exit 1; }

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
# Pass NEW_VALUE to awk via env (NOT -v) to avoid any backslash/quote interpretation.
NEW_VALUE="$NEW_VALUE" KEY="$KEY" awk '
  BEGIN {
    k = ENVIRON["KEY"]
    v = ENVIRON["NEW_VALUE"]
    replaced = 0
  }
  {
    line = $0
    # match "KEY=anything" at start of line
    if (match(line, "^" k "=")) {
      print k "=" v
      replaced = 1
      next
    }
    print line
  }
  END {
    if (!replaced) print k "=" v
  }
' "$ENV_FILE" > "$TMP"

# Verify exactly one line with the key in the new file.
count=$(grep -c "^$KEY=" "$TMP" || true)
if [ "$count" != "1" ]; then
  echo "expected 1 line matching $KEY=, got $count" >&2
  exit 1
fi

chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

echo "  $KEY updated in $ENV_FILE (1 line)"

systemctl restart inari-worker.service
for i in 1 2 3 4 5; do
  sleep 2
  state=$(systemctl is-active inari-worker.service || true)
  if [ "$state" = "active" ]; then
    echo "  inari-worker.service active after \${i}x2s"
    exit 0
  fi
done
echo "inari-worker failed to reach active state" >&2
systemctl status inari-worker.service --no-pager 2>&1 | tail -15 >&2
exit 1
`;

  // Stage 1: ship the helper script to /tmp on the remote. No secrets in it.
  const stage = spawnSync("ssh", ["inari-staging", "cat > /tmp/sync-env-helper.sh && chmod +x /tmp/sync-env-helper.sh"], {
    input: remoteScript,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (stage.status !== 0) {
    console.error(`failed to scp helper script (exit ${stage.status})`);
    process.exit(1);
  }

  // Stage 2: invoke helper with KEY as argv, value via stdin.
  const run = spawnSync("ssh", ["inari-staging", `bash /tmp/sync-env-helper.sh "${key}"`], {
    input: value + "\n",
    stdio: ["pipe", "inherit", "inherit"],
  });

  // Stage 3: always clean up the helper.
  spawnSync("ssh", ["inari-staging", "rm -f /tmp/sync-env-helper.sh"], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  if (run.status !== 0) {
    console.error(`remote update failed (exit ${run.status})`);
    process.exit(1);
  }

  console.log("  OK — worker service running with updated env");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
