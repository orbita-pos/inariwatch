// v0.3 S4 — eval corpus for `notify.compose.slack`.
//
// 30 alert scenarios mirroring the email corpus's coverage matrix:
// FE/BE/deploy/db/auth/perf/manager/stakeholder/Spanish/long-tail. The
// rubric extends `ComposeEmailEvalRubric` with Slack-specific checks
// (block count window, mrkdwn lint, channel-mention guard).

export interface ComposeSlackEvalInput {
  alert: {
    title: string;
    severity: "critical" | "high" | "warning" | "info";
    source: string;
    message?: string;
    url?: string;
  };
  recipient_role: "developer" | "manager" | "stakeholder";
  tone: "concise" | "detailed";
  language: "en" | "es";
  channel_hint?: string;
  /** When true, the rubric tolerates `<!here>`. Default false → any
   * `<!here>` / `<!channel>` is a hard fail (-30). */
  allow_here_mention?: boolean;
}

export interface ComposeSlackEvalRubric {
  /** At least one match in the section text (case-insensitive). */
  textKeywords?: string[];
  /** Must appear in section text (case-insensitive). */
  textMustContain?: string[];
  /** Must NEVER appear in section text. Channel mentions, etc. */
  textMustNotContain?: string[];
  /** Allowed block-count window. Defaults to [1, 4]. */
  expectedBlocksRange?: [number, number];
  /** Cap on the section text length. Default 1500. */
  maxTextChars?: number;
  /** Min section text length. Default 20. */
  minTextChars?: number;
  /** When true, the eval rejects `<!here>` / `<!channel>` outright. */
  forbidHereMention?: boolean;
}

export interface ComposeSlackEvalItem {
  id: string;
  input: ComposeSlackEvalInput;
  rubric: ComposeSlackEvalRubric;
}

/** v0.3 S4 corpus — 30 Slack alert scenarios. */
export const NOTIFY_COMPOSE_SLACK_CORPUS: ComposeSlackEvalItem[] = [
  // ── Frontend / TypeScript ────────────────────────────────────────────────
  {
    id: "fe-typeerror-undef",
    input: {
      alert: {
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        severity: "critical",
        source: "sentry",
        message: "at handleSubmit (form.tsx:42:11)",
        url: "https://app.inariwatch.com/alerts/abc",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
      channel_hint: "#alerts-prod",
    },
    rubric: {
      textKeywords: ["typeerror", "form.tsx"],
      textMustContain: ["form.tsx"],
      forbidHereMention: true,
    },
  },
  {
    id: "fe-react-render-loop",
    input: {
      alert: {
        title: "Maximum update depth exceeded",
        severity: "high",
        source: "sentry",
        message: "Component repeatedly calls setState inside componentDidUpdate",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
      channel_hint: "#alerts-fe",
    },
    rubric: {
      textKeywords: ["update", "depth", "render", "setstate"],
      textMustContain: ["setState"],
      forbidHereMention: true,
    },
  },
  {
    id: "fe-hydration-mismatch",
    input: {
      alert: {
        title: "Hydration failed because the initial UI does not match",
        severity: "high",
        source: "sentry",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["hydration"],
      textMustContain: ["hydration"],
      forbidHereMention: true,
    },
  },

  // ── Backend ──────────────────────────────────────────────────────────────
  {
    id: "be-prisma-conn-pool",
    input: {
      alert: {
        title: "Timed out fetching a new connection from the connection pool",
        severity: "critical",
        source: "datadog",
        message: "PrismaClient @ /api/alerts (P2024)",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
      channel_hint: "#alerts-prod",
    },
    rubric: {
      textKeywords: ["pool", "prisma", "connection"],
      textMustContain: ["pool"],
      forbidHereMention: true,
    },
  },
  {
    id: "be-503-payment",
    input: {
      alert: {
        title: "Stripe webhook handler returned 503",
        severity: "critical",
        source: "vercel",
        message: "Function timeout after 10s on /api/webhooks/stripe",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
      channel_hint: "#alerts-payments",
      allow_here_mention: true,
    },
    rubric: {
      textKeywords: ["stripe", "503", "timeout"],
      textMustContain: ["stripe"],
      // here_mention allowed — no forbidHereMention.
    },
  },
  {
    id: "be-memory-leak",
    input: {
      alert: {
        title: "Heap usage 92% — possible memory leak in alert poller",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["memory", "heap", "leak"],
      textMustContain: ["memory"],
      forbidHereMention: true,
    },
  },

  // ── Deploy ──────────────────────────────────────────────────────────────
  {
    id: "deploy-vercel-build-fail",
    input: {
      alert: {
        title: "Vercel build failed: Module not found '@/lib/db'",
        severity: "critical",
        source: "vercel",
        message: "Build attempt 3 of 3 failed",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["build", "vercel"],
      textMustContain: ["@/lib/db"],
      forbidHereMention: true,
    },
  },
  {
    id: "deploy-rollback-required",
    input: {
      alert: {
        title: "Deployment dpl_abc rolled back after 3 failed health checks",
        severity: "critical",
        source: "vercel",
      },
      recipient_role: "manager",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["rollback", "rolled back"],
      textMustNotContain: ["stack trace"],
      forbidHereMention: true,
    },
  },

  // ── Database ────────────────────────────────────────────────────────────
  {
    id: "db-deadlock",
    input: {
      alert: {
        title: "Deadlock detected on tickets_status_user_idx",
        severity: "high",
        source: "postgres",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["deadlock"],
      textMustContain: ["deadlock"],
      forbidHereMention: true,
    },
  },
  {
    id: "db-disk-full",
    input: {
      alert: {
        title: "Disk usage at 94% on db-prod-1",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["disk", "94"],
      textMustContain: ["disk"],
      forbidHereMention: true,
    },
  },

  // ── Auth ────────────────────────────────────────────────────────────────
  {
    id: "auth-brute-force",
    input: {
      alert: {
        title: "47 failed login attempts from 1.2.3.4 in 60 seconds",
        severity: "high",
        source: "sentry",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["login", "brute", "failed"],
      textMustContain: ["1.2.3.4"],
      forbidHereMention: true,
    },
  },
  {
    id: "auth-jwt-expired",
    input: {
      alert: {
        title: "JWT signature verification failed across 312 requests",
        severity: "high",
        source: "sentry",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["jwt", "signature"],
      textMustContain: ["jwt"],
      forbidHereMention: true,
    },
  },

  // ── Performance ─────────────────────────────────────────────────────────
  {
    id: "perf-p99-spike",
    input: {
      alert: {
        title: "p99 latency for /api/dispatch jumped to 4.2s (baseline 180ms)",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["latency", "p99", "/api/dispatch"],
      textMustContain: ["latency"],
      forbidHereMention: true,
    },
  },

  // ── Manager-targeted ────────────────────────────────────────────────────
  {
    id: "mgr-revenue-impact",
    input: {
      alert: {
        title: "Checkout error rate 8% (last 30 min)",
        severity: "critical",
        source: "datadog",
        message: "Estimated $12,400 in lost revenue",
      },
      recipient_role: "manager",
      tone: "concise",
      language: "en",
      channel_hint: "#leadership",
    },
    rubric: {
      textKeywords: ["checkout", "error"],
      textMustContain: ["checkout"],
      textMustNotContain: ["stack", "PrismaClient", "TypeError"],
      forbidHereMention: true,
    },
  },
  {
    id: "mgr-uptime-breach",
    input: {
      alert: {
        title: "Uptime SLA breach: 99.6% over the last 7 days (target 99.9%)",
        severity: "warning",
        source: "uptime",
      },
      recipient_role: "manager",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["sla", "uptime"],
      textMustContain: ["uptime"],
      textMustNotContain: ["stack"],
      forbidHereMention: true,
    },
  },

  // ── Stakeholder ─────────────────────────────────────────────────────────
  {
    id: "stk-public-status",
    input: {
      alert: {
        title: "API outage — investigating",
        severity: "critical",
        source: "uptime",
      },
      recipient_role: "stakeholder",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["outage", "investigating"],
      textMustNotContain: ["stack", "TypeError", "PrismaClient", "syscall"],
      maxTextChars: 600,
      forbidHereMention: true,
    },
  },

  // ── Spanish ─────────────────────────────────────────────────────────────
  {
    id: "es-fe-typeerror",
    input: {
      alert: {
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        severity: "critical",
        source: "sentry",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "es",
    },
    rubric: {
      textMustContain: ["TypeError"],
      forbidHereMention: true,
    },
  },
  {
    id: "es-deploy-fail",
    input: {
      alert: {
        title: "Despliegue de Vercel falló: módulo no encontrado",
        severity: "critical",
        source: "vercel",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "es",
    },
    rubric: {
      textMustContain: ["Vercel"],
      forbidHereMention: true,
    },
  },
  {
    id: "es-mgr-revenue",
    input: {
      alert: {
        title: "Tasa de error de checkout 8% (últimos 30 min)",
        severity: "critical",
        source: "datadog",
      },
      recipient_role: "manager",
      tone: "concise",
      language: "es",
    },
    rubric: {
      textMustNotContain: ["stack trace"],
      maxTextChars: 800,
      forbidHereMention: true,
    },
  },

  // ── Long-tail (10) ──────────────────────────────────────────────────────
  {
    id: "misc-cron-skipped",
    input: {
      alert: {
        title: "Hourly digest cron skipped — last run >2h ago",
        severity: "warning",
        source: "vercel",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["cron", "digest"],
      textMustContain: ["cron"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-rate-limit",
    input: {
      alert: {
        title: "Hit OpenAI rate limit 47x in 60s",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["rate", "openai"],
      textMustContain: ["rate"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-3rdparty-down",
    input: {
      alert: {
        title: "Stripe API returning 503 for last 5 minutes",
        severity: "critical",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
      channel_hint: "#alerts-payments",
      allow_here_mention: true,
    },
    rubric: {
      textKeywords: ["stripe", "503"],
      textMustContain: ["stripe"],
    },
  },
  {
    id: "misc-cve-detected",
    input: {
      alert: {
        title: "CVE-2026-12345 detected in dependency 'lodash@4.17.20'",
        severity: "high",
        source: "github",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["cve", "lodash"],
      textMustContain: ["lodash"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-test-failure",
    input: {
      alert: {
        title: "CI failed: 3 of 1247 tests broken on main",
        severity: "warning",
        source: "github",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["ci", "test"],
      textMustContain: ["test"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-cert-expiring",
    input: {
      alert: {
        title: "TLS certificate for app.inariwatch.com expires in 9 days",
        severity: "warning",
        source: "uptime",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["tls", "certificate", "expir"],
      textMustContain: ["certificate"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-quota-warn",
    input: {
      alert: {
        title: "Sentry events: 87% of monthly quota used",
        severity: "info",
        source: "sentry",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textMustContain: ["quota"],
      maxTextChars: 600,
      forbidHereMention: true,
    },
  },
  {
    id: "misc-manual-rollback",
    input: {
      alert: {
        title: "Auto-heal triggered: rolled back to dpl_xyz789",
        severity: "warning",
        source: "uptime",
      },
      recipient_role: "manager",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["rollback", "rolled back", "auto-heal"],
      textMustNotContain: ["stack trace"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-cors-block",
    input: {
      alert: {
        title: "CORS blocked 23 requests from app.example.com",
        severity: "warning",
        source: "sentry",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["cors", "blocked"],
      textMustContain: ["cors"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-graphql-n1",
    input: {
      alert: {
        title: "GraphQL N+1 query detected: User.posts loaded 312 times",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      textKeywords: ["graphql", "n+1", "query"],
      textMustContain: ["graphql"],
      forbidHereMention: true,
    },
  },
  {
    id: "misc-feature-flag-rollout",
    input: {
      alert: {
        title: "Feature flag 'new-onboarding' rollout halted at 25% — error rate spiked",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "concise",
      language: "en",
    },
    rubric: {
      textKeywords: ["flag", "rollout", "onboarding"],
      textMustContain: ["flag"],
      forbidHereMention: true,
    },
  },
];
