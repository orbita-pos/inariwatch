/**
 * InariWatch — Demo seed script
 *
 * Creates realistic demo data for the demo@inariwatch.com account.
 * Connects directly to the DB using DATABASE_URL from .env.local
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";

const sql = neon(process.env.DATABASE_URL!);
const db  = drizzle(sql, { schema });

const DEMO_EMAIL = "demo@inariwatch.com";

const PROJECTS = [
  { name: "inariwatch-app",  description: "Main production Next.js app" },
  { name: "api-backend",     description: "REST API — Node.js + Postgres" },
  { name: "mobile-app",      description: "React Native iOS / Android" },
];

const ALERTS = [
  {
    severity: "critical" as const,
    title: "CI failed on main — build #312",
    body: "Error: Module not found: Can't resolve '@/lib/auth'\n\nStep 'npm run build' failed with exit code 1.\nTriggered by push to main.",
    sourceIntegrations: ["github"],
  },
  {
    severity: "critical" as const,
    title: "Production deploy failed — inariwatch.com",
    body: "Deployment dpl_8xK2mNvR failed.\n\nError: Build exceeded maximum duration (60s).\nCommit: fix: update drizzle schema\nBranch: main",
    sourceIntegrations: ["vercel"],
  },
  {
    severity: "critical" as const,
    title: "Unhandled exception spike — 47 new errors in 10m",
    body: "TypeError: Cannot read properties of undefined (reading 'session')\n\nFile: app/api/auth/route.ts:32\nOccurrences: 47 in the last 10 minutes\nAffected users: 12",
    sourceIntegrations: ["sentry"],
  },
  {
    severity: "warning" as const,
    title: "PR #84 unreviewed for 48 hours",
    body: "Pull request 'feat: add Stripe billing' has been open 48h with no reviews.\n\nAuthor: @jesusrafael\nFiles changed: 23\nBranch: feat/stripe → main",
    sourceIntegrations: ["github"],
  },
  {
    severity: "warning" as const,
    title: "PR #81 is stale — no activity for 6 days",
    body: "Pull request 'refactor: migrate to server actions' has had no activity for 6 days.\n\nLast updated: 6 days ago\nStatus: 2 review comments unresolved",
    sourceIntegrations: ["github"],
  },
  {
    severity: "warning" as const,
    title: "npm audit — 3 high severity vulnerabilities",
    body: "Found 3 high severity vulnerabilities in dependencies:\n\n• next-auth@4.24.5 — GHSA-xxxx (CSRF)\n• axios@1.6.0 — GHSA-yyyy (SSRF)\n• lodash@4.17.20 — GHSA-zzzz (Prototype Pollution)",
    sourceIntegrations: ["npm"],
  },
  {
    severity: "info" as const,
    title: "Preview deploy ready — feat/email-notifications",
    body: "Deployment dpl_3yP9qWvX is live.\n\nBranch: feat/email-notifications\nURL: https://inariwatch-git-feat-email-notifications.vercel.app",
    sourceIntegrations: ["vercel"],
  },
  {
    severity: "info" as const,
    title: "Database connection pool at 78% capacity",
    body: "Connection pool usage is elevated.\n\nCurrent: 39/50 connections\nPeak today: 44/50\nRecommendation: Consider increasing max_connections or adding a replica.",
    sourceIntegrations: ["postgres"],
  },
];

async function main() {
  console.log("🌱 Seeding demo data...\n");

  // ── Find demo user ──────────────────────────────────────────────────────────
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, DEMO_EMAIL))
    .limit(1);

  if (!user) {
    console.error(`❌ User ${DEMO_EMAIL} not found. Create the account first at /register.`);
    process.exit(1);
  }

  console.log(`✓ Found user: ${user.email} (${user.id})`);

  // ── Create projects ─────────────────────────────────────────────────────────
  const projectIds: string[] = [];

  for (const p of PROJECTS) {
    const slug = p.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    // Check if already exists
    const [existing] = await db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.userId, user.id), eq(schema.projects.slug, slug)))
      .limit(1);

    if (existing) {
      console.log(`  ↳ Project "${p.name}" already exists — skipping`);
      projectIds.push(existing.id);
      continue;
    }

    const [created] = await db
      .insert(schema.projects)
      .values({ userId: user.id, name: p.name, slug, description: p.description })
      .returning({ id: schema.projects.id });

    console.log(`  ✓ Created project: ${p.name}`);
    projectIds.push(created.id);
  }

  // ── Create alerts on first project ─────────────────────────────────────────
  const targetProjectId = projectIds[0];
  let created = 0;

  for (const a of ALERTS) {
    await db.insert(schema.alerts).values({
      projectId: targetProjectId,
      severity:  a.severity,
      title:     a.title,
      body:      a.body,
      sourceIntegrations: a.sourceIntegrations,
    });
    created++;
  }

  // Spread a couple alerts across other projects
  if (projectIds[1]) {
    await db.insert(schema.alerts).values({
      projectId: projectIds[1],
      severity: "critical",
      title: "API response time degraded — p99 > 3s",
      body: "Endpoint GET /api/users is responding slowly.\n\np50: 180ms\np95: 1.2s\np99: 3.4s\n\nPossible cause: missing index on users.created_at",
      sourceIntegrations: ["postgres"],
    });
    created++;
  }

  if (projectIds[2]) {
    await db.insert(schema.alerts).values({
      projectId: projectIds[2],
      severity: "warning",
      title: "App Store review rejected — missing privacy policy",
      body: "Your latest submission was rejected by App Store review.\n\nReason: Missing privacy policy URL in app metadata.\nAction required: Add privacy policy and resubmit.",
      sourceIntegrations: ["github"],
    });
    created++;
  }

  console.log(`\n  ✓ Created ${created} alerts`);

  console.log("\n✅ Demo seed complete!");
  console.log(`   Projects: ${projectIds.length}`);
  console.log(`   Alerts:   ${created}`);
  console.log("\nNow run the recorder:");
  console.log("  DEMO_URL=https://app.inariwatch.com DEMO_EMAIL=demo@inariwatch.com DEMO_PASSWORD=Demo1234! npx tsx scripts/record-demo.ts");
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
