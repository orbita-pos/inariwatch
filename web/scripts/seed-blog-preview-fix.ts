import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Seed the Preview Fix announcement post as an UNPUBLISHED draft.
 * Review and publish via /admin/blog.
 *
 * Idempotent: upserts on slug.
 *
 * Usage: cd web && npx tsx scripts/seed-blog-preview-fix.ts
 */

const SLUG = "introducing-preview-fix";
const TITLE = "Introducing Preview Fix";
const DESCRIPTION =
  "Every autonomous remediation now ships with a live visual preview and a cryptographic receipt.";
const TAG = "Launch";

const CONTENT = `InariWatch has been shipping autonomous fixes for nearly a year. When your production breaks, we diagnose the error, read your code, write the remediation, pass it through 17 safety gates, and — in trusted mode — merge the pull request. What you've been trusting, until today, was the output of an invisible process.

Preview Fix makes it visible.

## What it does

When a remediation completes, the alert detail page renders a new panel with three things:

**An AI-predicted preview (2–3 seconds).** GPT-5.4 reads the last DOM snapshot from the production recording, applies the fix diff, and returns what the UI would look like after. You get something to look at instantly, before any sandbox finishes building.

**A live sandbox (30–60 seconds).** We spin up the fix branch in an ephemeral Docker container on a dedicated Hetzner host, behind a dynamic \`preview-<id>.staging.inariwatch.com\` subdomain with a 24-hour TTL. It's the real fixed app, reachable from anywhere, with preview-only credentials injected.

**A shareable URL with cryptographic proof.** Every preview gets a 12-character capability slug — \`app.inariwatch.com/preview/M37DF4M2WGTS\`. Paste it into Slack, post it on Twitter, send it to a teammate out on PTO. Social unfurls render a real screenshot as the OG image. The landing page links to the EAP receipt that proves the 17 gates passed.

## Why this matters

Automated remediation without visibility is a trust problem. When a bot writes a fix, runs some tests, and merges, we're asking you to trust three things: that the diagnosis was right, that the gates were strict enough, and that the fix actually worked. The first two we've earned through a year of evidence. The third, until today, we hand-waved: "the tests passed, that's what matters."

Preview Fix closes the loop. You don't just trust that the fix works — you see it work. You share the URL with a colleague who was offline. You post it publicly and get review before a single real user touches the changed code.

## A year-long build

Preview Fix is the last atom of a three-quarter effort.

**Q1 2026 — FullTrace.** We unified signal from six sources — Sentry, Vercel, GitHub, Datadog, Expo, and our own \`@inariwatch/capture\` SDK — into one alert model. Along the way we shipped Substrate, a deterministic I/O recording engine that can rerun production traffic against any candidate fix branch.

**Q2 2026 — 17 safety gates.** We built the guardrail layer. Substrate simulate scores the diff for risk. EAP chain verification confirms the previous fix's receipt. Prediction safety runs on the PR diff before merge. The security scanner runs three layers in parallel: \`eslint-plugin-security\`, 19 regex patterns, and an AI review. Staging E2E verification runs generated Playwright flows on the fix branch in a real browser. Seven more gates cover CI, size limits, self-review, substrate replay, and post-merge monitoring. The pipeline will not merge a fix unless all 17 pass.

**Q3 2026 — EAP chain live.** We deployed the Execution Attestation Protocol server at \`eap.staging.inariwatch.com\`. It's six Rust crates — Merkle trees plus Ed25519 signatures — that sign a receipt for every fix, chaining each one to the previous. Tamper-evident forever. Anyone can verify the chain with the public key.

**Today — Preview Fix.** The visible half.

## Two design choices worth calling out

### Trust the owner's environment

Our first draft of the live sandbox aggressively scrubbed every environment variable that matched \`SECRET|TOKEN|DATABASE_URL\` before injecting into the preview container. We rebuilt it the day we tried to preview any real e-commerce app: the homepage server-side-rendered against a database, the database URL had been replaced with a sentinel, and nothing rendered.

We ripped out the scrub and moved to Vercel's Preview Environment Variables model. The project owner curates \`staging_env\` explicitly — with preview-specific credentials, a throwaway Neon branch, test Stripe keys, whatever the app needs. We pass it through verbatim. The product's job is not to second-guess what the owner put in their own preview env; the product's job is to run the fixed code with those inputs and show the outcome.

### URL-first, iframe-optional

Our first draft embedded the live preview in an \`<iframe>\` inside the alert panel. Beautiful in Chrome. Silently blocked in Edge, Brave, Safari, and Firefox with Enhanced Tracking Protection — cross-origin iframes are a default target for every modern privacy-mode blocker.

We pivoted to screenshot-first. The panel now shows a real hero image (Playwright captures it the moment the sandbox is healthy) with a prominent "Open live preview" CTA that always works. The iframe stays as an opt-in "Try embedded view." Screenshots are served from Cloudflare R2 with a year-long immutable cache header, so social unfurls hit a CDN, not our origin.

## How it's built

The pipeline, end to end:

- **Web** (Next.js on Vercel) owns the alert UI and the \`/preview/<slug>\` landing. When a completed remediation is visited, the panel POSTs to \`/api/alerts/:id/preview\`. The handler is idempotent; repeat hits return the same session.
- **Go staging server** (on Hetzner, behind Caddy) accepts a deploy spec with \`repo\`, \`branch\`, \`ttl_seconds\`, and \`env_vars\`. It clones the branch, auto-generates a Dockerfile for the detected framework (Next.js, Express, generic), runs \`docker build\` + \`docker run\`, and registers a dynamic Caddy route via the admin API.
- **Node worker** (also on Hetzner) owns Playwright. The web app posts the running preview URL to \`/worker/screenshot\`; the worker launches a warm Chromium context and returns the PNG bytes. A retry loop handles the few seconds between "sandbox running" and "ACME cert issued."
- **R2** stores the screenshot at \`preview-screenshots/<id>.png\`. The web app serves it back through \`/api/preview/:id/screenshot.png\` with immutable edge caching.
- **EAP server** signs the receipt at the end of the remediation pipeline. The preview's landing page links to \`/attestation/<receipt>\` for chain verification.

About 2,100 lines across migrations, services, API routes, the Go handlers, and the worker endpoint.

## Shipping today

- Preview Fix, Tier 1 (live sandbox) + Tier 3 (AI prediction)
- Public share URL with screenshot-backed OG unfurl
- Revoke flow — the project owner or any org member can pull the public URL
- Integration health banner — passive 401 detection catches expired GitHub PATs before they cause an opaque remediation failure
- Cryptographic chain (EAP) linked from every preview

Gated behind \`PREVIEW_FIX_ORGS\` and \`PREVIEW_FIX_USERS\` allowlists while we onboard early users. If you want access, reply to this post or email \`hello@inariwatch.com\`.

## What's next

- Tier 1 will support optional Postgres and Redis sidecars (the Go server already does; we'll surface the toggle on the project settings page).
- An admin dashboard with per-org preview cost, volume, and Tier 3 vs Tier 1 usage.
- An embeddable widget — drop the preview card on your own changelog.
- Multi-page persona replay for fixes that span a flow (checkout step 1 → step 2).

From today forward, every fix you see is one you can watch happen.
`;

async function main() {
  const { db, blogPosts } = await import("../lib/db");
  const { eq, sql } = await import("drizzle-orm");

  const [existing] = await db
    .select({ id: blogPosts.id, isPublished: blogPosts.isPublished })
    .from(blogPosts)
    .where(eq(blogPosts.slug, SLUG))
    .limit(1);

  if (existing) {
    await db
      .update(blogPosts)
      .set({
        title: TITLE,
        description: DESCRIPTION,
        content: CONTENT,
        tag: TAG,
        updatedAt: new Date(),
      })
      .where(eq(blogPosts.id, existing.id));
    console.log(
      `Updated existing post ${SLUG} (${existing.isPublished ? "published" : "draft"}). Review at /admin/blog.`,
    );
  } else {
    await db.insert(blogPosts).values({
      slug: SLUG,
      title: TITLE,
      description: DESCRIPTION,
      content: CONTENT,
      tag: TAG,
      isPublished: false,
    });
    console.log(`Created draft post "${SLUG}". Publish via /admin/blog.`);
  }

  // Silence unused import warning if drizzle imports get tree-shaken weird.
  void sql;
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
