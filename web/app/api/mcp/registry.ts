export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type CostTier = "cheap" | "moderate" | "expensive";

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: "read" | "write" | "execute";
  annotations?: ToolAnnotations;
  costTier: CostTier;
};

/** Rate limit for all users — protection, not paywall */
export const GLOBAL_RATE_LIMIT = { windowMs: 3_600_000, max: 1000 }; // 1000/hour

export const COST_TIER_LIMITS: Record<CostTier, { windowMs: number; max: number }> = {
  cheap:    { windowMs: 60_000, max: 200 },
  moderate: { windowMs: 60_000, max: 30 },
  expensive: { windowMs: 60_000, max: 5 },
};

export const TOOLS: ToolDef[] = [
  // ── Query (read-only, cacheable) ───────────────────────────────────────────
  {
    name: "query_alerts",
    description:
      "Query recent alerts from your InariWatch projects. Returns alerts with severity, title, AI reasoning, sources, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project slug." },
        severity: {
          type: "string",
          enum: ["critical", "warning", "info"],
          description: "Filter by severity level.",
        },
        limit: {
          type: "number",
          description: "Max alerts to return (default: 20, max: 100).",
        },
      },
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "get_status",
    description:
      "List all your projects with their integrations, alert counts, and uptime status.",
    inputSchema: { type: "object", properties: {} },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "get_uptime",
    description:
      "Get current uptime status for all monitors. Returns last check result, response time, and consecutive failures.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter to a specific project slug." },
      },
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "get_build_logs",
    description:
      "Fetch recent Vercel deployment build logs. Returns build output with error summary. Useful for understanding why a deployment failed.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        deployment_id: {
          type: "string",
          description: "Specific deployment ID. Omit to get the latest.",
        },
      },
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    costTier: "cheap",
  },
  {
    name: "get_substrate_context",
    description:
      "Retrieve the Substrate I/O recording for an alert — HTTP requests, file reads, DB queries captured before the error occurred. Provides deep runtime context for diagnosis.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID." },
      },
      required: ["alert_id"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "cheap",
  },

  // ── Reasoning (sampling-first: client LLM does the analysis) ───────────────
  {
    name: "get_root_cause",
    description:
      "Root cause analysis of a specific alert. Returns cached AI analysis if available, otherwise provides alert context and a sampling request for client-side LLM diagnosis.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID to analyze." },
      },
      required: ["alert_id"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "moderate",
  },
  {
    name: "assess_risk",
    description:
      "Pre-deploy risk assessment for a pull request. Fetches the PR diff from GitHub and provides a sampling request for client-side LLM analysis. Returns risk level (Low/Medium/High) with findings.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        pr_number: { type: "number", description: "PR number to assess." },
      },
      required: ["project", "pr_number"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    costTier: "moderate",
  },
  {
    name: "get_postmortem",
    description:
      "Generate or retrieve a post-mortem for a resolved alert. Returns markdown with Summary, Timeline, Root Cause, Impact, Resolution, and Prevention.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID." },
      },
      required: ["alert_id"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "search_community_fixes",
    description:
      "Search the InariWatch community fix network for known solutions. Returns fixes with success rates and confidence scores contributed by teams who solved the same error.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Error message or description to search for.",
        },
        limit: {
          type: "number",
          description: "Max patterns to return (default: 5, max: 20).",
        },
      },
      required: ["query"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    costTier: "moderate",
  },

  // ── Execution (mutates state) ──────────────────────────────────────────────
  {
    name: "trigger_fix",
    description:
      "Start the AI remediation pipeline: diagnose → read code → generate fix → self-review → push → CI → PR. Use dry_run=true to preview without side effects.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID to fix." },
        project: { type: "string", description: "Project slug." },
        dry_run: {
          type: "boolean",
          description: "If true, preview the fix without pushing. Default: false.",
        },
        auto_merge: {
          type: "boolean",
          description: "Auto-merge when safety gates pass. Default: false.",
        },
      },
      required: ["alert_id"],
    },
    scope: "execute",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    costTier: "expensive",
  },
  {
    name: "rollback_deploy",
    description:
      "Roll back a project to its previous successful production deployment. Host-agnostic — works with Vercel, Netlify, Cloudflare Pages, and Render depending on which hosting integration the project has connected.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
      },
      required: ["project"],
    },
    scope: "execute",
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    costTier: "expensive",
  },
  {
    // Legacy alias — same execute path as rollback_deploy. Kept so MCP clients
    // already configured against older InariWatch versions keep working.
    name: "rollback_vercel",
    description:
      "[Legacy alias for rollback_deploy] Roll back a project to its previous successful production deployment. Host-agnostic despite the name.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
      },
      required: ["project"],
    },
    scope: "execute",
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    costTier: "expensive",
  },
  {
    name: "silence_alert",
    description:
      "Mark an alert as read and optionally resolved.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID." },
        resolve: {
          type: "boolean",
          description: "If true, also mark as resolved. Default: true.",
        },
      },
      required: ["alert_id"],
    },
    scope: "write",
    annotations: { idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "acknowledge_alert",
    description:
      "Mark an alert as read (acknowledged) without resolving it. Use when you've seen the alert but it still needs action.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID to acknowledge." },
      },
      required: ["alert_id"],
    },
    scope: "write",
    annotations: { idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "reopen_alert",
    description:
      "Reopen a previously resolved alert. Use when an issue recurs or was prematurely closed.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID to reopen." },
      },
      required: ["alert_id"],
    },
    scope: "write",
    annotations: { idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "submit_feedback",
    description:
      "Submit feedback on an AI fix — whether it worked or not. Closes the learning loop for future diagnosis accuracy.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The remediation session ID.",
        },
        worked: {
          type: "boolean",
          description: "Whether the fix resolved the issue.",
        },
      },
      required: ["session_id", "worked"],
    },
    scope: "write",
    annotations: { idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "run_check",
    description:
      "Trigger an immediate monitoring check cycle and return any new alerts found.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug. Omit to check all." },
      },
    },
    scope: "execute",
    annotations: { idempotentHint: false, openWorldHint: true },
    costTier: "moderate",
  },

  // ── New tools (post-audit) ─────────────────────────────────────────────────
  {
    name: "ask_inari",
    description:
      "Ask a natural language question about your infrastructure. Gathers full operational context (alerts, remediations, integrations, uptime) and provides a sampling request for client-side LLM to answer based on real data.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Natural language question (e.g. 'what broke yesterday?', 'how many critical alerts this week?').",
        },
      },
      required: ["question"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, openWorldHint: true },
    costTier: "moderate",
  },
  {
    name: "get_error_trends",
    description:
      "Error trend analysis: alerts per day by severity, top recurring errors, and comparison to previous period. Useful for spotting patterns before they escalate.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to analyze (default: 7, max: 30)." },
        project: { type: "string", description: "Filter to a specific project slug." },
      },
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "cheap",
  },
  {
    name: "create_uptime_monitor",
    description:
      "Create a new uptime monitor for a URL. InariWatch will check it on the configured interval and alert when it goes down.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public URL to monitor (e.g. https://api.example.com/health)." },
        project: { type: "string", description: "Project slug to attach the monitor to." },
        name: { type: "string", description: "Display name for the monitor." },
        interval_sec: { type: "number", description: "Check interval in seconds (default: 60, min: 30, max: 3600)." },
        expected_status: { type: "number", description: "Expected HTTP status code (default: 200)." },
      },
      required: ["url", "project"],
    },
    scope: "execute",
    annotations: { idempotentHint: false },
    costTier: "cheap",
  },
  {
    name: "run_health_check",
    description:
      "Run a complete health check of the InariWatch installation. Checks capture SDK, integrations, notifications, AI key, cron polling, database, substrate, and MCP tools. Returns a structured report with pass/warn/fail for each check.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    costTier: "moderate",
  },

  // ── Substrate + Verification tools ─────────────────────────────────────────
  {
    name: "reproduce_bug",
    description:
      "Reproduce a production bug using Substrate I/O recording. Shows the exact timeline of HTTP calls, DB queries, and file operations that happened before the crash — in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID to reproduce." },
        verbose: { type: "boolean", description: "If true, show full request/response bodies. Default: false." },
      },
      required: ["alert_id"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "moderate",
  },
  {
    name: "simulate_fix",
    description:
      "Simulate whether a proposed fix would resolve a bug, based on the Substrate I/O recording. Returns recording data and a sampling request for client-side LLM to analyze probability of success, risks, and side effects.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID with a Substrate recording." },
        fix_description: { type: "string", description: "Description of the proposed fix (what changes, why)." },
      },
      required: ["alert_id", "fix_description"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, openWorldHint: true },
    costTier: "expensive",
  },
  {
    name: "verify_remediation",
    description:
      "Verify the full remediation chain for an alert: fix generated, self-reviewed, CI passed, PR created, merged, post-merge monitoring, error stopped recurring. Returns a structured verification report.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "The alert ID to verify remediation for." },
      },
      required: ["alert_id"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "moderate",
  },

  // ── Code Intelligence ───────────────────────────────────────────────────────
  {
    name: "search_codebase",
    description:
      "Search the user's indexed codebase using hybrid vector + keyword search. Returns relevant code chunks with descriptions, dependency graph, and file locations. The codebase must be indexed first (happens automatically when GitHub is connected).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for — error message, function name, concept, or pattern.",
        },
        project: { type: "string", description: "Project slug (optional, searches all if omitted)." },
        limit: {
          type: "number",
          description: "Max results to return (default: 5, max: 10).",
        },
      },
      required: ["query"],
    },
    scope: "read",
    annotations: { readOnlyHint: true, idempotentHint: true },
    costTier: "moderate",
  },
  {
    name: "reindex_codebase",
    description:
      "Trigger a re-indexation of the project's codebase. Uses incremental indexing (only changed files). Rate limited to once per 5 minutes per repo.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
      },
      required: ["project"],
    },
    scope: "execute",
    annotations: { idempotentHint: false },
    costTier: "moderate",
  },
];
