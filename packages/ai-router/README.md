# @inariwatch/ai-router

Internal workspace package — **NOT published**. Single point of entry for every AI call across InariWatch surfaces (web, desktop / Inari Live, CLI, capture SDKs, MCP).

SSOT: `INARI_AI_ARCHITECTURE.md` at the repo root (LOCKED 2026-05-02).

## Usage

```ts
import { dispatch } from "@inariwatch/ai-router";

const text = await dispatch({
  task: "alert.auto-analyze",
  mode: "complete",
  apiKey,
  systemPrompt,
  messages,
  workspace: { userId, projectId },
});
```

## Structure

- `src/tasks.ts` — task taxonomy (~30 tasks across 7 namespaces).
- `src/rules.ts` — routing rules per task. Phase 1: every task → cloud (zero behavior change).
- `src/dispatch.ts` — public `dispatch()` API.
- `src/providers/` — the **only** files allowed to talk to provider URLs.
- `src/receipts.ts` — EAP receipt emission per dispatch.
- `src/lockdown/eslint-rule.js` — `inariwatch/no-direct-ai-sdk-import` (CI gate).

## Phase

Phase 1 (S1) — refactor only. Every task routes to cloud. Behavior identical to pre-refactor. Future phases (S2+) flip individual tasks to local substrates.
