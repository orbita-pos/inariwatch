import { db, errorPatterns, communityFixes } from "@/lib/db";
import { desc, eq, sql } from "drizzle-orm";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Community Fixes" };

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  runtime_error:   { label: "Runtime",        color: "bg-red-900/50 text-red-400" },
  build_error:     { label: "Build",          color: "bg-amber-900/50 text-amber-400" },
  ci_error:        { label: "CI",             color: "bg-blue-900/50 text-blue-400" },
  infrastructure:  { label: "Infrastructure", color: "bg-purple-900/50 text-purple-400" },
  unknown:         { label: "Other",          color: "bg-zinc-800 text-zinc-400" },
};

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q, category } = await searchParams;

  const categoryFilter = category
    ? sql`AND ep.category = ${category}`
    : sql``;

  const textFilter = q && q.length >= 3
    ? sql`AND similarity(ep.pattern_text, ${q}) > 0.1`
    : sql``;

  const orderBy = q && q.length >= 3
    ? sql`ORDER BY similarity(ep.pattern_text, ${q}) DESC, ep.occurrence_count DESC`
    : sql`ORDER BY ep.occurrence_count DESC, ep.last_seen_at DESC`;

  const patterns = await db.execute(sql`
    SELECT
      ep.id, ep.pattern_text, ep.category, ep.framework, ep.language,
      ep.occurrence_count, ep.last_seen_at,
      (SELECT COUNT(*) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS fix_count,
      (SELECT COALESCE(MAX(cf.success_count), 0) FROM community_fixes cf WHERE cf.pattern_id = ep.id) AS best_success
    FROM error_patterns ep
    WHERE 1=1
      ${categoryFilter}
      ${textFilter}
    ${orderBy}
    LIMIT 50
  `);

  type PatternRow = {
    id: string; pattern_text: string; category: string; framework: string | null;
    language: string | null; occurrence_count: number; last_seen_at: string;
    fix_count: number; best_success: number;
  };

  const rows = (patterns.rows ?? []) as PatternRow[];

  // Get top fix for each pattern
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const [topFix] = await db
        .select({
          fixApproach: communityFixes.fixApproach,
          successCount: communityFixes.successCount,
          totalApplications: communityFixes.totalApplications,
        })
        .from(communityFixes)
        .where(eq(communityFixes.patternId, row.id))
        .orderBy(desc(communityFixes.successCount))
        .limit(1);

      return { ...row, topFix };
    })
  );

  const categories = ["runtime_error", "build_error", "ci_error", "infrastructure", "unknown"];

  return (
    <div className="mx-auto max-w-[800px]">
      <h1 className="text-2xl font-semibold mb-1">Community Fix Patterns</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Browse error patterns and community-contributed fixes from the Fix Replay database.
      </p>

      {/* Search + filter */}
      <form className="flex gap-2 mb-6">
        <input
          name="q"
          type="text"
          placeholder="Search patterns..."
          defaultValue={q ?? ""}
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        <select
          name="category"
          defaultValue={category ?? ""}
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-300"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]?.label ?? c}</option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
        >
          Search
        </button>
      </form>

      {/* Results */}
      {enriched.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-sm text-zinc-500">
            {q ? "No patterns match your search." : "No patterns yet. Patterns are added automatically when AI remediation succeeds."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {enriched.map((row) => {
            const cat = CATEGORY_LABELS[row.category] ?? CATEGORY_LABELS.unknown;
            const successRate = row.topFix && row.topFix.totalApplications > 0
              ? Math.round((row.topFix.successCount / row.topFix.totalApplications) * 100)
              : null;

            return (
              <div
                key={row.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-200 break-words">
                      {row.pattern_text.slice(0, 200)}
                    </p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${cat.color}`}>
                        {cat.label}
                      </span>
                      {row.language && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                          {row.language}
                        </span>
                      )}
                      <span className="text-xs text-zinc-600">
                        {row.occurrence_count} occurrence{row.occurrence_count !== 1 ? "s" : ""}
                      </span>
                      <span className="text-xs text-zinc-600">
                        {row.fix_count} fix{row.fix_count !== 1 ? "es" : ""}
                      </span>
                    </div>
                  </div>
                  {successRate !== null && (
                    <div className="text-right shrink-0">
                      <span className={`text-lg font-bold ${successRate >= 70 ? "text-green-400" : successRate >= 40 ? "text-amber-400" : "text-zinc-500"}`}>
                        {successRate}%
                      </span>
                      <p className="text-xs text-zinc-600">success</p>
                    </div>
                  )}
                </div>
                {row.topFix && (
                  <div className="mt-3 border-t border-zinc-800 pt-3">
                    <p className="text-xs text-zinc-500 mb-1">Top fix:</p>
                    <p className="text-xs text-zinc-400">
                      {row.topFix.fixApproach.slice(0, 200)}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
