// ── MCP Prompts — predefined templates that appear as commands in AI tools ──

export const PROMPTS = [
  {
    name: "diagnose",
    description: "Diagnose the most critical open alert: get root cause, substrate context, and community fixes.",
    arguments: [
      {
        name: "project",
        description: "Project slug to focus on (optional — defaults to all projects).",
        required: false,
      },
    ],
  },
  {
    name: "status-report",
    description: "Generate a full status report: uptime, open alerts, active remediations, and trends.",
    arguments: [],
  },
  {
    name: "fix-this",
    description: "Find the most critical unresolved alert and trigger a dry-run AI remediation to preview the fix.",
    arguments: [
      {
        name: "project",
        description: "Project slug (optional).",
        required: false,
      },
    ],
  },
  {
    name: "post-deploy-check",
    description: "After deploying, check uptime, look for new errors in the last 10 minutes, and assess if the deploy is healthy.",
    arguments: [
      {
        name: "project",
        description: "Project slug (required).",
        required: true,
      },
    ],
  },
  {
    name: "weekly-summary",
    description: "Summarize the past 7 days: alert trends, MTTR, top error patterns, active remediations.",
    arguments: [],
  },
];

/**
 * Expand a prompt into messages that the AI tool will process.
 * The AI tool calls these prompts, and we return the "user" messages
 * that instruct the AI what to do with InariWatch tools.
 */
export function expandPrompt(
  name: string,
  args: Record<string, string>
): { messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } | null {
  const project = args.project ? ` for project "${args.project}"` : "";

  switch (name) {
    case "diagnose":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Use the InariWatch MCP tools to diagnose the most critical open alert${project}. Steps:
1. Call query_alerts with severity "critical" to find the top alert.
2. Call get_root_cause on that alert for AI-powered analysis.
3. Call get_substrate_context for I/O recording context.
4. Call search_community_fixes with the error message.
5. Summarize: what's wrong, what caused it, and the recommended fix (including community success rates if available).`,
            },
          },
        ],
      };

    case "status-report":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Generate a status report using InariWatch MCP tools:
1. Call get_status to list all projects and their integrations.
2. Call get_uptime to check current uptime for all monitors.
3. Call query_alerts with limit 10 to see recent alerts.
4. Format a concise status report: what's up, what's down, open alert count by severity, any active issues.`,
            },
          },
        ],
      };

    case "fix-this":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Find and fix the most critical unresolved alert${project} using InariWatch MCP tools:
1. Call query_alerts with severity "critical" to find the top alert.
2. Call search_community_fixes to check if a known fix exists.
3. Call trigger_fix with dry_run=true to preview the AI-generated fix.
4. Show me the preview: what files would change, what the fix does, and confidence score. Ask me before proceeding with the actual fix.`,
            },
          },
        ],
      };

    case "post-deploy-check":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Run a post-deploy health check${project} using InariWatch MCP tools:
1. Call get_uptime to verify the site is responding.
2. Call query_alerts with limit 5 to check for new errors in the last few minutes.
3. Call get_build_logs to verify the latest deployment succeeded.
4. Report: is the deploy healthy? Any new errors? Uptime status?`,
            },
          },
        ],
      };

    case "weekly-summary":
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Generate a weekly summary using InariWatch MCP tools:
1. Call query_alerts with limit 100 to get this week's alerts.
2. Call get_status for project overview.
3. Call get_uptime for current health.
4. Summarize: total alerts by severity, most frequent errors, any patterns, current system health. Keep it concise — 5-10 bullet points.`,
            },
          },
        ],
      };

    default:
      return null;
  }
}
