/**
 * Re-validation of PR #19 fix — sends 3 synthetic alerts to demo-store
 * with unique title suffix so Redis fingerprint dedup doesn't reject them.
 * Expected outcome per alert: remediation reaches "proposing" with a
 * draft PR (not "failed" / max_retries).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import crypto from "crypto";

const BUGS = [
  {
    id: "null-deref",
    title: "TypeError: Cannot read property 'name' of undefined",
    body: `TypeError: Cannot read property 'name' of undefined
    at getUserName (__inari_bugs_fixtures__/bug-01-null-deref.js:3:28)
    at handler (src/api.js:14:10)
Called with user={id: 1}; profile was undefined.`,
  },
  {
    id: "foreach-undef",
    title: "TypeError: Cannot read properties of undefined (reading 'forEach')",
    body: `TypeError: Cannot read properties of undefined (reading 'forEach')
    at sumItems (__inari_bugs_fixtures__/bug-02-foreach-undefined.js:4:8)
Called with data=undefined when API returned empty body.`,
  },
  {
    id: "missing-await",
    title: "UnhandledPromiseRejection: database connection closed",
    body: `UnhandledPromiseRejection: database connection closed
    at saveUser (__inari_bugs_fixtures__/bug-03-missing-await.js:3:5)
Insert completed after response was sent. Possible data loss.`,
  },
];

async function main() {
  const validationId = `pr19-${Date.now().toString(36)}`;
  const { db, projects, projectIntegrations } = await import("../lib/db");
  const { eq, and } = await import("drizzle-orm");
  const { decryptConfig, decrypt } = await import("../lib/crypto");

  const [demoProj] = await db.select().from(projects).where(eq(projects.slug, "demo")).limit(1);
  if (!demoProj) { console.error("project 'demo' not found"); process.exit(1); }

  const integs = await db.select().from(projectIntegrations).where(
    and(eq(projectIntegrations.projectId, demoProj.id), eq(projectIntegrations.isActive, true))
  );
  const cap = integs.find((i) => i.service === "capture");
  if (!cap || !cap.webhookSecret) { console.error("no capture integration"); process.exit(1); }

  const secret = decrypt(cap.webhookSecret);
  const url = `https://app.inariwatch.com/api/webhooks/capture/${cap.id}`;

  console.log(`Validation run: ${validationId}`);
  console.log(`URL:            ${url}\n`);

  const results: { bugId: string; alertId?: string | null; status?: number; err?: string }[] = [];
  for (let i = 0; i < BUGS.length; i++) {
    const b = BUGS[i];
    const suffixedTitle = `${b.title} [${validationId}-${i}]`;
    const payload = {
      fingerprint: undefined, // let server compute from title+body
      title: suffixedTitle,
      body: b.body,
      severity: "critical",
      timestamp: new Date().toISOString(),
      environment: "production",
      git: { repo: "orbita-pos/inariwatch-demo-store" },
      metadata: { source: "pr19-revalidation", validationId, bugId: b.id },
    };
    const payloadStr = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-capture-signature": sig },
        body: payloadStr,
      });
      const txt = await res.text();
      let alertId: string | null = null;
      try { alertId = JSON.parse(txt)?.alertId ?? null; } catch {}
      results.push({ bugId: b.id, alertId, status: res.status });
      console.log(`  [${i + 1}/${BUGS.length}] ${b.id.padEnd(16)} → ${res.status}  alertId=${alertId?.slice(0, 8) ?? "NULL"}`);
    } catch (e) {
      results.push({ bugId: b.id, err: e instanceof Error ? e.message : String(e) });
      console.log(`  [${i + 1}/${BUGS.length}] ${b.id.padEnd(16)} → ERROR ${results[results.length - 1].err}`);
    }

    if (i < BUGS.length - 1) {
      console.log(`      ... waiting 45s (storm protection)`);
      await new Promise((r) => setTimeout(r, 45_000));
    }
  }

  const ok = results.filter((r) => r.alertId).length;
  console.log(`\nAlerts landed: ${ok}/${results.length}  validationId=${validationId}`);
  console.log(`\nPoll with: npx tsx scripts/_revalidate-no-ci-poll.ts ${validationId}`);
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
