// v0.3 S4 — eval corpus for `notify.compose.push`.
//
// 30 alert scenarios. Push-specific rubric extensions:
//   - title <= 50 chars (hard cap, parser clips beyond — but a model
//     producing 60+-char titles is making a tone error worth penalizing)
//   - body <= 200 chars
//   - actions: 0-3 with valid slug ids ([a-z0-9_-]+)
//   - category from the allowed enum (or null)

export interface ComposePushEvalInput {
  alert: {
    title: string;
    severity: "critical" | "high" | "warning" | "info";
    source: string;
    message?: string;
    url?: string;
  };
  /** Affects prompt tone. Defaults to "ios". */
  platform?: "ios" | "android" | "web";
  language: "en" | "es";
  suggest_actions?: boolean;
}

export interface ComposePushEvalRubric {
  /** At least one match in title (case-insensitive). */
  titleKeywords?: string[];
  /** Must appear in body. */
  bodyMustContain?: string[];
  /** Must NEVER appear in body — typically stack trace fragments. */
  bodyMustNotContain?: string[];
  /** Hard cap on title chars beyond which the rubric deducts (the
   * parser clips silently). Default 50. */
  maxTitleChars?: number;
  /** Hard cap on body chars. Default 200. */
  maxBodyChars?: number;
  /** Number-of-actions window. Defaults to [0, 3]. */
  expectedActionsRange?: [number, number];
  /** When set, rubric checks the chosen category matches one of these
   * values (or null). Used for severity-targeted alerts. */
  expectedCategoryAllowList?: string[];
}

export interface ComposePushEvalItem {
  id: string;
  input: ComposePushEvalInput;
  rubric: ComposePushEvalRubric;
}

export const NOTIFY_COMPOSE_PUSH_CORPUS: ComposePushEvalItem[] = [
  // ── Frontend ────────────────────────────────────────────────────────────
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
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["typeerror", "form"],
      bodyMustContain: ["form"],
      expectedCategoryAllowList: ["alert.critical"],
    },
  },
  {
    id: "fe-react-render-loop",
    input: {
      alert: {
        title: "Maximum update depth exceeded",
        severity: "high",
        source: "sentry",
        message: "Component repeatedly calls setState",
      },
      platform: "android",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["update", "depth"],
      bodyMustContain: ["setState"],
      expectedCategoryAllowList: ["alert.high"],
    },
  },
  {
    id: "fe-hydration-mismatch",
    input: {
      alert: {
        title: "Hydration failed",
        severity: "high",
        source: "sentry",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      titleKeywords: ["hydration"],
      bodyMustContain: ["hydration"],
      expectedActionsRange: [0, 0],
      expectedCategoryAllowList: ["alert.high"],
    },
  },

  // ── Backend ─────────────────────────────────────────────────────────────
  {
    id: "be-prisma-conn-pool",
    input: {
      alert: {
        title: "DB connection pool timeout",
        severity: "critical",
        source: "datadog",
        message: "Prisma P2024",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["pool", "db", "connection"],
      bodyMustContain: ["pool"],
      expectedCategoryAllowList: ["alert.critical"],
    },
  },
  {
    id: "be-503-payment",
    input: {
      alert: {
        title: "Stripe webhook 503",
        severity: "critical",
        source: "vercel",
        message: "10s timeout",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["stripe", "503"],
      bodyMustContain: ["stripe"],
      expectedCategoryAllowList: ["alert.critical"],
    },
  },
  {
    id: "be-memory-leak",
    input: {
      alert: {
        title: "Heap usage 92%",
        severity: "warning",
        source: "datadog",
      },
      platform: "android",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["memory", "heap"],
      bodyMustContain: ["memory"],
      expectedCategoryAllowList: ["alert.warning"],
    },
  },

  // ── Deploy ──────────────────────────────────────────────────────────────
  {
    id: "deploy-vercel-build-fail",
    input: {
      alert: {
        title: "Vercel build failed",
        severity: "critical",
        source: "vercel",
        message: "Module not found '@/lib/db'",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["build", "vercel"],
      bodyMustContain: ["build"],
      expectedCategoryAllowList: ["alert.critical", "deploy.failed"],
    },
  },
  {
    id: "deploy-rollback-required",
    input: {
      alert: {
        title: "Deploy rolled back",
        severity: "critical",
        source: "vercel",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      titleKeywords: ["rolled back", "rollback", "deploy"],
      bodyMustNotContain: ["stack trace"],
      expectedCategoryAllowList: ["alert.critical", "deploy.rolled_back"],
    },
  },

  // ── Database ────────────────────────────────────────────────────────────
  {
    id: "db-deadlock",
    input: {
      alert: {
        title: "Deadlock detected",
        severity: "high",
        source: "postgres",
      },
      platform: "android",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["deadlock"],
      bodyMustContain: ["deadlock"],
    },
  },
  {
    id: "db-disk-full",
    input: {
      alert: {
        title: "Disk usage 94%",
        severity: "warning",
        source: "datadog",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["disk", "94"],
      bodyMustContain: ["disk"],
    },
  },

  // ── Auth ────────────────────────────────────────────────────────────────
  {
    id: "auth-brute-force",
    input: {
      alert: {
        title: "47 failed login attempts",
        severity: "high",
        source: "sentry",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["login", "failed"],
      bodyMustContain: ["1.2.3.4"],
    },
  },
  {
    id: "auth-jwt-expired",
    input: {
      alert: {
        title: "JWT verification failed",
        severity: "high",
        source: "sentry",
      },
      platform: "android",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["jwt", "auth"],
      bodyMustContain: ["jwt"],
    },
  },

  // ── Performance ─────────────────────────────────────────────────────────
  {
    id: "perf-p99-spike",
    input: {
      alert: {
        title: "Latency spike",
        severity: "warning",
        source: "datadog",
        message: "p99 4.2s",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["latency", "spike"],
      bodyMustContain: ["latency"],
    },
  },

  // ── Manager-targeted ────────────────────────────────────────────────────
  {
    id: "mgr-revenue-impact",
    input: {
      alert: {
        title: "Checkout error rate 8%",
        severity: "critical",
        source: "datadog",
        message: "$12.4k lost revenue",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["checkout"],
      bodyMustContain: ["checkout"],
      bodyMustNotContain: ["stack", "PrismaClient", "TypeError"],
      expectedCategoryAllowList: ["alert.critical"],
    },
  },
  {
    id: "mgr-uptime-breach",
    input: {
      alert: {
        title: "SLA breach",
        severity: "warning",
        source: "uptime",
        message: "99.6% over 7 days",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      titleKeywords: ["sla", "uptime", "breach"],
      bodyMustContain: ["uptime"],
      bodyMustNotContain: ["stack"],
    },
  },

  // ── Stakeholder ─────────────────────────────────────────────────────────
  {
    id: "stk-public-status",
    input: {
      alert: {
        title: "API outage",
        severity: "critical",
        source: "uptime",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      titleKeywords: ["outage"],
      bodyMustNotContain: ["stack", "TypeError", "PrismaClient", "syscall"],
      maxBodyChars: 200,
    },
  },

  // ── Spanish ─────────────────────────────────────────────────────────────
  {
    id: "es-fe-typeerror",
    input: {
      alert: {
        title: "TypeError: undefined.id",
        severity: "critical",
        source: "sentry",
      },
      platform: "ios",
      language: "es",
      suggest_actions: true,
    },
    rubric: {
      bodyMustContain: ["TypeError"],
      expectedCategoryAllowList: ["alert.critical"],
    },
  },
  {
    id: "es-deploy-fail",
    input: {
      alert: {
        title: "Despliegue Vercel falló",
        severity: "critical",
        source: "vercel",
      },
      platform: "ios",
      language: "es",
      suggest_actions: true,
    },
    rubric: {
      bodyMustContain: ["Vercel"],
    },
  },
  {
    id: "es-mgr-revenue",
    input: {
      alert: {
        title: "Tasa de error checkout 8%",
        severity: "critical",
        source: "datadog",
      },
      platform: "ios",
      language: "es",
      suggest_actions: false,
    },
    rubric: {
      bodyMustNotContain: ["stack trace"],
      maxBodyChars: 200,
    },
  },

  // ── Long-tail (10) ──────────────────────────────────────────────────────
  {
    id: "misc-cron-skipped",
    input: {
      alert: {
        title: "Hourly cron skipped",
        severity: "warning",
        source: "vercel",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["cron"],
      bodyMustContain: ["cron"],
    },
  },
  {
    id: "misc-rate-limit",
    input: {
      alert: {
        title: "OpenAI rate limit",
        severity: "warning",
        source: "datadog",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["rate", "openai"],
      bodyMustContain: ["rate"],
    },
  },
  {
    id: "misc-3rdparty-down",
    input: {
      alert: {
        title: "Stripe API 503",
        severity: "critical",
        source: "datadog",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["stripe", "503"],
      bodyMustContain: ["stripe"],
    },
  },
  {
    id: "misc-cve-detected",
    input: {
      alert: {
        title: "CVE in lodash",
        severity: "high",
        source: "github",
      },
      platform: "android",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["cve", "lodash"],
      bodyMustContain: ["lodash"],
    },
  },
  {
    id: "misc-test-failure",
    input: {
      alert: {
        title: "CI failed: 3 tests broken",
        severity: "warning",
        source: "github",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["ci", "test"],
      bodyMustContain: ["test"],
    },
  },
  {
    id: "misc-cert-expiring",
    input: {
      alert: {
        title: "TLS cert expires 9 days",
        severity: "warning",
        source: "uptime",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      titleKeywords: ["tls", "cert", "expir"],
      bodyMustContain: ["certificate"],
    },
  },
  {
    id: "misc-quota-warn",
    input: {
      alert: {
        title: "Sentry quota 87%",
        severity: "info",
        source: "sentry",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      bodyMustContain: ["quota"],
      maxBodyChars: 200,
    },
  },
  {
    id: "misc-manual-rollback",
    input: {
      alert: {
        title: "Auto-heal rollback",
        severity: "warning",
        source: "uptime",
      },
      platform: "ios",
      language: "en",
      suggest_actions: false,
    },
    rubric: {
      titleKeywords: ["rollback", "auto-heal"],
      bodyMustNotContain: ["stack trace"],
    },
  },
  {
    id: "misc-cors-block",
    input: {
      alert: {
        title: "CORS blocked 23 reqs",
        severity: "warning",
        source: "sentry",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["cors"],
      bodyMustContain: ["cors"],
    },
  },
  {
    id: "misc-graphql-n1",
    input: {
      alert: {
        title: "GraphQL N+1 query",
        severity: "warning",
        source: "datadog",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["graphql", "query"],
      bodyMustContain: ["graphql"],
    },
  },
  {
    id: "misc-feature-flag-rollout",
    input: {
      alert: {
        title: "Flag rollout halted",
        severity: "warning",
        source: "datadog",
      },
      platform: "ios",
      language: "en",
      suggest_actions: true,
    },
    rubric: {
      titleKeywords: ["flag", "rollout"],
      bodyMustContain: ["flag"],
    },
  },
];
