/**
 * POST /api/prediction/check
 * File-level prediction for the VS Code extension.
 * Returns recent alerts that match the given file path.
 * Body: { file: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireExtensionAuth } from "@/lib/auth/extension";
import { getUserProjectIds } from "@/lib/db";
import { queryAlerts } from "@/lib/services/alerts.service";

export async function POST(req: NextRequest) {
  const auth = await requireExtensionAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const body = await req.json().catch(() => null);
  const file = body?.file as string | undefined;
  if (!file) return NextResponse.json({ error: "Missing file" }, { status: 400 });

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return NextResponse.json({ result: { predictions: [], overallRisk: "low", summary: "No projects" } });
  }

  // Get recent unresolved alerts and match against the file path
  const recent = await queryAlerts({ projectIds, isResolved: false, limit: 100 });

  const predictions = recent
    .filter((a) => {
      const text = `${a.title ?? ""}\n${a.body ?? ""}`;
      // Match if the alert mentions the file (by name or partial path)
      const fileName = file.split("/").pop() ?? file;
      return text.includes(file) || text.includes(fileName);
    })
    .slice(0, 10)
    .map((a) => {
      const lines = (a.body ?? "").match(/:(\d+):/);
      return {
        error: a.title ?? "Unknown error",
        file,
        line: lines ? parseInt(lines[1], 10) : 1,
        confidence: a.severity === "critical" ? 90 : a.severity === "warning" ? 70 : 50,
        reason: a.aiReasoning?.slice(0, 200) ?? "Matched from recent alerts",
        suggestedFix: "",
      };
    });

  const overallRisk = predictions.some((p) => p.confidence >= 90)
    ? "high"
    : predictions.length > 0
      ? "medium"
      : "low";

  return NextResponse.json({
    result: {
      predictions,
      overallRisk,
      summary: predictions.length > 0
        ? `${predictions.length} known issue(s) affect this file`
        : "No known issues for this file",
    },
  });
}
