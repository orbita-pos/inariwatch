/**
 * Downloads + decompresses a replay block from R2 and dumps its event
 * structure so we can verify:
 *   - Is there a type:4 (meta) event first?
 *   - Is there a type:2 (full snapshot) event?
 *   - Are events in chronological order?
 *   - What's the captured viewport width/height?
 *
 * Usage: cd web && npx tsx scripts/inspect-replay-block.ts <sessionId> [blockIndex]
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const sessionId = process.argv[2];
  const blockIndex = parseInt(process.argv[3] ?? "0", 10);
  if (!sessionId) {
    console.error("Usage: npx tsx scripts/inspect-replay-block.ts <sessionId> [blockIndex]");
    process.exit(1);
  }

  // Load env for R2 credentials
  const env = readFileSync(".env.local", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      const [, key, rawVal] = m;
      const val = rawVal.trim().replace(/^"(.*)"$/, "$1");
      if (!process.env[key]) process.env[key] = val;
    }
  }
  const sql = neon(process.env.DATABASE_URL!);

  // Look up the session
  const rows = await sql`
    SELECT session_id, organization_id, block_count, total_bytes, started_at, duration_ms, error_fingerprints, viewport
    FROM replay_sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    console.error(`No session with sessionId=${sessionId}`);
    process.exit(1);
  }
  const session = rows[0];
  console.log("Session:", {
    sessionId: session.session_id,
    orgId: session.organization_id,
    blockCount: session.block_count,
    totalBytes: session.total_bytes,
    durationMs: session.duration_ms,
    errorFingerprints: session.error_fingerprints,
    viewport: session.viewport,
  });

  // Fetch block directly via fetchBlock helper
  const { fetchBlock, blockKey, sessionPrefix } = await import("../lib/storage/replay-storage.js");
  const prefix = sessionPrefix(session.organization_id as string, session.session_id as string);
  const key = blockKey(prefix, blockIndex);
  console.log(`\nFetching ${key} from R2 ...`);
  const events = await fetchBlock(key) as unknown[];

  console.log(`\nTotal events in block ${blockIndex}: ${events.length}`);

  // Summarize event types
  const typeCounts = new Map<string, number>();
  for (const ev of events) {
    const e = ev as { type?: number; _kind?: string };
    const label = e._kind ? `_kind="${e._kind}"` : `type=${e.type ?? "?"}`;
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
  }
  console.log("\nEvent type distribution:");
  for (const [label, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label.padEnd(20)} ${count}`);
  }

  // rrweb event types: 0=DomContentLoaded, 1=Load, 2=FullSnapshot, 3=IncrementalSnapshot, 4=Meta, 5=Custom, 6=Plugin
  const firstMetaIdx = events.findIndex((e) => (e as { type?: number }).type === 4);
  const firstFullSnapIdx = events.findIndex((e) => (e as { type?: number }).type === 2);

  console.log(`\nFirst type=4 (Meta) at index:           ${firstMetaIdx}`);
  console.log(`First type=2 (FullSnapshot) at index:   ${firstFullSnapIdx}`);

  if (firstMetaIdx >= 0) {
    const meta = events[firstMetaIdx] as { data?: { href?: string; width?: number; height?: number } };
    console.log(`  Meta data: href=${meta.data?.href}, width=${meta.data?.width}, height=${meta.data?.height}`);
  }
  if (firstFullSnapIdx < 0) {
    console.log(`\n⚠️  NO FullSnapshot in this block — replay cannot render from this alone.`);
  }

  // Check chronological ordering
  let outOfOrder = 0;
  let lastTs = 0;
  for (const ev of events) {
    const ts = (ev as { timestamp?: number }).timestamp ?? 0;
    if (ts < lastTs) outOfOrder++;
    lastTs = ts;
  }
  console.log(`\nEvents out of chronological order: ${outOfOrder} / ${events.length}`);

  // First 5 events (shallow)
  console.log("\nFirst 5 events (shallow):");
  for (let i = 0; i < Math.min(5, events.length); i++) {
    const e = events[i] as { type?: number; _kind?: string; timestamp?: number; data?: Record<string, unknown> };
    const dataKeys = e.data ? Object.keys(e.data).slice(0, 5).join(",") : "";
    console.log(`  [${i}] type=${e.type ?? "-"} _kind=${e._kind ?? "-"} ts=${e.timestamp ?? "-"} data.keys=${dataKeys}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
