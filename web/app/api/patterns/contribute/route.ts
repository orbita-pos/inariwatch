import { NextResponse } from "next/server";
import { db, errorPatterns, communityFixes } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * POST /api/patterns/contribute
 *
 * Submit an anonymized fix pattern after successful remediation.
 * Creates or updates the error pattern and adds a community fix.
 */
export async function POST(req: Request) {
  let body: {
    fingerprint: string;
    patternText: string;
    category: string;
    language?: string;
    framework?: string;
    fixApproach: string;
    fixDescription: string;
    filesChangedSummary?: string;
    confidence: number;
    userId?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.fingerprint || !body.patternText || !body.category || !body.fixApproach || !body.fixDescription) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Sanitize — strip anything that looks like secrets or PII
  const sanitized = {
    patternText: sanitize(body.patternText),
    fixApproach: sanitize(body.fixApproach),
    fixDescription: sanitize(body.fixDescription),
    filesChangedSummary: body.filesChangedSummary ? sanitize(body.filesChangedSummary) : null,
  };

  // Upsert error pattern
  let [pattern] = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.fingerprint, body.fingerprint))
    .limit(1);

  if (pattern) {
    await db
      .update(errorPatterns)
      .set({
        occurrenceCount: pattern.occurrenceCount + 1,
        lastSeenAt: new Date(),
      })
      .where(eq(errorPatterns.id, pattern.id));
  } else {
    [pattern] = await db
      .insert(errorPatterns)
      .values({
        fingerprint: body.fingerprint,
        patternText: sanitized.patternText,
        category: body.category,
        framework: body.framework ?? null,
        language: body.language ?? null,
      })
      .returning();
  }

  // Check if this exact fix approach already exists for this pattern
  const existingFixes = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.patternId, pattern.id));

  // Simple dedup: if a fix with similar approach already exists, increment its success count
  const similar = existingFixes.find((f) =>
    f.fixApproach.toLowerCase() === sanitized.fixApproach.toLowerCase()
  );

  if (similar) {
    await db
      .update(communityFixes)
      .set({
        successCount: similar.successCount + 1,
        totalApplications: similar.totalApplications + 1,
        avgConfidence: Math.round(
          (similar.avgConfidence * similar.totalApplications + body.confidence) /
          (similar.totalApplications + 1)
        ),
        updatedAt: new Date(),
      })
      .where(eq(communityFixes.id, similar.id));

    return NextResponse.json({ patternId: pattern.id, fixId: similar.id, action: "updated" });
  }

  // New fix
  const [fix] = await db
    .insert(communityFixes)
    .values({
      patternId: pattern.id,
      fixApproach: sanitized.fixApproach,
      fixDescription: sanitized.fixDescription,
      filesChangedSummary: sanitized.filesChangedSummary,
      avgConfidence: body.confidence,
      successCount: 1,
      totalApplications: 1,
      contributedBy: body.userId ?? null,
    })
    .returning({ id: communityFixes.id });

  return NextResponse.json({ patternId: pattern.id, fixId: fix.id, action: "created" });
}

// ── Sanitization ──────────────────────────────────────────────────────────────

function sanitize(text: string): string {
  let s = text;
  // Strip emails
  s = s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>");
  // Strip API keys / tokens (long alphanumeric strings)
  s = s.replace(/\b[a-zA-Z0-9_-]{32,}\b/g, "<token>");
  // Strip IP addresses
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>");
  // Strip URLs with domains (keep path structure)
  s = s.replace(/https?:\/\/[^\s"']+/g, "<url>");
  // Strip absolute file paths (keep relative structure)
  s = s.replace(/\/(?:home|Users|var|etc|opt|srv)\/[^\s"']+/g, "<path>");
  s = s.replace(/[A-Z]:\\[^\s"']+/g, "<path>");
  return s;
}
