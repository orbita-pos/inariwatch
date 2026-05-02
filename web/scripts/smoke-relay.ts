/**
 * v0.3 S2 acceptance smoke — exercises the WS relay path end-to-end.
 *
 * Pre-requisites:
 *   - inari-relay running locally (services/relay/ — `go run .`)
 *   - Inari Live running locally and connected to the relay
 *     (or simulate via tools/fake-sidecar.ts in S3)
 *   - .env.local with RELAY_URL, RELAY_DISPATCH_SECRET, INARI_LIVE_RELAY_JWT_KEY
 *
 * Usage:
 *   USER_ID=demo-user npx tsx scripts/smoke-relay.ts
 *
 * Pass criteria:
 *   - Dispatch returns within 5s.
 *   - Receipt emitted with substrate="user-sidecar" + relayPath="relay".
 *   - userSidecarReceipt non-null when the sidecar signed.
 */

import { dispatch, registerReceiptSink, TASKS } from "@inariwatch/ai-router";

const userId = process.env.USER_ID;
if (!userId) {
  console.error("smoke-relay: set USER_ID to the connected sidecar's user_id.");
  process.exit(1);
}
if (!process.env.RELAY_URL || !process.env.RELAY_DISPATCH_SECRET) {
  console.error(
    "smoke-relay: set RELAY_URL + RELAY_DISPATCH_SECRET in .env.local.",
  );
  process.exit(1);
}

const receipts: any[] = [];
registerReceiptSink((r) => receipts.push(r));

async function main() {
  const t0 = Date.now();
  const out = await dispatch({
    mode: "complete",
    task: TASKS.NOTIFY_COMPOSE_EMAIL,
    apiKey: "sk-not-used-on-sidecar",
    systemPrompt: "You compose alert emails on behalf of the user.",
    messages: [
      {
        role: "user",
        content: "Compose a one-line alert about a deploy failure.",
      },
    ],
    workspace: {
      userId,
      preferences: {
        taskOverrides: {
          [TASKS.NOTIFY_COMPOSE_EMAIL]: {
            substrate: "user-sidecar",
            model: "llama-3.2-3b-q4",
          },
        },
      },
    },
  });
  const elapsed = Date.now() - t0;

  if (out.mode !== "complete") {
    console.error("✗ unexpected output mode:", out);
    process.exit(2);
  }
  console.log(`✓ dispatch returned in ${elapsed}ms`);
  console.log("  text:", out.response.text);

  const r = receipts[0];
  if (!r) {
    console.error("✗ no receipt emitted");
    process.exit(2);
  }
  console.log("  substrate:", r.substrate);
  console.log("  provider:", r.provider);
  console.log("  relayPath:", r.relayPath);
  console.log("  userSidecarReceipt:", r.userSidecarReceipt ? "present" : "(none)");
  if (r.substrate !== "user-sidecar") {
    console.error("✗ expected substrate=user-sidecar (was the sidecar online?)");
    process.exit(3);
  }
  if (r.relayPath !== "relay") {
    console.error("✗ expected relayPath=relay");
    process.exit(3);
  }
  if (elapsed > 200) {
    console.warn(
      `! latency ${elapsed}ms above 200ms target (acceptable on first cold start)`,
    );
  }
  console.log("\n✓ relay smoke pass");
}

main().catch((err) => {
  console.error("✗ unhandled:", err);
  process.exit(99);
});
