/**
 * Extract training dataset for the alert triage classifier.
 *
 * Queries the alerts + remediationSessions tables to label each alert with
 * one of: auto_fix, triage_only, full_remediation.
 *
 * Output: JSONL file ready for OpenAI fine-tuning API.
 *
 * Labeling logic:
 *   - auto_fix:          Remediation completed with confidence >= 80 AND self-review >= 80
 *                         AND attempt == 1 (fixed on first try = easy pattern)
 *   - triage_only:       Alert was resolved manually (no remediation session)
 *                         OR remediation was cancelled/never started
 *                         OR alert is a warning/info with no fix needed
 *   - full_remediation:  Remediation needed multiple attempts OR confidence < 80
 *                         OR self-review flagged/rejected
 *
 * Usage:
 *   npx tsx scripts/extract-classifier-dataset.ts > classifier-dataset.jsonl
 *
 * Then fine-tune:
 *   openai api fine_tuning.jobs.create \
 *     -t classifier-dataset.jsonl \
 *     -m gpt-4o-mini-2024-07-18
 */

import { db, alerts, remediationSessions } from "@/lib/db";
import { eq, isNotNull, desc } from "drizzle-orm";

interface TrainingExample {
  messages: {
    role: "system" | "user" | "assistant";
    content: string;
  }[];
}

function labelAlert(
  alert: {
    severity: string;
    isResolved: boolean;
    aiReasoning: string | null;
  },
  remediation: {
    status: string;
    attempt: number;
    confidenceScore: number | null;
    selfReviewResult: { score?: number; recommendation?: string } | null;
  } | null,
): "auto_fix" | "triage_only" | "full_remediation" {
  // No remediation session → triage only
  if (!remediation) {
    return "triage_only";
  }

  // Cancelled or failed without any attempt → triage only
  if (remediation.status === "cancelled") {
    return "triage_only";
  }

  // Failed → was hard, needs full remediation
  if (remediation.status === "failed") {
    return "full_remediation";
  }

  // Completed on first attempt with high confidence → auto_fix pattern
  if (
    remediation.status === "completed" &&
    remediation.attempt === 1 &&
    (remediation.confidenceScore ?? 0) >= 80 &&
    (remediation.selfReviewResult?.score ?? 0) >= 80
  ) {
    return "auto_fix";
  }

  // Completed but needed retries or low confidence → full remediation
  return "full_remediation";
}

async function main() {
  // Fetch all alerts that have AI reasoning (were analyzed)
  const allAlerts = await db
    .select({
      id: alerts.id,
      title: alerts.title,
      body: alerts.body,
      severity: alerts.severity,
      sourceIntegrations: alerts.sourceIntegrations,
      isResolved: alerts.isResolved,
      aiReasoning: alerts.aiReasoning,
    })
    .from(alerts)
    .where(isNotNull(alerts.aiReasoning))
    .orderBy(desc(alerts.createdAt))
    .limit(10000);

  let autoFix = 0;
  let triageOnly = 0;
  let fullRemediation = 0;

  for (const alert of allAlerts) {
    // Get the latest remediation session for this alert
    const [remediation] = await db
      .select({
        status: remediationSessions.status,
        attempt: remediationSessions.attempt,
        confidenceScore: remediationSessions.confidenceScore,
        selfReviewResult: remediationSessions.selfReviewResult,
      })
      .from(remediationSessions)
      .where(eq(remediationSessions.alertId, alert.id))
      .orderBy(desc(remediationSessions.createdAt))
      .limit(1);

    const label = labelAlert(
      alert,
      remediation
        ? {
            ...remediation,
            selfReviewResult: remediation.selfReviewResult as { score?: number; recommendation?: string } | null,
          }
        : null,
    );

    switch (label) {
      case "auto_fix": autoFix++; break;
      case "triage_only": triageOnly++; break;
      case "full_remediation": fullRemediation++; break;
    }

    const example: TrainingExample = {
      messages: [
        {
          role: "system",
          content: "Classify this alert into one of: auto_fix, triage_only, full_remediation. Respond with JSON: {\"class\":\"...\",\"confidence\":0.0-1.0,\"reason\":\"...\"}",
        },
        {
          role: "user",
          content: `severity: ${alert.severity}\nsource: ${alert.sourceIntegrations.join(",")}\ntitle: ${alert.title}\nbody: ${(alert.body ?? "").slice(0, 500)}`,
        },
        {
          role: "assistant",
          content: JSON.stringify({
            class: label,
            confidence: 0.95,
            reason: label === "auto_fix"
              ? "known pattern, fixed on first attempt with high confidence"
              : label === "triage_only"
                ? "resolved without code fix"
                : "complex issue requiring full AI analysis",
          }),
        },
      ],
    };

    // Output as JSONL (one JSON object per line)
    console.log(JSON.stringify(example));
  }

  // Print stats to stderr (won't pollute JSONL output)
  console.error(`\nDataset extracted:`);
  console.error(`  auto_fix:          ${autoFix} (${((autoFix / allAlerts.length) * 100).toFixed(1)}%)`);
  console.error(`  triage_only:       ${triageOnly} (${((triageOnly / allAlerts.length) * 100).toFixed(1)}%)`);
  console.error(`  full_remediation:  ${fullRemediation} (${((fullRemediation / allAlerts.length) * 100).toFixed(1)}%)`);
  console.error(`  total:             ${allAlerts.length}`);
  console.error(`\nNext steps:`);
  console.error(`  1. Review the .jsonl file for quality`);
  console.error(`  2. Upload: openai api fine_tuning.jobs.create -t classifier-dataset.jsonl -m gpt-4o-mini-2024-07-18`);
  console.error(`  3. Set ALERT_CLASSIFIER_MODEL=ft:gpt-4o-mini-2024-07-18:your-org::job-id in .env`);

  process.exit(0);
}

main();
