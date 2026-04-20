import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/csp-report
 *
 * Receives Content-Security-Policy-Report-Only + (future) enforcing
 * violation reports. Accepts both the legacy `application/csp-report`
 * body shape (deprecated report-uri) and the modern
 * `application/reports+json` body (Reporting API / report-to).
 *
 * Intentionally minimal: logs to stdout (picked up by Kamal's json-file
 * driver + /admin/ops log tail) so we can watch real-world violations
 * during the Report-Only rollout without writing to the DB or burning
 * Redis keys. Once enforcing is stable, we can wire this into the alert
 * pipeline as a "security.csp_violation" alert severity=warning.
 *
 * Rate-limiting is implicit via the upstream CF custom rule on /api/*;
 * a misbehaving browser can't flood us hard enough to matter.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    const raw = await req.text();

    // Reporting API sends an array of reports; legacy sends a single object.
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = raw; }

    const reports = Array.isArray(parsed) ? parsed : [parsed];
    for (const report of reports) {
      // Only log enough to debug — no request bodies, no cookies.
      console.warn("[csp-report]", JSON.stringify({
        ct: contentType,
        report,
        ua: req.headers.get("user-agent")?.slice(0, 200),
        referer: req.headers.get("referer")?.slice(0, 500),
      }));
    }
  } catch (err) {
    console.warn("[csp-report] parse error:", err instanceof Error ? err.message : err);
  }

  // Always 204 — never leak state back to the reporter.
  return new NextResponse(null, { status: 204 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, note: "POST CSP violation reports here" });
}
