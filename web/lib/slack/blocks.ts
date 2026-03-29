import type { KnownBlock, Block } from "@slack/web-api";

const SEVERITY_EMOJI: Record<string, string> = {
  critical: ":red_circle:",
  warning: ":large_orange_circle:",
  info: ":large_blue_circle:",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#e74c3c",
  warning: "#f39c12",
  info: "#3498db",
};

// ── Alert message ────────────────────────────────────────────────────────────

export function buildAlertBlocks(
  alert: { id: string; title: string; body: string; severity: string; sourceIntegrations?: string[] | null; createdAt?: Date | null },
  projectName: string,
  aiDiagnosis: string | null,
): { blocks: KnownBlock[]; text: string; color: string } {
  const emoji = SEVERITY_EMOJI[alert.severity] || ":white_circle:";
  const color = SEVERITY_COLOR[alert.severity] || "#95a5a6";
  const truncatedBody = alert.body?.slice(0, 500) || "";
  const sources = alert.sourceIntegrations?.join(", ") || "unknown";

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${escapeSlack(alert.title)}*`,
      },
    },
  ];

  // Stack trace
  if (truncatedBody && truncatedBody !== alert.title) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```" + escapeSlack(truncatedBody) + "```",
      },
    });
  }

  // AI Diagnosis
  if (aiDiagnosis) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*AI Diagnosis:*\n${escapeSlack(aiDiagnosis.slice(0, 800))}`,
      },
    });
  }

  // Context
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `*Project:* ${escapeSlack(projectName)}` },
      { type: "mrkdwn", text: `*Source:* ${escapeSlack(sources)}` },
      { type: "mrkdwn", text: `*Severity:* ${alert.severity}` },
    ],
  });

  // Action buttons
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Fix It" },
        style: "danger",
        action_id: "fix_alert",
        value: alert.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Acknowledge" },
        action_id: "ack_alert",
        value: alert.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Resolve" },
        style: "primary",
        action_id: "resolve_alert",
        value: alert.id,
      },
    ],
  });

  const text = `${emoji} [${alert.severity.toUpperCase()}] ${alert.title}`;
  return { blocks, text, color };
}

// ── Remediation progress ─────────────────────────────────────────────────────

const STEP_EMOJI: Record<string, string> = {
  completed: ":white_check_mark:",
  running: ":hourglass_flowing_sand:",
  failed: ":x:",
};

export function buildRemediationStepText(
  step: { type: string; message: string; status: string },
): string {
  const emoji = STEP_EMOJI[step.status] || ":gear:";
  return `${emoji} ${escapeSlack(step.message)}`;
}

export function buildRemediationCompleteBlocks(
  prUrl: string | null,
  confidence: number,
  autoMerged: boolean,
  sessionId?: string,
  eapReceipt?: { verified: boolean; chainDepth: number; surfaces: { httpEndpoints: string[]; dbTables: string[]; llmCalls: { provider: string; model: string }[] } } | null,
): KnownBlock[] {
  const confBadge = confidence >= 80 ? ":green_circle:" : confidence >= 50 ? ":large_orange_circle:" : ":red_circle:";

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: autoMerged
          ? `:rocket: *Fix auto-merged!* Confidence: ${confBadge} ${confidence}%`
          : `:pull_request: *Draft PR created.* Confidence: ${confBadge} ${confidence}%`,
      },
    },
  ];

  // EAP verification chain
  if (eapReceipt) {
    const verifiedEmoji = eapReceipt.verified ? ":lock:" : ":warning:";
    const verifiedText = eapReceipt.verified ? "Chain verified" : "Chain NOT verified";
    const surfaceParts: string[] = [];
    if (eapReceipt.surfaces.httpEndpoints.length > 0) surfaceParts.push(`${eapReceipt.surfaces.httpEndpoints.length} HTTP endpoints`);
    if (eapReceipt.surfaces.dbTables.length > 0) surfaceParts.push(`${eapReceipt.surfaces.dbTables.length} DB tables`);
    if (eapReceipt.surfaces.llmCalls.length > 0) surfaceParts.push(`${eapReceipt.surfaces.llmCalls.length} LLM calls`);
    const surfaceLine = surfaceParts.length > 0 ? surfaceParts.join(" · ") : "No surfaces recorded";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${verifiedEmoji} *EAP Verification* — ${verifiedText}\nChain depth: ${eapReceipt.chainDepth} | ${surfaceLine}`,
      },
    });
  }

  if (prUrl) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `<${prUrl}|View Pull Request>` },
    });
  }

  if (!autoMerged && prUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve & Merge" },
          style: "primary",
          action_id: "approve_remediation",
          value: sessionId || "",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "cancel_remediation",
          value: sessionId || "",
        },
      ],
    });
  }

  return blocks;
}

// ── Incident storm ───────────────────────────────────────────────────────────

export function buildIncidentStormBlocks(
  alertCount: number,
  projectName: string,
  recentTitles: string[],
): KnownBlock[] {
  const titleList = recentTitles.slice(0, 5).map((t) => `• ${escapeSlack(t)}`).join("\n");

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `:rotating_light: Incident Storm — ${projectName}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${alertCount} alerts* in the last 5 minutes.\n\n${titleList}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Generate Postmortem" },
          action_id: "generate_postmortem",
        },
      ],
    },
  ];
}

// ── Deploy ───────────────────────────────────────────────────────────────────

export function buildDeployBlocks(
  projectName: string,
  branch: string,
  status: "success" | "failed",
): KnownBlock[] {
  const emoji = status === "success" ? ":white_check_mark:" : ":x:";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *Deploy ${status}* — ${escapeSlack(projectName)} (${escapeSlack(branch)})\n_Monitoring error rate for 15 minutes..._`,
      },
    },
  ];
}

export function buildDeployFollowUpBlocks(
  healthy: boolean,
  errorCount: number,
): KnownBlock[] {
  if (healthy) {
    return [{
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: Deploy looks healthy. ${errorCount} errors in monitoring window.` },
    }];
  }
  return [{
    type: "section",
    text: { type: "mrkdwn", text: `:warning: Deploy may be causing issues. ${errorCount} errors detected in monitoring window.` },
  }];
}

// ── On-call ──────────────────────────────────────────────────────────────────

export function buildOnCallBlocks(
  rotations: { projectName: string; userName: string | null; level: number }[],
): KnownBlock[] {
  if (rotations.length === 0) {
    return [{
      type: "section",
      text: { type: "mrkdwn", text: "No on-call schedules configured." },
    }];
  }

  const lines = rotations.map((r) =>
    `• *${escapeSlack(r.projectName)}:* ${r.userName ? escapeSlack(r.userName) : "_No one on call_"} (L${r.level})`
  );

  return [{
    type: "section",
    text: { type: "mrkdwn", text: `*On-Call Rotation*\n\n${lines.join("\n")}` },
  }];
}

// ── Status overview ──────────────────────────────────────────────────────────

export function buildStatusBlocks(
  openAlerts: number,
  criticalCount: number,
  onCallUser: string | null,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: ":bar_chart: InariWatch Status" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Open Alerts:* ${openAlerts}` },
        { type: "mrkdwn", text: `*Critical:* ${criticalCount}` },
        { type: "mrkdwn", text: `*On-Call:* ${onCallUser || "None"}` },
      ],
    },
  ];
}

// ── Postmortem ───────────────────────────────────────────────────────────────

export function buildPostmortemBlocks(
  postmortem: string,
  alertTitle: string,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `:page_facing_up: Postmortem — ${alertTitle.slice(0, 50)}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: escapeSlack(postmortem.slice(0, 2900)) },
    },
  ];
}

// ── Shadow replay ────────────────────────────────────────────────────────────

export function buildShadowReplayBlocks(
  replay: { totalRecordings: number; passed: number; failed: number; riskScore: number; riskLevel: string },
): KnownBlock[] {
  const emoji = replay.failed === 0 ? ":white_check_mark:" : ":x:";
  const riskEmoji = replay.riskScore >= 71 ? ":red_circle:" : replay.riskScore >= 41 ? ":large_orange_circle:" : ":green_circle:";

  return [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `${emoji} *Shadow Execution* — Replayed ${replay.totalRecordings} production recordings`,
        `Passed: ${replay.passed} | Failed: ${replay.failed}`,
        `${riskEmoji} Risk score: ${replay.riskScore}/100 (${replay.riskLevel})`,
      ].join("\n"),
    },
  }];
}

// ── PR prediction ────────────────────────────────────────────────────────────

export function buildPRPredictionBlocks(
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  predictionMarkdown: string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Prediction: PR #${prNumber} may cause an error*\n<https://github.com/${escapeSlack(owner)}/${escapeSlack(repo)}/pull/${prNumber}|${escapeSlack(prTitle)}>`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: escapeSlack(predictionMarkdown.replace(/^[-\n#>*]+/gm, "").trim().slice(0, 600)),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PR" },
          url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
          action_id: "view_pr",
        },
      ],
    },
  ];
}

// ── Community fix ────────────────────────────────────────────────────────────

export function buildCommunityFixBlocks(
  match: {
    occurrenceCount: number;
    successRate: number;
    successCount: number;
    totalApplications: number;
    fixApproach: string;
    filesChanged: string[];
  },
  alertId: string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `:bulb: *Community Fix Available*`,
          `${match.occurrenceCount} team${match.occurrenceCount > 1 ? "s" : ""} hit this error. Fix success rate: *${match.successRate}%* (${match.successCount}/${match.totalApplications})`,
          ``,
          `*Approach:* ${escapeSlack(match.fixApproach.slice(0, 300))}`,
          match.filesChanged.length > 0 ? `*Files:* ${match.filesChanged.map((f) => "`" + f + "`").join(", ")}` : "",
        ].filter(Boolean).join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Apply Community Fix" },
          style: "primary",
          action_id: "apply_community_fix",
          value: alertId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Custom Fix Instead" },
          action_id: "fix_alert",
          value: alertId,
        },
      ],
    },
  ];
}

// ── Substrate recording ──────────────────────────────────────────────────────

export function buildRecordingBlocks(
  recording: {
    recordingId: string;
    durationMs: number | null;
    eventCount: number | null;
    categories: Record<string, number> | null;
    context: string | null;
  },
  appUrl: string,
): KnownBlock[] {
  const categories = recording.categories || {};
  const duration = recording.durationMs ? `${(recording.durationMs / 1000).toFixed(1)}s` : "unknown";

  // Build I/O summary line
  const parts: string[] = [];
  if (categories.http_requests) parts.push(`${categories.http_requests} HTTP calls`);
  if (categories.db_queries) parts.push(`${categories.db_queries} DB queries`);
  if (categories.file_reads || categories.file_writes) {
    const fileOps = (categories.file_reads || 0) + (categories.file_writes || 0);
    parts.push(`${fileOps} file ops`);
  }
  if (categories.dns_resolves) parts.push(`${categories.dns_resolves} DNS lookups`);
  if (categories.exceptions) parts.push(`:warning: ${categories.exceptions} exception${categories.exceptions > 1 ? "s" : ""}`);

  const summaryLine = parts.length > 0 ? parts.join(" · ") : `${recording.eventCount || 0} events`;

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:film_frames: *Substrate Recording* (${duration})\n${summaryLine}`,
      },
    },
  ];

  // Show key I/O events from context (truncated)
  if (recording.context) {
    const contextLines = recording.context.split("\n").slice(0, 8).join("\n");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```" + escapeSlack(contextLines) + "```",
      },
    });
  }

  // Link to full recording viewer
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View Full Recording" },
        url: `${appUrl}/recordings/${recording.recordingId}`,
        action_id: "view_recording",
      },
    ],
  });

  return blocks;
}

// ── Help ─────────────────────────────────────────────────────────────────────

export function buildHelpBlocks(): KnownBlock[] {
  return [{
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        "*InariWatch Commands*",
        "",
        "`/inariwatch status` — Overview: open alerts, on-call",
        "`/inariwatch alerts` — List recent unresolved alerts",
        "`/inariwatch fix <alert-id>` — Trigger AI remediation",
        "`/inariwatch oncall` — Show on-call rotation",
        "`/inariwatch oncall swap @user` — Swap on-call shift",
        "`/inariwatch link <email>` — Link your Slack to InariWatch",
        "`/inariwatch help` — This message",
        "",
        "_Or mention @InariWatch in any channel to ask a question._",
      ].join("\n"),
    },
  }];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
