# InariWatch Remediation System — Executive Summary

> **Start here.** One page. Reading time: 5 minutes. After this, read the four detail docs in order.
>
> **Date:** 2026-04-22
> **Owner:** Jesus Bernal (@JesusBrDev)

---

## The thesis in one sentence

**The SDK is the weapon, not the alert source.** Every other design choice flows from this.

---

## Why this matters

Every competitor in the error-monitoring space — Sentry, Rollbar, Datadog, Bugsnag — built a unidirectional SDK: capture error, ship to cloud, forget. The cloud then has to reconstruct context from a stack trace, spawn fresh containers, reinstall dependencies, and verify fixes in simulation. That architecture has a ceiling and we are near it.

InariWatch's `@inariwatch/capture` SDK already lives **inside the customer's production runtime**. That is a position of privilege nobody else has claimed. Used correctly, it means:

- **Context is native, not reconstructed.** Runtime vars, call stack, breadcrumbs, git state — all accessible without guesses.
- **Container setup cost is zero.** The customer's process IS the runtime. No clone, no npm install, no gVisor overhead.
- **Fixes are verified in the customer's actual system.** Substrate replay running locally produces cryptographic proof that the fix works where it matters.
- **The fine-tune dataset becomes unique.** Training examples include pre/post runtime state. No competitor can reproduce this without rebuilding their SDK from scratch.

This is not "better error monitoring." This is a **category shift** from *observability* to *active remediation peer*.

---

## The system at a glance

Two paths coexist:

**Default path (anyone can use):** alert → cloud Tier Router → 4 tiers of progressively powerful agents → gates → merge. Gets you p50 ~30-45s on a mature system.

**Enhanced path (Pro+ subscribers with SDK peer enabled):** same flow, but every tool call in Tiers 1/2/3 executes inside the customer's runtime via the SDK. Gets you p50 ~8-15s with cryptographic attestation.

The Enhanced path is the product's competitive edge. The Default path is what ships to Free users who grow into Pro.

---

## The 4 Pillars (cloud architecture)

1. **Tiered Intelligence Routing** — 4 tiers from Pattern Match (500ms, no AI) to Multi-agent Fan-out (90s, 5 parallel sub-agents). Classifier routes by difficulty. No neurosurgeon to apply band-aids.
2. **Speculative Parallel Exploration** — Tier 2/3 run N sub-agents with distinct hypotheses in parallel. Wall time = max(sub-agents), not sum.
3. **CodeAct as Default** — Agents write Python that orchestrates multiple tool calls per turn. 1 turn = 5-10 ops. Turns drop from 40 to 6.
4. **Continuous Learning Loops** — Pattern memory, community network, fine-tune dataset, prompt auto-optimization. The moat that compounds with time.

---

## The 5 Fases (SDK evolution)

A. **Foundation** — bidirectional transport (WebSocket), Ed25519 signature verification, ephemeral session keys.
B. **Read-only Peer** — policy engine, local tools (`read_file`, `get_git_state`, etc.), audit log.
C. **Full Agent Peer** — write tools, `run_command`, `apply_patch`. Pro-tier gated. **This is the category shift.**
D. **Local Replay + Certified Fix** — Substrate replay on demand, EAP attestation of replay outcomes. Enterprise-tier gated.
E. **Multi-language** — protocol is polyglot; runtime ports follow (Python, Go, Ruby, Java, Rust).

---

## What the SDK-enabled path delivers (vs default)

| Metric | Default path | SDK peer path |
|---|---|---|
| Tier 1 p50 | 7s | **6s with richer context → higher success** |
| Tier 2 p50 | 37-115s | **15-25s (zero container setup)** |
| Tier 3 p50 | 60-90s | **30-45s (no N-way container overhead)** |
| Fix verification | Cloud simulation | **Deterministic replay in real runtime** |
| Attestation | Merkle proof over cloud work | **Merkle proof over customer runtime** |
| Fine-tune data quality | Text patterns | **Text + pre/post runtime state** |

---

## The commercial model

**Option B — Tailscale-style.** SDK is open source (MIT, npm, GitHub). Protocol is open spec. Peer mode features require cloud subscription token validation. Free users install SDK and get observability. Pro users unlock Fase C (remediation execution). Enterprise users unlock Fase D (certified replay attestation).

Someone can fork the SDK and implement their own cloud — but the cloud is where the value is (pattern memory, fine-tuned models, community network, EAP chain server). The SDK is the entry point, not the moat.

---

## Why this is defensible

Competitors with 10-100x more headcount cannot replicate this in under 18 months because:

1. Their SDK architecture is unidirectional. Retrofitting bidirectional + policy + signing + audit is a ~12-month rewrite.
2. Their legal posture around "remote code execution inside customer runtime" is a board-level conversation, not a product decision.
3. Their customer trust model assumes they don't touch customer code. Reversing that narrative takes years.
4. The fine-tune dataset with runtime state is only collectable after years of peer-mode operation at scale. By the time a competitor catches up to Fase A, you have 24 months of superior training data.

---

## What this requires from the business

- **Infrastructure:** Hetzner CX52 (upgrade from CX22). Future: GPU server for self-hosted fine-tune (optional, Fase 10).
- **Security posture:** Pre-SOC2 stack now; SOC2 Type II by Year 2-3. Incident Response Plan is mandatory before Fase C ships.
- **Legal posture:** Customer Security Addendum, clear privacy messaging around SDK access, Responsible Disclosure policy.
- **Product positioning:** "Certified remediation" is the enterprise pitch. Not "error monitoring with AI."

---

## Reading order for the detail docs

1. **`REMEDIATION_SYSTEM_ARCHITECTURE.md`** — the cloud side, 13 fases, ADRs, full system diagram.
2. **`SDK_PEER_ARCHITECTURE.md`** — the SDK evolution, 5 fases, enhanced paths per tier.
3. **`PROTOCOL_SPEC.md`** — wire format, tools, policy schema, conformance tests.
4. **`SECURITY_AND_COMPLIANCE_ROADMAP.md`** — threat model, Incident Response Plan, Year 1-3 compliance path.

Parked for reference (superseded): `PROGRAMMATIC_TOOL_CALLING_PLAN.md`, `GPT54_AGENT_OPTIMIZATION_PLAN.md`.

---

## The one paragraph to remember

InariWatch is building the first remediation system where the SDK is a first-class agent inside the customer's runtime, signing commands with cryptographic proof, executing fixes with the customer's own dependencies loaded, and verifying outcomes via deterministic replay. Everything else in this architecture — the tier router, the CodeAct sandbox, the multi-agent fan-out, the continuous learning loops — exists to amplify that core asymmetry. Competitors can copy any individual piece. None of them can copy the SDK position without rebuilding their product from scratch. Build around that advantage and the market follows.

End of executive summary.
