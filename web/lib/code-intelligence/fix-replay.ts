/**
 * Fix Replay — vectorized fix history for better remediation.
 *
 * When a fix completes successfully, we embed the context (diagnosis + files + result)
 * and store it. When a similar error arrives, we vector-search past fixes to provide
 * "this function was fixed 3 times, here's what worked" context.
 */

import { db, remediationSessions } from "@/lib/db";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { embedTexts, embedQuery, EMBEDDING_DIMS } from "./embeddings";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FixReplayHint {
  sessionId: string;
  diagnosis: string;
  filesFixed: string[];
  explanation: string;
  confidence: number;
  similarity: number;
}

// ── Record a completed fix (called after successful remediation) ─────────────

export async function recordFixEmbedding(
  sessionId: string,
  embeddingKey: string
): Promise<void> {
  // Fetch the session
  const [session] = await db
    .select({
      context: remediationSessions.context,
      fileChanges: remediationSessions.fileChanges,
      confidenceScore: remediationSessions.confidenceScore,
      repo: remediationSessions.repo,
      projectId: remediationSessions.projectId,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.id, sessionId))
    .limit(1);

  if (!session) return;

  // Build the text to embed: diagnosis + files changed + repo context
  const context = session.context as Record<string, unknown> | null;
  const fileChanges = session.fileChanges as { path: string; content?: string }[] | null;

  const parts: string[] = [];

  // Add diagnostic context
  if (context) {
    if (context.sentryStackTrace) parts.push(`Stack trace: ${String(context.sentryStackTrace).slice(0, 500)}`);
    if (context.vercelBuildLogs) parts.push(`Build logs: ${String(context.vercelBuildLogs).slice(0, 500)}`);
    if (context.githubCILogs) parts.push(`CI logs: ${String(context.githubCILogs).slice(0, 500)}`);
  }

  // Add files that were fixed
  if (fileChanges?.length) {
    const fileList = fileChanges.map((f) => f.path).join(", ");
    parts.push(`Files fixed: ${fileList}`);
    // Include a snippet of each fix
    for (const f of fileChanges.slice(0, 3)) {
      if (f.content) parts.push(`Fix in ${f.path}:\n${f.content.slice(0, 500)}`);
    }
  }

  if (parts.length === 0) return;

  const text = parts.join("\n\n").slice(0, 4000);

  try {
    const [embedding] = await embedTexts([text], embeddingKey, "document");
    if (!embedding) return;

    const vec = `[${embedding.join(",")}]`;
    await db.execute(
      sql`UPDATE remediation_sessions SET fix_embedding = ${vec}::vector WHERE id = ${sessionId}::uuid`
    );
  } catch {
    // Non-critical — fix still works without embedding
  }
}

// ── Search past fixes by similarity ──────────────────────────────────────────

export async function searchFixReplay(
  query: string,
  projectId: string,
  embeddingKey: string,
  limit = 3
): Promise<FixReplayHint[]> {
  const queryEmbedding = await embedQuery(query, embeddingKey);
  if (!queryEmbedding) return [];

  const vec = `[${queryEmbedding.join(",")}]`;

  const results = await db.execute<{
    id: string;
    context: unknown;
    file_changes: unknown;
    confidence_score: number | null;
    distance: number;
  }>(sql`
    SELECT
      id, context, file_changes, confidence_score,
      (fix_embedding <=> ${vec}::vector) AS distance
    FROM remediation_sessions
    WHERE project_id = ${projectId}::uuid
      AND status = 'completed'
      AND fix_embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `);

  return results.rows
    .filter((r) => r.distance < 0.5) // Only return reasonably similar results
    .map((r) => {
      const context = r.context as Record<string, unknown> | null;
      const fileChanges = r.file_changes as { path: string }[] | null;

      return {
        sessionId: r.id,
        diagnosis: context?.diagnosis as string ?? "Unknown",
        filesFixed: fileChanges?.map((f) => f.path) ?? [],
        explanation: context?.explanation as string ?? "",
        confidence: r.confidence_score ?? 0,
        similarity: 1 - r.distance,
      };
    });
}
