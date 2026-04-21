/**
 * Deep analysis of fix quality for sessions that generated code changes.
 *
 * For each session:
 *   - Compare fix vs original
 *   - Flag suspicious patterns: removed logic, duplicated imports,
 *     "disabled" instead of "fixed", empty handlers
 *   - Surface the diagnosis confidence vs self-review alignment
 *
 * Helps triage the "real alerts" where AI made questionable decisions.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const SUSPICIOUS_PATTERNS: Array<{ name: string; pattern: RegExp; severity: "high" | "medium" | "low" }> = [
  { name: "duplicate_import", pattern: /(import .+ from .+\n)(\s*\n)*\1/m, severity: "high" },
  { name: "disabled_path", pattern: /\/\/\s*(disabled|removed|TODO|FIXME).*chaos|bug|failing/i, severity: "medium" },
  { name: "empty_catch", pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, severity: "medium" },
  { name: "throw_away_error", pattern: /catch\s*\([^)]*\)\s*\{\s*(return|\/\/|\}\s*$)/m, severity: "low" },
  { name: "nullish_return", pattern: /return\s*(null|undefined|""|\[\])\s*;?\s*\/\/.*(suppress|silence|ignore)/i, severity: "medium" },
  { name: "removed_fetch", pattern: /\/\/\s*(removed|disabled|skipped).*fetch/i, severity: "medium" },
];

async function main() {
  const { db } = await import("../lib/db");
  const { remediationSessions, alerts } = await import("../lib/db");
  const { sql, gte, desc, eq } = await import("drizzle-orm");

  const since = new Date(Date.now() - 240 * 60 * 1000);
  const rows = await db
    .select()
    .from(remediationSessions)
    .where(sql`${remediationSessions.createdAt} >= ${since} AND ${remediationSessions.fileChanges} IS NOT NULL`)
    .orderBy(desc(remediationSessions.createdAt));

  console.log(`\n=== Fix Quality Analysis ===`);
  console.log(`Sessions with fix_files: ${rows.length}\n`);

  for (const s of rows) {
    const [alert] = await db.select().from(alerts).where(eq(alerts.id, s.alertId)).limit(1);
    const fileChanges = (s.fileChanges ?? []) as Array<{ path?: string; content?: string }>;
    if (fileChanges.length === 0) continue;

    console.log(`── ${s.id.slice(0, 8)}  conf=${s.confidenceScore}%  review=?  status=${s.status}`);
    console.log(`   alert: ${(alert?.title ?? "").slice(0, 70)}`);
    console.log(`   files: ${fileChanges.length}`);

    const joined = fileChanges.map((f) => `// ${f.path}\n${f.content ?? ""}`).join("\n\n");

    const hits: string[] = [];
    for (const p of SUSPICIOUS_PATTERNS) {
      if (p.pattern.test(joined)) hits.push(`${p.severity === "high" ? "🔴" : p.severity === "medium" ? "🟡" : "🔵"} ${p.name}`);
    }
    if (hits.length > 0) {
      console.log(`   flags: ${hits.join(", ")}`);
    } else {
      console.log(`   flags: ✅ clean`);
    }

    // Heuristic: did the fix preserve original function signature?
    for (const f of fileChanges.slice(0, 1)) {
      const firstFn = f.content?.match(/(?:function|module\.exports\s*=.*function|const\s+\w+\s*=)/);
      console.log(`   fix starts: ${(f.content ?? "").split("\n").slice(0, 1).join("").slice(0, 80)}`);
    }
    console.log(``);
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
