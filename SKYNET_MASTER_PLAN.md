# Skynet Master Plan — @inariwatch/capture v2

**Owner:** Jesus Bernal
**Status:** Planning → Execution kickoff
**Target:** 12 meses para shippear el mejor SDK de errores del mundo
**Tesis:** Capture deja de ser un wrapper de Sentry y se vuelve la primera plataforma de error intelligence AI-nativa con cryptographic provenance end-to-end.

---

## 0. REGLA INVIOLABLE DE AI (leer antes que nada)

**El motor de AI es OpenAI. No se entrena modelo propio en los primeros 12 meses.**

- Default: **GPT-5.4** vía `PLATFORM_AI_KEY` (OpenAI) con prompt caching agresivo.
- Fallback: **GPT-5** solo cuando GPT-5.4 falla la confianza mínima.
- Embeddings: `text-embedding-3-small` de OpenAI.
- PII detection: regex + (eventualmente) `microsoft/presidio` open-source. **No fine-tunear DistilBERT propio en año 1.**
- RCA-Net (`RCA_NET_PLAN.md`) es **un long-term moat opcional**, no entra en la ruta crítica del año 1. Nadie entrena, fine-tunea, ni sirve modelo propio sin que Jesus lo apruebe explícitamente por escrito. Si dudas: **usa OpenAI.**

**Prohibido sin aprobación previa:**
- Bajar pesos de Qwen/Llama/Mistral/etc para serving local.
- Comprar/correr GPUs para inference (la GEX44 está reservada para experimentación RCA-Net en paralelo, no es ruta crítica).
- Fine-tunear cualquier modelo (LoRA, QLoRA, full FT, RLHF, GRPO, DPO).
- Llamar a Claude / Gemini / Groq / DeepSeek / xAI desde código de Capture (la web app sí soporta BYOK multi-provider — eso ya está y no se toca; **dentro de Capture, solo OpenAI**).

**Si tu ticket parece pedir un modelo propio**, alto. Es un error de redacción del ticket. Mándame DM antes de tocar código.

---

## 1. Tesis en una frase

Construir un SDK que captura evidencia forense en-proceso al momento del throw, la firma criptográficamente con EAP Merkle+Ed25519, la envía en un payload diseñado para LLM (no para dashboard), corre un agente local que pre-diagnostica antes del egress, y sostiene un record-and-replay determinista que permite al agente server-side re-ejecutar el bug en sandbox Hetzner. Free para todo el mundo. Monetización vía enterprise features opcionales.

---

## 2. Restricciones reales

- **Infra**: `inari-web` + `inari-staging` ya corriendo en Hetzner (cubren el 100% del backend de Capture). + 3 servers adicionales €55/mes (AX42 ClickHouse, AX42 corpus+PII-NER, GEX44 RTX 6000 Ada 48GB para fine-tune RCA-Net) = ~€294/mes ≈ $3.8k/yr.
- **AI motor**: GPT-5.4 (default, cheap) + GPT-5 (cuando hace falta) vía OpenAI platform key ya existente. Prompt caching agresivo. Costo free-tier ~$100-3k/mes según volumen.
- **Team**: top-tier global remoto, sin limitarse por compensación. 6 FTE + 1 contractor corpus.
- **Producto**: Free forever para usuario final. Self-hosted opcional. Monetización: SaaS hosted + enterprise features (SSO, SOC 2, replay retention >7 días, on-prem, compliance-grade audit export).

---

## 3. Lo que hay que construir (21 piezas, ninguna omitida)

### Capa SDK
1. **Payload v2 AI-native** — evidence pack + hypotheses + tokens_estimated + graph form + embeddings pre-calculados en cliente.
2. **Forensics on throw** — `inspector.Session` attach-on-throw + `util.getCallSite()` + locals serialization con redaction (Node). Python equivalente usando PEP 669 (`sys.monitoring` con evento `RAISE`).
3. **Precursor stream** — event loop p99, RSS trajectory, active handles, near-misses (unhandled-then-handled rejections, retries, fallbacks, circuit breakers) samplados a 1Hz.
4. **Source snippets + git blame por frame** — slice 20 líneas alrededor de cada frame + blame por línea.
5. **Intent contracts compiler** — extrae expected-shape de TS types + OpenAPI + Drizzle + Prisma + Zod + GraphQL + Pydantic + Java records + Rust serde, lo mete al payload como `evidence.expected`.
6. **Fleet bloom filter** — bundle `known_fixes.bloom` (~2MB) per release + `hasAnyoneElseHit(fp)` <1ms + contribute-back anónimo.
7. **Causal Graph Engine** — `async_hooks` + hooks a Prisma/Drizzle/ioredis/undici/node-fetch/pg → graph con edges causal/temporal/data-flow (no breadcrumbs lineales). GALA (arXiv 2508.12472) demuestra +20pts en RCA.
8. **P2P gossip mesh workspace-level** — Durable Objects o NATS cluster + protocolo firmado + anti-abuse. Canary hits propagados <1s.
9. **MCP-native dev mode server** — stdio transport local con tools `get_recent_errors`, `diagnose_error_id`, `get_locals_at_frame`. Cursor/Claude Code lo consumen sin cloud.
10. **`@inariwatch/capture-agent` peer** — corre GPT-5.4 vía OpenAI API con 4 tools locales (`getLocalsAtFrame`, `evaluateInFrame`, `matchFingerprint`, `diffSinceDeploy`). Produce 3 hipótesis pre-rankeadas inline en payload antes del egress.
11. **Zero-retention mode + tombstone proofs** — redacción firmada (evento procesado sin persistir) + receipt Ed25519 para auditores.

### Capa forense profunda
12. **ForensicVM** — fork V8 + fork CPython con agent read-only forense que captura frame locals + closure chains + heap objects alcanzables SIN entrar en slow-path (sin activar dominio Debugger). Ver `FORENSIC_VM_DESIGN.md`.
13. **Substrate v2 determinista rr-tier** — record syscalls no-det (`Date.now`, `Math.random`, RNG crypto, `hrtime`), scheduler ordering, libuv events, DNS/TCP ordering + replay engine que re-ejecuta bytecode con inputs idénticos. Ver `SUBSTRATE_V2_DESIGN.md`.
14. **Replay-as-a-Service en inari-staging** — ejecuta Substrate v2 recording en sandbox gVisor, observa throw, mutate-test del fix candidate.

### Capa AI
15. **RCA-Net propio fine-tuned** — corpus (alert, evidencia, fix, outcome) + SFT + RL con reward = post-merge monitoring passed → modelo 1.5B-7B propio Q4. Ver `RCA_NET_PLAN.md`.
16. **PII-NER propio fine-tuned** — distilbert-multilingual quantizado Q8, 200+ tipos PII en 20 idiomas, ~50ms/KB en CPU.
17. **EAP v2 provenance chain** — extensión de los 6 crates `orbita-pos/eap`. Merkle+Ed25519 end-to-end: evidencia → hipótesis → fix → build → deploy → post-merge. Cada PR autofix trae proof criptográfico.

### Capa kernel
18. **eBPF agent throw-aware** — extender `inariwatch-agent` con uprobes en símbolos de runtime (`PyErr_SetObject`, `V8::internal::Isolate::Throw`, `runtime.gopanic`, `__cxa_throw`, Rust panic handler) + stitching con in-process via session-id/pid/k8s-pod.

### Capa SDKs multi-lang
19. **Multi-language SDKs full paridad**:
    - **Node.js / TypeScript** (existente, evolucionar a v2).
    - **Python** (nuevo, PEP 669 + PEP 657 + tracemalloc + faulthandler).
    - **Go** (nuevo, `runtime.Stack` + `debug.Stack` + `debug.SetCrashOutput` + `recover()`).
    - **Rust** (nuevo, `tracing-error::SpanTrace` + `catch_unwind` + `Backtrace`).
    - **Java / JVM** (nuevo, JFR + async-profiler + JDK 25 JEPs 509/518/520).
    - **C# / .NET** (nuevo, EventSource + DiagnosticSource).
    - **Browser** (existente, evolucionar con rrweb + Web Vitals + session replay).
20. **OpenAPI/schema auto-ingest** — inari-web lee schemas del repo linkeado al ingest para alimentar Intent contracts.
21. **Audit export compliance-grade** — exportador de cadenas EAP para SOC 2, PCI DSS 4.0, HIPAA, GDPR Article 30. Enterprise feature monetizable.

---

## 4. Lenguajes usados en la implementación

| Lenguaje | Para qué |
|---|---|
| **TypeScript / Node.js** | SDK Node, capture-agent peer, MCP server, UI inari-web, glue end-to-end |
| **Python** | SDK Python (clientes) + pipeline fine-tune RCA-Net (PyTorch + transformers + TRL) + pipeline PII-NER (datasets + transformers quantize) |
| **Go** | SDK Go para clientes |
| **Rust** | EAP v2 chain (extender 6 crates), Substrate v2 recording + replay engine, Intent contracts compiler core (AST parsing multi-lang), SDK Rust para clientes, userspace de `inariwatch-agent` (existente) |
| **Java** | SDK Java para clientes |
| **C#** | SDK C# / .NET para clientes |
| **C** | Fork CPython (ForensicVM), eBPF programs (existente en `inariwatch-agent/bpf/`, extendidos throw-aware) |
| **C++** | Fork V8 (ForensicVM), parche al inspector agent read-only |
| **eBPF (C restricted)** | Throw-aware uprobes multi-runtime |

---

## 5. Team (6 FTE + 1 contractor)

Detalle completo en `HIRING_SPEC.md`. Resumen:

| # | Rol | Foco principal | Compensación |
|---|---|---|---|
| 1 | Principal Runtime Engineer (V8/CPython) | ForensicVM | $400-500k + 0.5-1% equity |
| 2 | Staff Rust Systems Engineer | Substrate v2 + EAP v2 + Intent compiler | $280-380k + 0.3-0.5% |
| 3 | Staff ML Engineer | RCA-Net + PII-NER + eval harness | $300-400k + 0.3-0.5% |
| 4 | Staff Polyglot SDK Engineer | Python/Go/Rust/Java/C# SDKs | $220-300k + 0.2-0.3% |
| 5 | Senior Kernel/eBPF Engineer | Throw-aware `inariwatch-agent` + stitching | $250-350k + 0.2-0.3% |
| 6 | Senior TS/Node Engineer | Payload v2 + capture-agent + MCP + fleet + gossip + Causal Graph | $200-280k + 0.2-0.3% |
| 7 | Data/Corpus Engineer (contractor part-time) | Corpus curation, synthetic data GPT-5, anotación | $60-100k/yr |

**Payroll año 1**: $1.71-2.31M (punto medio ~$2M).
**Tú**: arquitecto + product + CEO, liberado de código.

---

## 6. Infra (Hetzner)

- **inari-web** (ya corriendo) — ingest, MCP, UI, remediation, EAP signing, Intent extraction, bloom filter hosting.
- **inari-staging** (ya corriendo) — replay containers gVisor, cron, batch jobs, corpus pipeline.
- **+1 AX42 €55/mes** — ClickHouse eventstore dedicado (cuando volumen lo exija; meses 3-6).
- **+1 AX42 €55/mes** — corpus pipeline + PII-NER CPU inference + embedding serving CPU.
- **+1 GEX44 €184/mes** — RTX 6000 Ada 48GB para fine-tune RCA-Net + serving.

**Hetzner adicional total**: ~€294/mes = $3.8k/yr.

---

## 7. Costo AI (OpenAI, ya existente)

Motor: **GPT-5.4 default + GPT-5 cuando hace falta** + prompt caching agresivo.
- Diagnosis por evento: ~$0.002-0.01.
- Remediation completa: ~$0.05-0.20.
- 10k usuarios × 100 events/día × 10% AI triggered = 3M events/mes AI = **~$300-3k/mes**.

RCA-Net propio (cuando shippee) reduce costo marginal a ~$0 para diagnosis + latency <50ms in-process. Usado como fallback offline y para casos latency-critical. Claude/GPT mantenido para remediation porque accuracy > latency ahí.

---

## 8. Burn total año 1

| Item | Monto |
|---|---|
| Payroll 6 FTE + 1 contractor | $1.77-2.41M |
| Hetzner adicional | $3.8k |
| OpenAI API | $10-40k |
| Tooling (GitHub Enterprise, Linear, Figma, Vercel Pro, observability, etc.) | $15k |
| Contingencia | $30k |
| **Total** | **~$1.83-2.5M/yr** |

Runway requerido: **$4-6M seed** o **$6-10M Series A**. Alternativa bootstrap: $100-250k MRR enterprise tier al año 2.

---

## 9. Timeline (12 meses)

### Mes 0 (pre-hiring, semanas 1-8)
**Solo tú + Claude Code mientras reclutas.** Shippeas el MVP Skynet que vas a mostrar en entrevistas.

Entregables:
- Payload v2 spec formal (Zod + JSON Schema + OTel mapping).
- Payload v2 implementado en SDK Node (backward-compat con v1).
- Forensics on throw (`inspector.Session` + `util.getCallSite`) + locals redaction.
- Precursor stream básico (event loop + RSS + handles) a 1Hz.
- Source snippet + git blame por frame.
- EAP signing básico (firma campos top-level del payload).
- MCP dev-mode server stdio con 3 tools.
- Ingest v2 en `inari-web` acepta payload enriquecido + almacena evidencia.

Este MVP solo ya es superior a Sentry en el eje AI-native. Pitch de reclutamiento.

### Mes 2-4: team onboarding + arranque paralelo
Con 6 FTE onboardeados, 6 pistas paralelas arrancan. Ver sección 10 — asignación Monday-kickoff.

### Mes 4-6
- **Runtime**: ForensicVM POC Node validado (fork V8 con inspector read-only shippeable).
- **Rust**: Substrate v2 recording layer shippeado (syscalls no-det + scheduler).
- **ML**: Corpus >50k ejemplos etiquetados, primer RCA-Net-1.5B baseline superior a GPT-5.4 zero-shot en eval harness interno.
- **SDK polyglot**: Python SDK + Go SDK shippeados con payload v2.
- **eBPF**: throw-aware uprobes funcionando en Node + CPython + Go.
- **TS/Node**: Causal Graph v1 shippeado. Fleet bloom filter activo. capture-agent peer v1.

### Mes 6-9
- **Runtime**: ForensicVM Python shippeado.
- **Rust**: Substrate v2 replay engine en inari-staging operativo, replay-as-a-service vivo.
- **ML**: RCA-Net v1 deployed, inference en Hetzner GEX44, fallback local en capture-agent peer.
- **SDK polyglot**: Rust + Java SDKs.
- **eBPF**: stitching kernel-userspace operativo. Agent correlaciona DNS/TLS/syscalls con frame locals.
- **TS/Node**: Intent contracts compiler v1 (TS + Zod + Drizzle). Gossip p2p workspace operativo.

### Mes 9-12
- **Runtime**: ForensicVM productizado con mantenimiento automatizado del fork contra upstream V8/CPython.
- **Rust**: EAP v2 chain end-to-end: cada PR de autofix con Merkle proof. Intent contracts compiler core Rust completo.
- **ML**: RL loop cerrado. RCA-Net v2 iterando cada 2 semanas con outcome signals reales. PII-NER shipped.
- **SDK polyglot**: C# SDK. Audit export compliance shipped.
- **eBPF**: multi-runtime full paridad.
- **TS/Node**: Intent compiler full (OpenAPI + Prisma + GraphQL + Pydantic). Zero-retention mode. Tombstone proofs.

### Año 2
- Dominio del eje AI-native + cryptographic provenance.
- RCA-Net v3 con >100k outcome-labeled examples.
- Enterprise tier con SOC 2 Type II + PCI DSS 4.0.
- Capture no es "otro SDK" — es categoría nueva.

---

## 10. Moat resultante

1. **ForensicVM** — único error SDK con fork V8/CPython capturando locals sin slow-path. 2+ años de ventaja.
2. **Substrate v2 rr-tier** — único record-and-replay determinista Node en prod. Replay.io = $20M ARR solo por esto; está dentro del SDK.
3. **RCA-Net con outcome loop** — dataset irreplicable sin usar tu producto 18 meses.
4. **EAP v2 chain** — cada PR autofix con Merkle proof Ed25519. Auditores SOC 2 / PCI / financiero compran esto solo.
5. **eBPF + in-process stitched** — DNS/TLS/syscalls + frame locals + expected schema + causal graph unificado. Nadie tiene las dos mitades juntas.
6. **Multi-lang paridad full** — Node+Python+Go+Rust+Java+C#+Browser con payload v2 idéntico. Sentry tardó 10 años y tiene SDKs inconsistentes.

Tesis moat: "Sentry/Datadog eventualmente compran esto o se vuelven legacy."

---

## 11. Docs hermanos

- `FORENSIC_VM_DESIGN.md` — diseño fork V8/CPython (recruiting principal runtime).
- `SUBSTRATE_V2_DESIGN.md` — recording + replay determinista (recruiting Rust staff).
- `RCA_NET_PLAN.md` — corpus + SFT + RL + eval + deployment (recruiting ML staff).
- `HIRING_SPEC.md` — 6 JDs completas + proceso + evaluación.
- `MONDAY_KICKOFF.md` — qué hace cada uno el día 1 post-onboarding.

---

## 12. Payload v2 schema (appendix — spec formal)

```ts
export interface ErrorEventV2 {
  schema_version: "2.0"
  fingerprint: string
  title: string
  severity: "critical" | "error" | "warning" | "info"
  timestamp: string // ISO 8601

  // AI-native section
  evidence: {
    stack: Array<{
      file: string
      line: number
      col?: number
      function: string
      locals?: Record<string, SerializedValue> // from forensics
      source_slice?: {
        before: string[] // 10 lines
        line: string
        after: string[]  // 10 lines
      }
      git_blame?: { commit: string, author: string, date: string, message: string }
      tokens_estimated: number
    }>
    breadcrumbs: Breadcrumb[] // last 30
    request?: RequestContext
    response_expected_schema?: IntentContract // from Intent compiler
    deploy?: { sha: string, diff_urls: string[], risk_tags: string[], age_seconds: number }
    flags?: Record<string, string> // LaunchDarkly/Statsig/PostHog auto-read
    experiments?: Record<string, string>
    runtime_snap: {
      heap_mb: number
      rss_mb: number
      eventloop_p99_ms: number
      open_handles: number
      async_stack?: string[]
    }
    precursors?: Array<{
      signal: string // "eventloop_p99", "rss_trend", "retry_burst"
      delta_pct: number
      window_seconds: number
    }>
    near_misses_last_60s?: NearMiss[]
    cohort?: { users_hit: number, rps_delta: number, canary_pct: number }
    tokens_estimated_total: number
  }

  hypotheses: Array<{
    text: string
    prior: number // 0-1, from local capture-agent or bloom match
    cites: string[] // ["evidence.stack.0.locals.user", "evidence.breadcrumbs.4"]
    confidence: number
    source: "local_agent" | "bloom_match" | "heuristic"
  }>

  embedding_v1?: Float16Array // 1024D, Qwen3-Embedding-0.6B Q8 CPU

  replay?: {
    tier: "substrate_v2" | "substrate_v1" | "rrweb" | "prediction_only"
    id: string
    size_mb: number
    est_tokens: number
  }

  fleet_match?: {
    community_fix_id: string
    success_rate: number
    sample_diff_url: string
    teams_hit: number
  }

  // Provenance
  eap_signatures: {
    evidence_merkle_root: string // sha256 hex
    evidence_signature: string // Ed25519 hex
    signer_pubkey: string // Ed25519 public key hex
    signed_at: string // ISO 8601
  }

  // Legacy compat (for old ingest)
  body?: string // rendered stack for human display
  environment?: string
  release?: string
  runtime?: "nodejs" | "edge" | "python" | "go" | "rust" | "jvm" | "dotnet" | "browser"
  user?: { id?: string, role?: string }
  tags?: Record<string, string>
}
```

**Token budget default**: 8K. SDK aplica prioridad de retención: `hypotheses > evidence.stack[0].locals > evidence.stack[0].source_slice > evidence.precursors > evidence.runtime_snap > evidence.breadcrumbs > evidence.near_misses > rest`.

Backward compat: si server recibe sin `schema_version`, asume v1. Si recibe v2, lee los campos nuevos. SDK cliente siempre envía v2. Se elimina v1 a los 6 meses post-launch.
