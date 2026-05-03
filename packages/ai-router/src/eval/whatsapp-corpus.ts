// v0.3 S5 — eval corpus for `notify.compose.whatsapp`.
//
// 30 representative alert scenarios scored against:
//   - hard rubric (deterministic) — body length window, no markdown / URLs,
//     button count, must-contain / must-not-contain → 60 pts
//   - LLM-as-judge soft score (tone, urgency, role appropriateness) → 40 pts
//
// Total ≥ 85 means "promote to local" (already promoted in S5; this is for
// ongoing regression detection). 80-85 means "ship behind flag and watch";
// <80 means "tune prompt or pick a stronger model".

export interface ComposeWhatsappEvalInput {
  alert: {
    title: string;
    severity: "critical" | "high" | "warning" | "info";
    source: string;
    message?: string;
  };
  recipient_role: "developer" | "manager" | "stakeholder";
  language: "en" | "es";
}

export interface ComposeWhatsappEvalRubric {
  /** Substrings that MUST appear in body (case-insensitive). -5 each, max -30. */
  bodyMustContain?: string[];
  /** Substrings that MUST NOT appear in body. -10 each, max -30. */
  bodyMustNotContain?: string[];
  /** Hard upper bound — defaults to 1024 (Meta cap). */
  maxLengthChars?: number;
  /** Hard lower bound — defaults to 20 (one short sentence at minimum). */
  minLengthChars?: number;
  /** Expected button count range. Default [0, 3]. */
  expectedButtonsRange?: [number, number];
}

export interface ComposeWhatsappEvalItem {
  id: string;
  input: ComposeWhatsappEvalInput;
  rubric: ComposeWhatsappEvalRubric;
}

/** v0.3 S5 corpus — 30 representative WhatsApp alert scenarios. */
export const NOTIFY_COMPOSE_WHATSAPP_CORPUS: ComposeWhatsappEvalItem[] = [
  // ── Critical incidents (developer → developer) ─────────────────────────
  {
    id: "wa-fe-typeerror",
    input: {
      alert: {
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        severity: "critical",
        source: "sentry",
        message: "at handleSubmit (form.tsx:42:11)",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["TypeError"],
      bodyMustNotContain: ["**", "_", "```"],
      maxLengthChars: 600,
    },
  },
  {
    id: "wa-react-render-loop",
    input: {
      alert: {
        title: "Maximum update depth exceeded",
        severity: "high",
        source: "sentry",
        message: "Component repeatedly calls setState",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["update", "setState"],
      bodyMustNotContain: ["**", "_"],
    },
  },
  {
    id: "wa-prisma-pool",
    input: {
      alert: {
        title: "Timed out fetching a new connection from the connection pool",
        severity: "critical",
        source: "datadog",
        message: "PrismaClient @ /api/alerts (P2024)",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["pool"],
      bodyMustNotContain: ["**", "*"],
    },
  },
  {
    id: "wa-stripe-503",
    input: {
      alert: {
        title: "Stripe webhook handler returned 503",
        severity: "critical",
        source: "vercel",
        message: "Function timeout after 10s",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["stripe"],
      bodyMustNotContain: ["http://", "https://"],
    },
  },
  {
    id: "wa-memory-leak",
    input: {
      alert: {
        title: "Heap usage 92% — possible memory leak in alert poller",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["memory"],
    },
  },
  {
    id: "wa-vercel-build-fail",
    input: {
      alert: {
        title: "Vercel build failed: Module not found '@/lib/db'",
        severity: "critical",
        source: "vercel",
        message: "Build attempt 3 of 3 failed",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["build"],
      bodyMustNotContain: ["```"],
    },
  },
  {
    id: "wa-rollback",
    input: {
      alert: {
        title: "Deployment dpl_abc rolled back after 3 failed health checks",
        severity: "critical",
        source: "vercel",
      },
      recipient_role: "manager",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["rollback"],
      bodyMustNotContain: ["dpl_abc", "stack"],
      maxLengthChars: 400,
    },
  },
  {
    id: "wa-deadlock",
    input: {
      alert: {
        title: "Deadlock detected on tickets_status_user_idx",
        severity: "high",
        source: "postgres",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["deadlock"],
    },
  },
  {
    id: "wa-disk-full",
    input: {
      alert: {
        title: "Disk usage at 94% on db-prod-1",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["disk"],
    },
  },
  {
    id: "wa-brute-force",
    input: {
      alert: {
        title: "47 failed login attempts from 1.2.3.4 in 60 seconds",
        severity: "high",
        source: "sentry",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["1.2.3.4"],
    },
  },
  {
    id: "wa-jwt-expired",
    input: {
      alert: {
        title: "JWT signature verification failed across 312 requests",
        severity: "high",
        source: "sentry",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["jwt"],
    },
  },
  {
    id: "wa-p99-spike",
    input: {
      alert: {
        title: "p99 latency for /api/dispatch jumped to 4.2s (baseline 180ms)",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["latency"],
    },
  },
  {
    id: "wa-checkout-impact",
    input: {
      alert: {
        title: "Checkout error rate 8% (last 30 min)",
        severity: "critical",
        source: "datadog",
        message: "Estimated $12,400 in lost revenue",
      },
      recipient_role: "manager",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["checkout"],
      bodyMustNotContain: ["stack", "TypeError", "PrismaClient"],
      maxLengthChars: 400,
    },
  },
  {
    id: "wa-sla-breach",
    input: {
      alert: {
        title: "Uptime SLA breach: 99.6% over the last 7 days (target 99.9%)",
        severity: "warning",
        source: "uptime",
      },
      recipient_role: "manager",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["uptime"],
      bodyMustNotContain: ["stack"],
    },
  },
  {
    id: "wa-public-outage",
    input: {
      alert: {
        title: "API outage — investigating",
        severity: "critical",
        source: "uptime",
      },
      recipient_role: "stakeholder",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["outage"],
      bodyMustNotContain: ["stack", "TypeError", "PrismaClient", "503", "syscall"],
      maxLengthChars: 300,
    },
  },

  // ── Spanish-language scenarios ─────────────────────────────────────────
  {
    id: "wa-es-typeerror",
    input: {
      alert: {
        title: "TypeError: Cannot read properties of undefined (reading 'id')",
        severity: "critical",
        source: "sentry",
      },
      recipient_role: "developer",
      language: "es",
    },
    rubric: {
      bodyMustContain: ["TypeError"],
    },
  },
  {
    id: "wa-es-deploy-fail",
    input: {
      alert: {
        title: "Despliegue de Vercel falló: módulo no encontrado",
        severity: "critical",
        source: "vercel",
      },
      recipient_role: "developer",
      language: "es",
    },
    rubric: {
      bodyMustContain: ["Vercel"],
    },
  },
  {
    id: "wa-es-checkout",
    input: {
      alert: {
        title: "Tasa de error de checkout 8% (últimos 30 min)",
        severity: "critical",
        source: "datadog",
      },
      recipient_role: "manager",
      language: "es",
    },
    rubric: {
      bodyMustNotContain: ["stack"],
      maxLengthChars: 400,
    },
  },

  // ── Long-tail (12 misc scenarios) ──────────────────────────────────────
  {
    id: "wa-cron-skipped",
    input: {
      alert: {
        title: "Hourly digest cron skipped — last run >2h ago",
        severity: "warning",
        source: "vercel",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["cron"],
    },
  },
  {
    id: "wa-rate-limit",
    input: {
      alert: {
        title: "Hit OpenAI rate limit 47x in 60s",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["rate"],
    },
  },
  {
    id: "wa-3rdparty-down",
    input: {
      alert: {
        title: "Stripe API returning 503 for last 5 minutes",
        severity: "critical",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["stripe"],
    },
  },
  {
    id: "wa-cve",
    input: {
      alert: {
        title: "CVE-2026-12345 detected in dependency 'lodash@4.17.20'",
        severity: "high",
        source: "github",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["lodash"],
    },
  },
  {
    id: "wa-ci-failure",
    input: {
      alert: {
        title: "CI failed: 3 of 1247 tests broken on main",
        severity: "warning",
        source: "github",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["test"],
    },
  },
  {
    id: "wa-cert-expiring",
    input: {
      alert: {
        title: "TLS certificate for app.inariwatch.com expires in 9 days",
        severity: "warning",
        source: "uptime",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["certificate"],
    },
  },
  {
    id: "wa-sentry-quota",
    input: {
      alert: {
        title: "Sentry events: 87% of monthly quota used",
        severity: "info",
        source: "sentry",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["quota"],
      maxLengthChars: 300,
    },
  },
  {
    id: "wa-auto-heal",
    input: {
      alert: {
        title: "Auto-heal triggered: rolled back to dpl_xyz789",
        severity: "warning",
        source: "uptime",
      },
      recipient_role: "manager",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["rollback", "auto-heal"],
      bodyMustNotContain: ["stack"],
    },
  },
  {
    id: "wa-cors-block",
    input: {
      alert: {
        title: "CORS blocked 23 requests from app.example.com",
        severity: "warning",
        source: "sentry",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["cors"],
    },
  },
  {
    id: "wa-graphql-n1",
    input: {
      alert: {
        title: "GraphQL N+1 query detected: User.posts loaded 312 times",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["graphql"],
    },
  },
  {
    id: "wa-feature-flag",
    input: {
      alert: {
        title:
          "Feature flag 'new-onboarding' rollout halted at 25% — error rate spiked",
        severity: "warning",
        source: "datadog",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["flag"],
    },
  },
  {
    id: "wa-revenue-impact-stakeholder",
    input: {
      alert: {
        title: "Payment processing degraded: 12% transaction failure rate",
        severity: "critical",
        source: "datadog",
      },
      recipient_role: "stakeholder",
      language: "en",
    },
    rubric: {
      bodyMustNotContain: ["TypeError", "stack", "503", "syscall"],
      maxLengthChars: 300,
    },
  },
  {
    id: "wa-mention-incident",
    input: {
      alert: {
        title: "Incident escalated to on-call after 15-minute auto-remediation timeout",
        severity: "critical",
        source: "uptime",
      },
      recipient_role: "developer",
      language: "en",
    },
    rubric: {
      bodyMustContain: ["on-call"],
    },
  },
];
