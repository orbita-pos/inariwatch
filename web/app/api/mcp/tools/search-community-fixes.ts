import { db, errorPatterns, communityFixes } from "@/lib/db";
import { sql, desc } from "drizzle-orm";
import type { McpUser } from "../auth";

export async function execute(
  args: Record<string, unknown>,
  _user: McpUser
): Promise<string> {
  const query = args.query as string;
  if (!query) return "Error: query is required.";

  const limit = Math.min(Number(args.limit) || 5, 20);

  // Trigram similarity search on pattern_text
  const results = await db.execute(sql`
    SELECT
      p.id AS pattern_id,
      p.pattern_text,
      p.category,
      p.framework,
      p.language,
      p.occurrence_count,
      cf.id AS fix_id,
      cf.fix_approach,
      cf.fix_description,
      cf.avg_confidence,
      cf.success_count,
      cf.total_applications
    FROM error_patterns p
    LEFT JOIN community_fixes cf ON cf.pattern_id = p.id
    WHERE similarity(p.pattern_text, ${query}) > 0.1
    ORDER BY similarity(p.pattern_text, ${query}) DESC, cf.success_count DESC
    LIMIT ${limit * 3}
  `);

  const rows = results.rows as Array<Record<string, unknown>>;
  if (rows.length === 0) return `No community fixes found for: ${query}`;

  // Group by pattern
  const patterns = new Map<string, { pattern: Record<string, unknown>; fixes: Array<Record<string, unknown>> }>();

  for (const r of rows) {
    const pid = r.pattern_id as string;
    if (!patterns.has(pid)) {
      patterns.set(pid, {
        pattern: {
          patternText: r.pattern_text,
          category: r.category,
          framework: r.framework,
          language: r.language,
          occurrences: r.occurrence_count,
        },
        fixes: [],
      });
    }
    if (r.fix_id) {
      patterns.get(pid)!.fixes.push({
        approach: r.fix_approach,
        description: r.fix_description,
        confidence: r.avg_confidence,
        successCount: r.success_count,
        total: r.total_applications,
      });
    }
  }

  let out = `Community fixes for "${query}"\n${"=".repeat(50)}\n\n`;
  let i = 0;
  for (const [, { pattern, fixes }] of patterns) {
    if (i >= limit) break;
    i++;

    out += `${i}. Pattern: ${pattern.patternText}\n`;
    out += `   Category: ${pattern.category}`;
    if (pattern.framework) out += ` | Framework: ${pattern.framework}`;
    if (pattern.language) out += ` | Language: ${pattern.language}`;
    out += ` | Seen ${pattern.occurrences}x\n`;

    for (const fix of fixes.slice(0, 3)) {
      const total = Number(fix.total) || 0;
      const success = Number(fix.successCount) || 0;
      const pct = total > 0 ? `${Math.round((success / total) * 100)}% success (${success}/${total})` : "new fix";
      out += `   Fix: ${fix.approach} — ${fix.description}\n`;
      out += `        Confidence: ${fix.confidence}% | ${pct}\n`;
    }
    out += "\n";
  }

  return out;
}
