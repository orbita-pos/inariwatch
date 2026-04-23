/**
 * Fase 5 shadow-run monitor — queries sandbox_audit_log to verify the
 * CodeAct runner is actually being spawned once CODEACT_ENABLED=true.
 *
 * Run:
 *   cd web && npx tsx scripts/check-sandbox-audit.ts
 *   cd web && npx tsx scripts/check-sandbox-audit.ts --since=30m
 *
 * Default window: last 30 minutes. Prints one row per invocation +
 * aggregate success rate + p50/p95 duration — the 3 numbers the
 * arch doc §Fase 5 acceptance criteria want (≥95% success, ≤60s cap,
 * no unexplained failures).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

function parseSinceFlag(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--since="));
  if (!flag) return 30;
  const v = flag.slice("--since=".length);
  const m = /^(\d+)(m|h|d)?$/.exec(v);
  if (!m) return 30;
  const n = parseInt(m[1], 10);
  const unit = m[2] ?? "m";
  if (unit === "h") return n * 60;
  if (unit === "d") return n * 60 * 24;
  return n;
}

async function main() {
  const sinceMin = parseSinceFlag(process.argv.slice(2));
  const since = new Date(Date.now() - sinceMin * 60 * 1000);

  const { db } = await import("../lib/db");
  const { sandboxAuditLog, remediationSessions } = await import("../lib/db");
  const { gte, desc, eq } = await import("drizzle-orm");

  const rows = await db
    .select({
      id: sandboxAuditLog.id,
      sessionId: sandboxAuditLog.sessionId,
      codeHash: sandboxAuditLog.codeHash,
      purpose: sandboxAuditLog.purpose,
      durationMs: sandboxAuditLog.durationMs,
      resultSizeBytes: sandboxAuditLog.resultSizeBytes,
      success: sandboxAuditLog.success,
      error: sandboxAuditLog.error,
      createdAt: sandboxAuditLog.createdAt,
    })
    .from(sandboxAuditLog)
    .where(gte(sandboxAuditLog.createdAt, since))
    .orderBy(desc(sandboxAuditLog.createdAt))
    .limit(200);

  console.log(`sandbox_audit_log rows in last ${sinceMin}m: ${rows.length}`);
  if (rows.length === 0) {
    console.log("  (no invocations — either CODEACT_ENABLED=false, or no remediation triggered execute_plan)");
    process.exit(0);
  }

  // Aggregates
  const success = rows.filter((r) => r.success).length;
  const fail = rows.length - success;
  const successRate = ((success / rows.length) * 100).toFixed(1);
  const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const avgSize = Math.round(rows.reduce((s, r) => s + r.resultSizeBytes, 0) / rows.length);

  console.log(`  success=${success} fail=${fail} rate=${successRate}%`);
  console.log(`  duration  p50=${p50}ms  p95=${p95}ms  (60000ms wall-clock cap)`);
  console.log(`  avg result size: ${avgSize}B (64KB stdout cap)`);

  // Purposes breakdown
  const byPurpose = new Map<string, { ok: number; err: number }>();
  for (const r of rows) {
    const p = r.purpose.slice(0, 40);
    const cur = byPurpose.get(p) ?? { ok: 0, err: 0 };
    if (r.success) cur.ok++;
    else cur.err++;
    byPurpose.set(p, cur);
  }
  console.log(`\n  breakdown by purpose:`);
  for (const [p, c] of [...byPurpose.entries()].sort((a, b) => b[1].ok + b[1].err - a[1].ok - a[1].err)) {
    console.log(`    ${p.padEnd(40)}  ok=${c.ok}  err=${c.err}`);
  }

  // Recent rows with session status
  console.log(`\n  most recent 10 invocations:`);
  for (const r of rows.slice(0, 10)) {
    const [sess] = r.sessionId
      ? await db
          .select({ status: remediationSessions.status })
          .from(remediationSessions)
          .where(eq(remediationSessions.id, r.sessionId))
          .limit(1)
      : [{ status: "—" }];
    const mark = r.success ? "✓" : "✗";
    const errTail = r.error ? ` err="${r.error.slice(0, 60)}"` : "";
    console.log(
      `    ${mark} ${r.createdAt.toISOString().slice(11, 19)}  ` +
      `session=${r.sessionId?.slice(0, 8) ?? "—       "}  ` +
      `status=${(sess?.status ?? "—").padEnd(18)}  ` +
      `${r.durationMs}ms  hash=${r.codeHash.slice(0, 8)}  purpose="${r.purpose.slice(0, 30)}"${errTail}`
    );
  }

  // Compare against acceptance criteria
  console.log(`\n  Fase 5 acceptance readout:`);
  console.log(`    [${rows.length >= 20 ? "✓" : " "}] 20+ invocations (have ${rows.length})`);
  console.log(`    [${parseFloat(successRate) >= 95 ? "✓" : " "}] ≥95% success rate (have ${successRate}%)`);
  console.log(`    [${p95 < 60_000 ? "✓" : " "}] p95 under 60s wall cap (have ${p95}ms)`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
