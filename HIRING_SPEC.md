# Hiring Spec — Capture Skynet Team

**Status:** Ready to start recruiting
**Owner:** Jesus Bernal
**Goal:** 6 FTE onboarded by end of Mes 2

---

## ⚠ REGLA AI #0 (debe aparecer en cada JD y onboarding packet)

> Capture Skynet usa **OpenAI (GPT-5.4 default + GPT-5 fallback)** vía `PLATFORM_AI_KEY` durante el año 1. **No** entrenamos, fine-tuneamos ni servimos modelos propios en código de Capture. El rol Staff ML Engineer existe principalmente para: (a) prompt engineering + eval harness sobre OpenAI, (b) evaluar si/cuándo activar RCA-Net en año 2, (c) PII detection con regex/Presidio. Cualquier propuesta de "modelo propio" requiere aprobación escrita de Jesus.

---

## 1. Estructura del team

| # | Rol | FTE | Compensación | Doc principal |
|---|---|---|---|---|
| 1 | Principal Runtime Engineer (V8/CPython) | 1 | $400-500k + 0.5-1% | FORENSIC_VM_DESIGN.md |
| 2 | Staff Rust Systems Engineer | 1 | $280-380k + 0.3-0.5% | SUBSTRATE_V2_DESIGN.md |
| 3 | Staff ML Engineer (code/RCA) | 1 | $300-400k + 0.3-0.5% | RCA_NET_PLAN.md |
| 4 | Staff Polyglot SDK Engineer | 1 | $220-300k + 0.2-0.3% | SKYNET_MASTER_PLAN.md §3 |
| 5 | Senior Kernel/eBPF Engineer | 1 | $250-350k + 0.2-0.3% | SKYNET_MASTER_PLAN.md §3 #18 |
| 6 | Senior TS/Node Engineer | 1 | $200-280k + 0.2-0.3% | SKYNET_MASTER_PLAN.md §3 #1,7,8,10 |
| 7 | Data/Corpus Engineer (contractor PT) | 0.5 | $60-100k/yr | RCA_NET_PLAN.md §3 |

**Total año 1**: $1.71-2.31M payroll + contingencia 10%.

---

## 2. JDs completas

### 2.1 Principal Runtime Engineer — V8/CPython

**Misión:** Construir y mantener ForensicVM — un fork minimal de V8 y CPython que expone un API read-only forense para capturar frame locals + closures + heap objects reachable al momento del throw SIN activar el slow-path del debugger.

**Responsabilidades:**
- Diseñar y mantener el fork de V8 (base Node.js LTS current).
- Diseñar y mantener el fork de CPython (3.13+ con PEP 669).
- Automatizar rebase contra upstream cada minor release.
- CI con diff testing contra V8/CPython stock.
- Distribution pipeline (npm/pip packages con binarios multi-platform).
- Ownership del overhead budget: <1ms por throw, zero overhead en code path normal.

**Must have:**
- 5+ años V8 internals o CPython internals en producción.
- C++ (V8) + C (CPython) expertise.
- Experiencia shippeando forks mantenidos (no "escribí un patch una vez").
- Understanding de debugging protocols (CDP, Chrome DevTools Protocol).

**Nice to have:**
- Commits upstream en Chromium (V8) o CPython.
- Ex-Mozilla SpiderMonkey, ex-Apple JSC, ex-Meta Hermes, ex-Cloudflare Workers, ex-Replay.io.
- Rust para tooling auxiliar.

**Evaluación:**
1. Screening call 30 min — background + motivación.
2. Technical deep-dive 90 min — walk through V8 frame iteration code, diseñar en pizarra cómo capturar scope info sin activar `Debugger` domain.
3. Paid 1-week trial — implementar un POC minimal: fork V8, capturar locals de un throw, overhead <2ms. Compensation: $5k.
4. Team fit 60 min con Jesus.
5. Offer.

**Proceso**: 3-4 semanas.

**Compensación**: $400-500k base + 0.5-1% equity vesting 4 años + 1 cliff. Remoto global. Relocation no requerida. Bonus performance hasta +25%.

---

### 2.2 Staff Rust Systems Engineer

**Misión:** Construir Substrate v2 (deterministic record-and-replay para Node) + extender EAP v2 chain (Merkle+Ed25519 crypto provenance) + Intent contracts compiler core.

**Responsabilidades:**
- Substrate v2 recording layer: interceptar todas las fuentes de no-determinismo (Date, Math, crypto, scheduling, I/O) con overhead <3%.
- Substrate v2 replay engine corriendo en inari-staging gVisor sandbox.
- Replay-as-a-Service API (mutate-test fix candidates).
- Extender los 6 crates `orbita-pos/eap` con chain end-to-end (evidence → hypothesis → fix → build → deploy → post-merge).
- Intent contracts compiler core (AST parsing multi-lang — TS, Python, Go, Rust, Java).

**Must have:**
- 5+ años Rust producción.
- Systems-level: syscall interception, async I/O (tokio/libuv), timing, zero-copy serialization.
- Native Node addon experience (neon/napi-rs) o equivalente.
- Al menos 1 producto performance-critical Rust shipeado.

**Nice to have:**
- **Ex-Replay.io**: match exacto — ellos hicieron esto con fork V8. Aggressive recruit prioritario.
- Ex-Cloudflare Workers, ex-TigerBeetle, ex-Oxide, ex-Meta infra.
- Criptografía aplicada (Ed25519, Merkle, signatures) — para EAP v2.
- Familiaridad con rr, Hermit, Pernosco.

**Evaluación:**
1. Screening 30 min.
2. Technical 90 min — diseñar recording de `Math.random` con overhead <1µs.
3. Paid 1-week trial — POC que captura Date.now + Math.random + replay determinista en un script test. Compensation: $5k.
4. Team fit 60 min.
5. Offer.

**Compensación**: $280-380k + 0.3-0.5% equity.

---

### 2.3 Staff ML Engineer — code/RCA

**Misión:** Construir RCA-Net — modelo fine-tuned propio Qwen2.5-Coder-1.5B que supera GPT-5.4 zero-shot en RCA interno por >15 puntos. Corpus + SFT + RL loop con outcome signals reales + eval harness + deployment. También PII-NER propio (distilbert fine-tuned).

**Responsabilidades:**
- Corpus: scraping GitHub issues + Stack Overflow + CWE + synthetic generation con GPT-5.
- Pipeline SFT con TRL + PEFT en Hetzner GEX44 (RTX 6000 Ada 48GB).
- RL loop con reward = post-merge monitoring passed (GRPO).
- Eval harness: propio + DebugBench + SWE-bench.
- Deployment: llama-server en Hetzner GEX44 + capture-agent peer distribution.
- PII-NER: fine-tune distilbert-multilingual, 200+ PII types, 20 idiomas.

**Must have:**
- 5+ años ML producción (no solo research).
- LLM fine-tuning experience con TRL/PEFT/DPO/GRPO.
- Experience con quantización (GGUF, AWQ, GPTQ) + serving optimizado.
- Al menos 1 modelo fine-tuned en prod que superó baseline mayor.

**Nice to have:**
- Ex-Anthropic, ex-OpenAI, ex-DeepMind, ex-Meta FAIR, ex-Hugging Face.
- Code models específicamente (CodeLlama, Qwen-Coder, StarCoder, DeepSeek-Coder).
- Eval harness robustos (lm-eval, HELM, BIG-Bench).
- Papers en ICML/NeurIPS/ACL.

**Evaluación:**
1. Screening 30 min.
2. Technical 90 min — diseñar pipeline fine-tune + eval para RCA. Discusión de reward hacking, catastrophic forgetting.
3. Paid 1-week trial — SFT baseline de Qwen2.5-Coder-1.5B con corpus de 1k ejemplos curado por el candidato. Métrica accuracy ≥35%. Compensation: $5k.
4. Team fit 60 min.
5. Offer.

**Compensación**: $300-400k + 0.3-0.5% equity.

---

### 2.4 Staff Polyglot SDK Engineer

**Misión:** Shippear 6 SDKs con payload v2 full paridad — Python, Go, Rust, Java, C#, Browser (Node ya existe). Mantener consistencia cross-language.

**Responsabilidades:**
- Python SDK (PEP 669, PEP 657, tracemalloc, faulthandler). Primera entrega mes 4.
- Go SDK (runtime.Stack, debug.Stack, recover). Mes 5.
- Rust SDK (tracing-error, catch_unwind, Backtrace). Mes 6.
- Java SDK (JFR, async-profiler). Mes 8.
- C# SDK (EventSource, DiagnosticSource). Mes 10.
- Browser SDK v2 (rrweb, Web Vitals, session replay). Mes 9.
- Payload v2 schema conformance tests cross-lang.
- Docs + examples cada SDK.

**Must have:**
- 5+ años polyglot SDK development.
- Shipped production SDKs en ≥3 lenguajes.
- Obsesión con ergonomics + zero-config DX.
- Experience con package registries (npm, PyPI, Maven, NuGet, crates.io).

**Nice to have:**
- Ex-Sentry, ex-Datadog, ex-Honeycomb, ex-New Relic SDK team.
- Experience con telemetry/observability protocols (OTel).

**Evaluación:**
1. Screening 30 min.
2. Technical 60 min — walk through existing Node SDK (capture/src/), discuss cómo portar a Python.
3. Paid 1-week trial — Python SDK skeleton con PEP 669 hook + 1 test end-to-end sending payload v2 al ingest. Compensation: $5k.
4. Team fit 60 min.
5. Offer.

**Compensación**: $220-300k + 0.2-0.3% equity.

---

### 2.5 Senior Kernel/eBPF Engineer

**Misión:** Extender `inariwatch-agent` (existente) con throw-aware eBPF uprobes multi-runtime + stitching con in-process SDK via session-id/pid/k8s-pod.

**Responsabilidades:**
- eBPF uprobes en símbolos de runtime: `PyErr_SetObject`, `V8::internal::Isolate::Throw`, `runtime.gopanic`, `__cxa_throw`, Rust panic handler.
- Correlation layer: unir eventos del agent (DNS/TLS/syscalls/network) con eventos in-process (frame locals/breadcrumbs) por session-id.
- Optimizar overhead <1% CPU sostenido.
- CO-RE (Compile Once Run Everywhere) para portabilidad kernel 5.8+.
- Maintain CI con kernel matrix testing.

**Must have:**
- 3+ años eBPF producción.
- C restricted (BPF verifier) expertise.
- Experience con libbpf, CO-RE, BTF.
- Shipped un agent eBPF en producción.

**Nice to have:**
- Ex-Cilium, ex-Pixie, ex-Parca, ex-Beyla, ex-Datadog APM team.
- Rust userspace (nuestro agent es Rust).
- Kernel driver experience.

**Evaluación:**
1. Screening 30 min.
2. Technical 90 min — diseñar uprobe en `runtime.gopanic` + serializar stack trace sin crashear el BPF verifier.
3. Paid 1-week trial — POC uprobe en libssl.so.3 que captura `SSL_write` + envía al agent. Compensation: $5k.
4. Team fit 60 min.
5. Offer.

**Compensación**: $250-350k + 0.2-0.3% equity.

---

### 2.6 Senior TS/Node Engineer

**Misión:** Ownership de toda la capa TS/Node de Capture — payload v2, capture-agent peer, MCP dev mode, fleet bloom filter, p2p gossip mesh, Causal Graph Engine, Intent contracts TS/Zod/Drizzle.

**Responsabilidades:**
- Payload v2 implementation en SDK Node + server ingest.
- Capture-agent peer corriendo GPT-5.4 + fallback RCA-Net local.
- MCP dev mode server stdio.
- Fleet bloom filter build + serving.
- P2P gossip mesh (Durable Objects o NATS).
- Causal Graph Engine (async_hooks + hooks por lib).
- Intent contracts compiler TS subset (Zod, Drizzle, OpenAPI).

**Must have:**
- 5+ años TypeScript/Node producción.
- Experience con monorepo + package publishing.
- Understanding profundo de async_hooks, AsyncLocalStorage, event loop internals.
- Haber shippeado una SDK o library npm con >10k users.

**Nice to have:**
- Ex-Vercel, ex-Next.js core, ex-Sentry Node SDK, ex-Honeycomb-web team.
- MCP ecosystem experience (Model Context Protocol).
- Rust para integraciones (EAP signing, Substrate agent bridge).

**Evaluación:**
1. Screening 30 min.
2. Technical 90 min — diseñar Causal Graph con async_hooks que correla DB query → HTTP response.
3. Paid 1-week trial — POC de fleet bloom filter: build script + SDK check <1ms + contribute-back. Compensation: $5k.
4. Team fit 60 min.
5. Offer.

**Compensación**: $200-280k + 0.2-0.3% equity.

---

### 2.7 Data/Corpus Engineer (contractor part-time)

**Misión:** Alimentar RCA-Net + PII-NER con corpus curado. Scraping + cleaning + synthetic data generation + anotación.

**Responsabilidades:**
- Scraping pipeline: GitHub issues (top 50 repos), Stack Overflow dumps, CWE, NVD.
- Synthetic data pipeline: prompt GPT-5 con ejemplos reales, generar variants.
- Anotación: labelear outcome (fix worked / failed) para RL.
- Quality control: detectar duplicates, near-duplicates, low-quality examples.

**Must have:**
- 2+ años data engineering con unstructured text.
- Experience con scraping a scale (respetando ToS).
- Python fluent + pandas/polars.

**Compensación**: $60-100k/yr contractor. 20h/semana.

---

## 3. Proceso de reclutamiento

### 3.1 Sourcing channels

**Priority 1 (ex-ideal company talent):**
- Ex-Replay.io: LinkedIn search + cold outreach. Replay.io hizo layoffs 2024, hay talento disponible.
- Ex-Sentry SDK team: post-Seer direction, algunos descontentos con el giro "AI-first" sin user control.
- Ex-Anthropic/OpenAI: LinkedIn + Twitter.
- Ex-Meta Hermes/Hermit: ex-Meta infra network.
- Ex-Cloudflare Workers runtime team.

**Priority 2 (public signal):**
- Hacker News "Who's hiring?" posts mensuales con enlaces a docs (FORENSIC_VM_DESIGN.md, etc.) — docs técnicos concretos atraen talento técnico.
- Rust forum / CPython-dev / V8-dev mailing lists.
- GitHub: top contributors de V8, CPython, llama.cpp, TRL, HF.
- Twitter: engage con threads técnicos relevantes.

**Priority 3 (traditional):**
- Terminal.io, Lemon.io, Athyna para LATAM.
- AngelList, Wellfound.
- No usar recruiters hasta validar que sourcing directo no alcanza.

### 3.2 Evaluation framework

Cada rol pasa por:
1. **Screening call** (30 min — Jesus): background, motivación, fit cultural.
2. **Technical deep-dive** (60-90 min — Jesus + senior referral si hay): discusión del problema real del rol.
3. **Paid trial** (1 semana, $5k): implementar un POC concreto del trabajo real.
4. **Team fit** (60 min): si hay ≥2 del team onboardeados, meeting conjunto.
5. **Reference check**: 2 referencias.
6. **Offer**.

**Anti-patterns a evitar:**
- Leetcode: NO. Evaluamos skills reales del rol.
- Whiteboarding abstracto: limitado, reemplazar con paid trial.
- Take-home sin pago: NO. Tiempo del candidato vale.
- Más de 5 entrevistas: NO. Fatiga = talento top se va.

### 3.3 Timeline de hiring

- **Semana 1-2**: publicar JDs + sourcing outreach.
- **Semana 3-6**: screening calls + technical deep-dives.
- **Semana 5-8**: paid trials en paralelo.
- **Semana 8-10**: offers + negotiation.
- **Semana 10-12**: onboarding arranca.

Target: 6 FTE onboardeados end of Mes 2 (semana 10-12).

---

## 4. Onboarding (día 1 - día 30)

### 4.1 Día 1 común a todos

- Acceso a:
  - GitHub organization (`orbita-pos`).
  - inari-web + inari-staging SSH deploy keys.
  - Hetzner cloud console (read-only inicial).
  - Linear / Notion / Slack.
  - OpenAI + Claude API keys dev.
- Docs a leer (CAPTURE onboarding packet):
  - `CLAUDE.md` (repo).
  - `SKYNET_MASTER_PLAN.md`.
  - Su doc principal (FORENSIC_VM / SUBSTRATE_V2 / RCA_NET / HIRING).
  - `PRODUCT_BIBLE.md`.
- 1:1 con Jesus 60 min — visión, product, cultura.
- Setup laptop + dev env (match spec runtime target).

### 4.2 Semana 1

- Code walkthrough del código existente relevante.
- Pair programming con Jesus o peer 1 sesión.
- Primer ticket tagged `good-first-issue` en el área del rol (no trivial, pero scoped).
- Friday demo de primera semana.

### 4.3 Mes 1 checkpoint

- Primera entrega real shippeable al área del rol.
- Review con Jesus: alignment, blockers, cultural fit.

---

## 5. Equity structure

- Pool total: ~15% reserved para team.
- Vesting: 4 años con 1 año cliff, monthly después del cliff.
- Acceleration: 100% on change-of-control.
- 409A valuation cada año o cuando hay round.
- Post-termination exercise window: 10 años (no 90 días — mejor talento exige esto).

---

## 6. Cultura del team

- **Remoto global** — no "remote but US hours". Real global remote con core overlap 4h.
- **Async first** — documentos > meetings.
- **Ship weekly** — ritmo high, pero sustainable. No burn-out.
- **Open source** — todo lo que no sea moat directo va open source.
- **No politics** — decisiones técnicas por mérito, no jerarquía.
- **Customer obsession** — cada PR en prod valida con un usuario real antes de merge.

---

## 7. What we offer pitch (para JD public)

> Building the Skynet of error SDKs. ForensicVM (fork V8/CPython), Substrate v2 (deterministic record-and-replay), RCA-Net (fine-tuned ML propio), EAP v2 (cryptographic provenance end-to-end), multi-language SDKs with AI-native payload. No Sentry wrapper — category creation.
>
> Hetzner infra running day 1. GPU (RTX 6000 Ada 48GB) dedicated. $4-6M seed commitment. Remote global. Top-of-market comp + meaningful equity. Ownership of tesis-critical pieces. Team of 6 top-tier engineers + founder. No process theater. Ship weekly.
>
> If you spent years wanting to fork V8 / build rr for Node in prod / train a RCA model that actually beats GPT zero-shot — this is the job.
