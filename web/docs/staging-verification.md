# Staging Verification

Before a fix reaches production, InariWatch deploys it to an ephemeral staging environment and runs a browser bot to verify it works.

## How It Works

1. **Deploy** — The fix branch is deployed to an isolated Docker container with its own URL (`fix-abc.staging.inariwatch.com`). Containers include optional Postgres and Redis sidecars if your app needs them.

2. **Browser replay** — A headless Chromium browser replays the original user session that caused the error:
   - HTTP requests from the Substrate I/O recording
   - UI interactions (clicks, inputs, navigation) from the rrweb session recording
   - Every action (HTTP and UI) gets a screenshot — not just failures

3. **Verification checks** — The bot evaluates:
   - No HTTP 500 errors
   - No console errors
   - Response body structure matches the original recording (deep diff)
   - Page is not blank and has no visible error text
   - AI visual analysis of the final screenshot (before/after comparison)

4. **Cleanup** — The container is destroyed after verification (5-minute TTL).

## Browser Bot Details

### Screenshots at Every Step

Every action the bot takes — each HTTP request and each UI interaction — produces a screenshot. This gives you a frame-by-frame view of what the bot did and what the page looked like at each point. The final screenshot (full-page) is the one sent to AI Vision.

### Selector Replay

When replaying UI interactions, the bot tries 4 strategies to find each element:

1. **Exact CSS selector** from the recording
2. **data-testid** — extracts `[data-testid="X"]` from the selector
3. **aria-label** — uses `getByLabel("X")`
4. **Role-based** — infers role from tag (`button` → `getByRole("button")`)

If all strategies fail for an element, the bot logs the failure and continues — it doesn't crash the pipeline. The results report:

- `actionsAttempted` — total UI actions attempted
- `actionsSucceeded` — how many found their element
- `actionsFailed` — which selectors failed and why
- `selectorReplayComplete` — `true` if all actions succeeded

### Deep Response Body Diffing

For each HTTP request replayed, the bot compares the staging response against the original recording — not just top-level keys, but recursively up to 4 levels deep.

What it detects:

| Condition | Severity | Example |
|-----------|----------|---------|
| Missing key | Error | Recording had `data.users`, staging doesn't |
| Type mismatch | Error | Recording: `data.users` was array, staging: `null` |
| Null where value existed | Warning | Recording: `meta.cursor = "abc"`, staging: `null` |
| Empty array where populated | Warning | Recording: `items[3]`, staging: `items[0]` |

Different primitive values (e.g., a name changed) are ignored — data changes between runs, only structure matters.

**Limits:** Max depth 4, max 50 keys per level, max 100KB response body. If a response exceeds these limits, it falls back to top-level key comparison.

### AI Visual Analysis (Before/After)

After all actions are replayed, the bot takes a full-page screenshot and sends it to your AI provider.

If a "before" screenshot exists (extracted from the rrweb recording of the error), both images are sent:

- **With before:** "Compare BEFORE (broken state) with AFTER (after fix). Did the fix improve the page? Are there new issues introduced?"
- **Without before:** "Does the page look correct? Any blank pages, error messages, or broken layouts?"

This eliminates false positives: if the page was already broken before the fix and looks the same after, the AI reports that the fix didn't help (not that the page is "broken").

**Vision-capable providers:** Claude, OpenAI, Grok, Gemini. **Text fallback:** Groq and DeepSeek get a DOM content analysis instead (checks text length, element count, error text patterns).

## Context in the PR

The PR body includes a **Context sources** line showing which integrations were available during verification:

```
Context sources: sentry: ✓, vercel: ✓, github: ✓, datadog: ✗ (down), staging: ✓
```

This tells the reviewer what information the bot had when it wrote and verified the fix.

## Fallback

If no staging server is configured (`STAGING_SERVER_URL` not set), this step is skipped entirely. The `e2e_staging` auto-merge gate is not evaluated.

## Configuration

| Variable | Description |
|----------|-------------|
| `STAGING_SERVER_URL` | URL of the staging orchestrator (e.g., `https://api.staging.inariwatch.com`) |
| `STAGING_API_SECRET` | Shared secret for staging server authentication |

Both must be set for staging verification to activate. HTTPS is enforced (except localhost for development).
