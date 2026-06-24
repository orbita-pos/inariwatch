// v0.3 S3 — eval corpus for `notify.compose.email`.
// v0.3 S4 — extended with sibling corpora for slack / telegram / push.
//
// Every per-task corpus has 30 representative alert scenarios + per-item
// rubric. The runner scores each output against:
//   - hard rubric checks (subject/title/text keywords, body/text must
//     contain / must-not contain, length window, format-specific
//     validators) → 60% of total
//   - LLM-as-judge soft score (tone, factual accuracy, action
//     specificity) → 40% of total
//
// Final score is the weighted average. ≥ 85 means "ship it"; <85 means
// "tune prompt or pick a stronger model".
//
// Channel-specific rubric extensions:
//   - slack: blocks count + mrkdwn lint (no fences, balanced markers)
//   - telegram: parse_mode pinned + reserved chars escaped
//   - push: title length cap, body length cap, action validators

export interface ComposeEmailEvalInput {
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
}

export interface ComposeEmailEvalRubric {
  /**
   * Optional list — if present at least ONE keyword (case-insensitive) must
   * appear in the subject. Use proper-noun fragments and severity words.
   * Skip when the alert title is generic enough that any reasonable subject
   * would do.
   */
  subjectKeywords?: string[];
  /**
   * Substrings that MUST appear in body (case-insensitive). The judge
   * counts each missing one as a 5-point deduction (max 30).
   */
  bodyMustContain?: string[];
  /**
   * Substrings that must NEVER appear in body (case-insensitive). Each
   * occurrence is a 10-point deduction (max 30).
   */
  bodyMustNotContain?: string[];
  /** Hard upper bound on body length in chars. Default 1500. */
  maxLengthChars?: number;
  /** Hard lower bound on body length. Default 30. */
  minLengthChars?: number;
  /**
   * Number of suggested actions expected. Default range 1-4. Scored as a
   * pass/fail — out-of-range deducts 10 points.
   */
  expectedActionsRange?: [number, number];
}

export interface ComposeEmailEvalItem {
  id: string;
  input: ComposeEmailEvalInput;
  rubric: ComposeEmailEvalRubric;
}

/** v0.3 S3 corpus — 30 representative alert scenarios. */
export const NOTIFY_COMPOSE_EMAIL_CORPUS: ComposeEmailEvalItem[] = [
  // ── Frontend / TypeScript errors ─────────────────────────────────────────
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
    },
    rubric: {
      subjectKeywords: ["typeerror", "undefined", "form"],
      bodyMustContain: ["form.tsx", "TypeError"],
      bodyMustNotContain: [],
      maxLengthChars: 800,
      minLengthChars: 30,
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
        url: "https://app.inariwatch.com/alerts/render-loop",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      subjectKeywords: ["update", "depth", "render"],
      bodyMustContain: ["setState"],
      maxLengthChars: 1500,
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
      subjectKeywords: ["hydration"],
      bodyMustContain: ["hydration"],
    },
  },

  // ── Backend Node / TypeScript errors ─────────────────────────────────────
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
    },
    rubric: {
      subjectKeywords: ["pool", "connection", "prisma"],
      bodyMustContain: ["pool"],
      bodyMustNotContain: ["mysql"],
      maxLengthChars: 1500,
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
    },
    rubric: {
      subjectKeywords: ["stripe", "503", "timeout"],
      bodyMustContain: ["stripe"],
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
      subjectKeywords: ["memory", "heap", "leak"],
      bodyMustContain: ["memory"],
    },
  },

  // ── Deploy / CI failures ─────────────────────────────────────────────────
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
      subjectKeywords: ["build", "vercel"],
      bodyMustContain: ["@/lib/db", "build"],
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
      subjectKeywords: ["rollback", "deploy", "rolled back"],
      bodyMustNotContain: ["stack trace"],
    },
  },

  // ── Database errors ──────────────────────────────────────────────────────
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
      subjectKeywords: ["deadlock"],
      bodyMustContain: ["deadlock"],
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
      subjectKeywords: ["disk", "94"],
      bodyMustContain: ["disk"],
    },
  },

  // ── Auth / security ──────────────────────────────────────────────────────
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
      subjectKeywords: ["login", "brute", "failed"],
      bodyMustContain: ["1.2.3.4"],
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
      subjectKeywords: ["jwt", "signature", "auth"],
      bodyMustContain: ["jwt"],
    },
  },

  // ── Performance ──────────────────────────────────────────────────────────
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
      subjectKeywords: ["latency", "p99", "/api/dispatch"],
      bodyMustContain: ["latency"],
    },
  },

  // ── Manager-targeted alerts ──────────────────────────────────────────────
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
    },
    rubric: {
      subjectKeywords: ["checkout", "error"],
      bodyMustContain: ["checkout"],
      bodyMustNotContain: ["stack", "PrismaClient", "TypeError"],
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
      subjectKeywords: ["sla", "uptime"],
      bodyMustContain: ["uptime"],
      bodyMustNotContain: ["stack"],
    },
  },

  // ── Stakeholder-targeted ─────────────────────────────────────────────────
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
      subjectKeywords: ["outage", "investigating"],
      bodyMustNotContain: ["stack", "TypeError", "PrismaClient", "503", "syscall"],
      maxLengthChars: 600,
    },
  },

  // ── Spanish-language scenarios ───────────────────────────────────────────
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
      bodyMustContain: ["TypeError"],
      // Looser keywords for Spanish — model phrasing varies.
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
      bodyMustContain: ["Vercel"],
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
      bodyMustNotContain: ["stack trace"],
      maxLengthChars: 800,
    },
  },

  // ── Long-tail (10 misc scenarios) ────────────────────────────────────────
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
      subjectKeywords: ["cron", "digest"],
      bodyMustContain: ["cron"],
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
      subjectKeywords: ["rate", "openai"],
      bodyMustContain: ["rate"],
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
    },
    rubric: {
      subjectKeywords: ["stripe", "503"],
      bodyMustContain: ["stripe"],
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
      subjectKeywords: ["cve", "lodash"],
      bodyMustContain: ["lodash"],
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
      subjectKeywords: ["ci", "test", "failed"],
      bodyMustContain: ["test"],
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
      subjectKeywords: ["tls", "certificate", "expir"],
      bodyMustContain: ["certificate"],
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
      bodyMustContain: ["quota"],
      maxLengthChars: 600,
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
      subjectKeywords: ["rollback", "auto-heal", "rolled"],
      bodyMustNotContain: ["stack trace"],
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
      subjectKeywords: ["cors", "blocked"],
      bodyMustContain: ["cors"],
    },
  },
  {
    id: "misc-graphql-n1",
    input: {
      alert: {
        title: "GraphQL N+1 query detected: User.posts loaded 312 times in single request",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      tone: "detailed",
      language: "en",
    },
    rubric: {
      subjectKeywords: ["graphql", "n+1", "query"],
      bodyMustContain: ["graphql"],
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
      subjectKeywords: ["flag", "rollout", "onboarding"],
      bodyMustContain: ["flag"],
    },
  },
];
