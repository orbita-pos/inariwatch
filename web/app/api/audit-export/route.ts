/**
 * POST /api/audit-export
 *
 * Builds and streams the compliance audit ZIP for the caller's selected
 * organization + date range + standard. See `lib/services/audit-export.ts`
 * for the bundle layout and crypto verification model.
 *
 * Request JSON body:
 *   {
 *     organizationId: string | null,
 *     standard: "soc2" | "pci" | "hipaa" | "gdpr",
 *     startDate: ISO-8601,
 *     endDate:   ISO-8601
 *   }
 *
 * Response: application/zip body, Content-Disposition: attachment.
 *
 * Authorization:
 *   - Authenticated user only.
 *   - User must belong to (or own) the org.
 *   - Plan gate via `isExportAllowedForUser`.
 *
 * Rate limit: 3 exports per 5 minutes per user — building the bundle
 * touches the whole receipt range and we don't want a runaway browser
 * tab to hammer Postgres.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { rateLimit } from "@/lib/auth-rate-limit";
import { logAudit } from "@/lib/audit";
import {
  buildAuditExport,
  isExportAllowedForUser,
  isOrgMember,
  STANDARDS,
  type ComplianceStandard,
} from "@/lib/services/audit-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_STANDARDS = new Set<ComplianceStandard>(
  STANDARDS.map((s) => s.id),
);

interface RequestBody {
  organizationId?: string | null;
  standard?: string;
  startDate?: string;
  endDate?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Plan gate — beta returns true for everyone, post-beta returns true
  // only for `plan === 'pro'`.
  if (!(await isExportAllowedForUser(userId))) {
    return NextResponse.json(
      { error: "Compliance audit export requires a paid plan." },
      { status: 402 },
    );
  }

  const rl = await rateLimit("audit-export:create", userId, {
    windowMs: 5 * 60_000,
    max: 3,
  });
  if (!rl.allowed) {
    const retryAfter = rl.retryAfterSeconds ?? 60;
    return NextResponse.json(
      { error: "Too many export requests", retryAfterSeconds: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const standard = body.standard as ComplianceStandard | undefined;
  if (!standard || !VALID_STANDARDS.has(standard)) {
    return NextResponse.json(
      {
        error: `standard must be one of: ${[...VALID_STANDARDS].join(", ")}`,
      },
      { status: 400 },
    );
  }

  const organizationId =
    typeof body.organizationId === "string" && body.organizationId.length > 0
      ? body.organizationId
      : null;

  if (organizationId !== null && !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    return NextResponse.json(
      { error: "organizationId must be a UUID or null" },
      { status: 400 },
    );
  }

  if (!body.startDate || !body.endDate) {
    return NextResponse.json(
      { error: "startDate and endDate are required (ISO-8601)" },
      { status: 400 },
    );
  }

  const startDate = new Date(body.startDate);
  const endDate = new Date(body.endDate);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return NextResponse.json(
      { error: "startDate / endDate must be valid ISO-8601 strings" },
      { status: 400 },
    );
  }

  if (!(await isOrgMember(userId, organizationId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let bundle;
  try {
    bundle = await buildAuditExport({
      userId,
      organizationId,
      standard,
      startDate,
      endDate,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // validateDateRange / standard lookup throw on input issues — surface
    // as 400 rather than 500 so the client can correct the form.
    if (
      msg === "invalid date range" ||
      msg === "startDate must be <= endDate" ||
      msg === "date range cannot exceed 366 days"
    ) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[audit-export] build failed:", msg);
    return NextResponse.json(
      { error: "Failed to build audit export" },
      { status: 500 },
    );
  }

  await logAudit({
    userId,
    action: "compliance.export",
    resource: "audit-export",
    resourceId: organizationId ?? undefined,
    metadata: {
      standard,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      receiptCount: bundle.receiptCount,
      signedCount: bundle.signedCount,
      bytes: bundle.bytes,
    },
  });

  // Wrap in a Node Buffer so the NextResponse BodyInit signature accepts
  // it (BodyInit doesn't list bare Uint8Array). Buffer extends Uint8Array
  // — same bytes, no copy.
  return new NextResponse(Buffer.from(bundle.zip), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(bundle.bytes),
      "content-disposition": `attachment; filename="${bundle.filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-receipt-count": String(bundle.receiptCount),
      "x-signed-count": String(bundle.signedCount),
    },
  });
}
