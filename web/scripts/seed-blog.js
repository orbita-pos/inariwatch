require("dotenv").config({ path: ".env.local" });
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const posts = [
  {
    slug: "introducing-inariwatch-capture",
    title: "Introducing @inariwatch/capture — Your own error capture SDK",
    description: "We built our own error capture SDK. Zero dependencies, 9.8 KB, HMAC signing, deploy markers, and a direct pipeline to AI auto-fix.",
    tag: "Engineering",
    content: `We just published [@inariwatch/capture](https://www.npmjs.com/package/@inariwatch/capture) on npm.

## Why we built it

InariWatch monitors your stack and fixes production errors automatically. But we depended on Sentry to capture those errors. That meant our users needed a Sentry account and subscription — just to feed data into InariWatch.

So we built our own error capture SDK. 9.8 KB. Zero dependencies. The data flows directly from your app to InariWatch's AI pipeline.

## What it does

\`\`\`typescript
import { init, captureException, captureLog, flush } from "@inariwatch/capture";

init({
  dsn: "https://app.inariwatch.com/api/webhooks/capture/YOUR_PROJECT_ID",
  environment: "production",
  release: "1.2.0",
});

// Catch errors
app.use((err, req, res, next) => {
  captureException(err);
  res.status(500).json({ error: "Internal error" });
});

// Structured logs
captureLog("DB timeout", "error", { query: "SELECT...", duration: 5200 });

// Flush before exit (serverless)
await flush();
\`\`\`

## The numbers

- **9.8 KB** package size
- **0** dependencies
- **HMAC signing** for webhook verification
- **Retry buffer** for failed sends (up to 30 events)
- **Fingerprinting** for deduplication
- **Deploy markers** — set a release version and InariWatch tracks deploys automatically

## How it connects to InariWatch

When an error arrives via the capture SDK, InariWatch:
1. Auto-analyzes it with AI (free, no key needed)
2. Correlates it with other alerts from your stack
3. If you have an AI key: diagnoses the root cause, reads your code, generates a fix, opens a PR

The entire pipeline — from error to PR — uses data that flows through your own SDK. No third-party middleware.

## Local development

Point the DSN to localhost and the CLI capture server receives events locally:

\`\`\`typescript
init({ dsn: "http://localhost:9111/ingest" });
\`\`\`

Run \`inariwatch dev\` and errors from your dev server get diagnosed and fixed in real-time.

## Install

\`\`\`bash
npm install @inariwatch/capture
\`\`\`

[npm](https://www.npmjs.com/package/@inariwatch/capture) · [GitHub](https://github.com/orbita-pos/inariwatch) · [Docs](https://inariwatch.com/docs#int-capture)`,
  },
  {
    slug: "inariwatch-dev-mode",
    title: "inariwatch dev — AI fixes your errors while you code",
    description: "A new CLI mode that catches errors from your dev server, diagnoses them with AI, and applies fixes directly to your local files.",
    tag: "Engineering",
    content: `We shipped a new command: \`inariwatch dev\`.

## The problem

You're coding. Your dev server crashes. You read the stack trace, open the file, figure out the fix. 5-10 minutes for something that's often a null check or a missing import.

## The solution

\`\`\`bash
inariwatch dev
\`\`\`

InariWatch watches for errors from your local dev server via the capture SDK. When one arrives:

1. AI reads your local source files (no GitHub needed)
2. Diagnoses the root cause
3. Generates a fix
4. Self-reviews it (rejects bad fixes)
5. Shows you the diff
6. You press \`y\` — fix applied to disk

\`\`\`
🔴 TypeError: Cannot read 'user' of undefined
   auth/session.ts:84
   💡 Known pattern (confidence: 92%)
   → Diagnosing... 92% confidence
   → Fix: session.user?.id ?? null
   → Self-review: 88/100 (approve)

   Apply fix? yes
   ✓ Saved auth/session.ts
   ✓ Fix applied. Memory saved.
\`\`\`

## Dev trains prod

Every fix you apply locally gets saved to InariWatch's incident memory. When the same error appears in production, the system already knows the pattern — higher confidence, faster auto-fix.

Your development errors become training data for production reliability.

## No GitHub required

Dev mode runs 100% locally. It reads files from your disk, not from GitHub API. Your code never leaves your machine.

## Try it

\`\`\`bash
curl -fsSL https://get.inariwatch.com | sh
inariwatch init
inariwatch add capture
inariwatch dev
\`\`\`

[Docs](https://inariwatch.com/docs#cli-dev) · [GitHub](https://github.com/orbita-pos/inariwatch)`,
  },
  {
    slug: "github-action-risk-assessment",
    title: "AI risk assessment on every PR — now on GitHub Marketplace",
    description: "A GitHub Action that analyzes your PR diff with AI and posts a risk score comment. One YAML file to set up.",
    tag: "Launch",
    content: `InariWatch's risk assessment is now a standalone [GitHub Action](https://github.com/marketplace/actions/inariwatch-risk-assessment).

## What it does

On every pull request, InariWatch:

1. Reads the diff and file changes
2. Calls your AI provider for analysis
3. Posts a comment: 🟢 Low | 🟡 Medium | 🔴 High

When you push new commits, the comment updates — no spam.

## Setup

\`\`\`yaml
name: InariWatch Risk Assessment
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  risk:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: orbita-pos/inariwatch-action@v1
        with:
          ai-key: \${{ secrets.AI_KEY }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
\`\`\`

## What the comment looks like

> **Risk Level:** 🟢 Low
>
> **Summary:** Documentation-only changes with no impact on production code.
>
> **Findings:** No specific risks identified.
>
> **Recommendations:** No additional checks needed.

## BYOK

Supports Claude, OpenAI, Grok, DeepSeek, and Gemini. Cost: ~$0.001 per PR with GPT-4o-mini.

No data sent to InariWatch — everything stays between GitHub and your AI provider.

[GitHub Marketplace](https://github.com/marketplace/actions/inariwatch-risk-assessment) · [Source](https://github.com/orbita-pos/inariwatch-action)`,
  },
];

async function run() {
  for (const post of posts) {
    await pool.query(
      `INSERT INTO blog_posts (slug, title, description, content, tag, is_published, published_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (slug) DO NOTHING`,
      [post.slug, post.title, post.description, post.content, post.tag]
    );
    console.log("Published:", post.slug);
  }
  await pool.end();
  console.log("Done — 3 blog posts published");
}

run().catch((e) => { console.error(e.message); pool.end(); });
