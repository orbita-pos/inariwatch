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
  alert: { id: string; title: string; body: string; severity: string; sourceIntegrations?: string[] | null; createdAt?: Date | null; sessionId?: string | null },
  projectName: string,
  aiDiagnosis: string | null,
  appUrl?: string,
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

  // Action buttons. The "FullTrace" button is appended only when the
  // alert carries a session_id (Capture SDK v0.8+). Slack caps actions
  // at 5 elements per row — we're at 4 max so it fits inline.
  const actionElements: Array<{
    type: "button";
    text: { type: "plain_text"; text: string };
    style?: "danger" | "primary";
    action_id?: string;
    value?: string;
    url?: string;
  }> = [
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
  ];

  // FullTrace deep link — uses Slack's url-button (no callback handler
  // needed; it just opens in a new tab). Appended last so the existing
  // Fix/Ack/Resolve actions stay in their familiar order.
  const baseUrl = appUrl ?? process.env.APP_URL ?? "https://app.inariwatch.com";
  if (alert.sessionId) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "FullTrace ↗" },
      url: `${baseUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(alert.sessionId)}`,
    });
  }

  blocks.push({ type: "actions", elements: actionElements });

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
  deploySource?: string,
): KnownBlock[] {
  const label = deploySource && deploySource !== "vercel"
    ? ` (${escapeSlack(deploySource)})`
    : "";
  if (healthy) {
    return [{
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: Deploy${label} looks healthy. ${errorCount} errors in monitoring window.` },
    }];
  }
  return [{
    type: "section",
    text: { type: "mrkdwn", text: `:warning: Deploy${label} may be causing issues. ${errorCount} errors detected in monitoring window.` },
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
        "`/inariwatch trends [days]` — Error trends (default: 7 days)",
        "`/inariwatch ask <question>` — Ask Inari AI anything",
        "`/inariwatch uptime` — Check all uptime monitors",
        "`/inariwatch rollback <project>` — Rollback Vercel deploy",
        "`/inariwatch maintenance <project> <mins>` — Start maintenance window",
        "`/inariwatch search <error text>` — Search community fixes",
        "`/inariwatch integrations` — Integration health check",
        "`/inariwatch maintenance list` — Active maintenance windows",
        "`/inariwatch link <email>` — Link your Slack to InariWatch",
        "`/inariwatch help` — This message",
        "",
        "_Or mention @InariWatch in any channel to ask a question._",
      ].join("\n"),
    },
  }];
}

// ── Weekly digest ─────────────────────────────────────────────────────────────

export function buildWeeklyDigestBlocks(
  stats: { total: number; critical: number; resolved: number; unresolved: number },
  topAlerts: Array<{ title: string; severity: string; createdAt: Date }>,
  aiSummary?: string,
): KnownBlock[] {
  const appUrl = process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? "https://app.inariwatch.com";
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: ":bar_chart: Weekly InariWatch Digest", emoji: true },
  });

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Total*\n${stats.total}` },
      { type: "mrkdwn", text: `*Critical*\n:red_circle: ${stats.critical}` },
      { type: "mrkdwn", text: `*Resolved*\n:white_check_mark: ${stats.resolved}` },
      { type: "mrkdwn", text: `*Open*\n:large_yellow_circle: ${stats.unresolved}` },
    ],
  });

  if (aiSummary) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✦ *AI Summary*\n${escapeSlack(aiSummary.slice(0, 2000))}`,
      },
    });
  }

  if (topAlerts.length > 0) {
    blocks.push({ type: "divider" });
    const lines = topAlerts.slice(0, 5).map((a) => {
      const emoji = SEVERITY_EMOJI[a.severity] ?? ":white_circle:";
      const date = new Date(a.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `${emoji} ${escapeSlack(a.title.slice(0, 120))}  _${date}_`;
    }).join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Top alerts this week*\n${lines}` },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View Dashboard", emoji: true },
        url: `${appUrl}/dashboard`,
        style: "primary",
        action_id: "digest_view_dashboard",
      },
    ],
  });

  return blocks;
}

// ── Error trends ────────────────────────────────────────────────────────────

export function buildTrendsBlocks(
  days: number,
  current: number,
  previous: number,
  topErrors: { title: string; count: number; severity: string }[],
  daily: { date: string; severity: string; count: number }[],
): KnownBlock[] {
  const change = previous > 0
    ? `${current > previous ? "+" : ""}${Math.round(((current - previous) / previous) * 100)}%`
    : "N/A";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Error Trends — Last ${days} Days`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Total alerts*\n${current}` },
        { type: "mrkdwn", text: `*vs previous ${days}d*\n${change}` },
      ],
    },
  ];

  if (topErrors.length > 0) {
    const lines = topErrors.slice(0, 5).map((e) => {
      const emoji = SEVERITY_EMOJI[e.severity] || ":white_circle:";
      return `${emoji} ${escapeSlack(e.title)} — ${e.count}x`;
    }).join("\n");
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Top recurring errors*\n${lines}` },
    });
  }

  return blocks;
}

// ── Uptime status ───────────────────────────────────────────────────────────

export function buildUptimeBlocks(
  monitors: { projectName: string; url: string; isDown: boolean; statusCode?: number | null; responseTimeMs?: number | null }[],
): KnownBlock[] {
  const allUp = monitors.every((m) => !m.isDown);

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: allUp ? "✓ All Systems Operational" : "✗ Degraded — monitors down", emoji: true },
    },
  ];

  const lines = monitors.map((m) => {
    const status = m.isDown ? ":red_circle:" : ":large_green_circle:";
    const details = m.statusCode ? `HTTP ${m.statusCode} · ${m.responseTimeMs ?? "?"}ms` : "no data";
    return `${status} *${escapeSlack(m.projectName)}* — ${escapeSlack(m.url)}\n      ${details}`;
  }).join("\n");

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines || "No uptime monitors configured." },
  });

  return blocks;
}

// ── Rollback result ─────────────────────────────────────────────────────────

export function buildRollbackBlocks(
  projectName: string,
  result: { deploymentId?: string; url?: string; provider?: string },
): KnownBlock[] {
  const providerLabel = result.provider ? ` on ${result.provider}` : "";
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `✓ Rollback Complete${providerLabel}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Project*\n${escapeSlack(projectName)}` },
        ...(result.deploymentId
          ? [{ type: "mrkdwn" as const, text: `*Deployment*\n${result.deploymentId.slice(0, 12)}` }]
          : []),
      ],
    },
    ...(result.url ? [{
      type: "section" as const,
      text: { type: "mrkdwn" as const, text: `*URL:* ${result.url}` },
    }] : []),
  ];
}

// ── Maintenance window ──────────────────────────────────────────────────────

export function buildMaintenanceBlocks(
  projectName: string,
  durationMin: number,
  endsAt: Date,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: ":wrench: Maintenance Window Active", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Project*\n${escapeSlack(projectName)}` },
        { type: "mrkdwn", text: `*Duration*\n${durationMin} minutes` },
        { type: "mrkdwn", text: `*Ends at*\n${endsAt.toISOString().slice(0, 16)}` },
      ],
    },
  ];
}

// ── Community fix search ────────────────────────────────────────────────────

export function buildSearchFixBlocks(
  query: string,
  results: { patternText: string; category: string; fixes: { approach: string; successPct: number; total: number }[] }[],
): KnownBlock[] {
  if (results.length === 0) {
    return [{
      type: "section",
      text: { type: "mrkdwn", text: `No community fixes found for: _${escapeSlack(query)}_` },
    }];
  }

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Community Fixes Found", emoji: true },
    },
  ];

  for (const r of results.slice(0, 3)) {
    let fixLines = "";
    for (const f of r.fixes.slice(0, 2)) {
      fixLines += `\n   • ${escapeSlack(f.approach)} — ${f.successPct}% success (${f.total} teams)`;
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${escapeSlack(r.patternText)}*\n_${r.category}_${fixLines}` },
    });
  }

  return blocks;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
