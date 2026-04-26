# Monday Kickoff — qué hace cada quién el lunes

**Target audience:** Jesus (tú, ahora) + los 6 FTE cuando estén onboardeados.
**Fecha creación:** 2026-04-24.

---

## ⚠ REGLA #0 — Motor de AI

**Capture Skynet usa OpenAI (GPT-5.4 + GPT-5) durante todo el año 1.** No se entrena, fine-tunea ni sirve modelo propio. RCA-Net (`RCA_NET_PLAN.md`) está **PARKED**. Si un ticket pide "entrenar", "fine-tune", "servir Qwen/Llama", "bajar pesos", "correr GPU" — es un bug del ticket. DM a Jesus antes de tocar código.

---

## Mañana (tú solo, antes de cualquier contratación)

### Bloque 1 (9am - 11am): reclutamiento arrancar

1. **Publica las 6 JDs** — copia-pega de `HIRING_SPEC.md` §2:
   - Company blog (app.inariwatch.com/careers) — crea la sección si no existe.
   - HackerNews "Who's hiring?" (esperar al primer lunes del mes — es mensual).
   - LinkedIn company page.
   - Wellfound / AngelList.
   - Rust forum, CPython-dev mailing list, V8-dev mailing list.
2. **Sourcing outreach** — lista de 20 targets que vas a mensajear hoy. Arranca por:
   - Ex-Replay.io en LinkedIn (`ex-replay.io` en search). Mensaje personal cortito con link a `SUBSTRATE_V2_DESIGN.md` — el doc vende solo.
   - Ex-V8 Google en LinkedIn (filter por Chrome V8 Project) + link a `FORENSIC_VM_DESIGN.md`.
   - Ex-Anthropic / ex-OpenAI en Twitter (publicos), link a `RCA_NET_PLAN.md`.
3. **Calendly setup** — 3 slots de 30min por día para screening calls semanas próximas.

### Bloque 2 (11am - 1pm): arrancar MVP solo-tú

Mientras reclutas vas shippeando tú mismo + Claude Code para que el team encuentre un MVP real al llegar.

Primera tarea real: **Payload v2 schema + implementación en SDK Node**.

Plan concreto hoy:
1. Crear branch `feat/capture-v2-payload-schema`.
2. Añadir `capture/src/types-v2.ts` con el schema completo de `SKYNET_MASTER_PLAN.md` §12.
3. Implementar en `capture/src/client.ts` la generación del evento v2 (con fallback a v1 si `schema_version` no está).
4. Añadir `evidence.runtime_snap` capturado en momento del throw (process.memoryUsage + eventLoopDelay sample + activeHandles count).
5. Commit local. NO push todavía — queda batch para dentro de 2-3 días según cadence.

### Bloque 3 (2pm - 5pm): infra prep

1. **Provisioning Hetzner**:
   - Orden AX42 #1 (ClickHouse eventstore futuro). Setup básico, arrancará vacío.
   - Orden AX42 #2 (corpus + PII-NER CPU inference). Install Docker + onnxruntime.
   - Orden GEX44 (GPU RCA-Net). Verifica RTX 6000 Ada 48GB driver + CUDA + llama.cpp compila.
2. **Kamal config extension** — añadir los 3 nuevos hosts al `config/deploy.yml`.
3. **sops secrets** — agregar slots para `RCA_NET_GPU_HOST`, `CLICKHOUSE_HOST`, etc. (empty values por ahora, populados cuando shippee cada pieza).

### Bloque 4 (5pm - 6pm): comunicación externa

1. Tweet thread breve del approach: "Building the Skynet of error SDKs. 6 links to technical design docs. Hiring." — linkea a cada MD doc.
2. Update `PRODUCT_BIBLE.md` con capítulo Capture Skynet referenciando los 5 MDs.

---

## Día 1 post-onboarding — por rol

Asumiendo que todos arrancan el mismo día (realísticamente será escalonado mes 2-3).

### Team 1 — Principal Runtime Engineer (V8/CPython)

**Día 1 ticket**: `RUNTIME-001` — "POC V8 fork: captura frame locals al throw sin `Debugger` domain activo"

**Brief:**
> Fork V8 13.x (branch matching Node.js LTS). Implementa `v8::forensics::CaptureOnThrow` que itera stack frames al momento de `Isolate::Throw`, lee ScopeInfo + Context register file de cada frame, serializa a MessagePack, y lo expone via un callback C++ que el SDK Node consume via N-API.
>
> **Output esperado end-of-week-1**: build de Node.js con el fork que compila en Linux x86_64. Un script test que `throw new Error()` dentro de función con variables locales → callback recibe las variables. Overhead <5ms (budget relajado para POC; target <1ms al final).
>
> **Lee antes de empezar**: `FORENSIC_VM_DESIGN.md` completo. `SKYNET_MASTER_PLAN.md` §3 #12.

**Meeting day 1 con Jesus (30 min)**: alignment en arquitectura. Decisiones abiertas: ¿fork full Node o solo V8 shared lib? ¿LD_PRELOAD vs drop-in? Discusión.

---

### Team 2 — Staff Rust Systems Engineer

**Día 1 ticket**: `SUBSTRATE-001` — "Extend existing @inariwatch/substrate-agent: record Date.now + Math.random"

**Brief:**
> Substrate v1 ya captura I/O en ring buffer. Extender con:
> 1. Intercept `Date.now()` / `Date.prototype.valueOf` via V8 Isolate hook (o monkey-patch si es más práctico) — cada invocación graba el wall clock nanosecond al ring buffer y retorna el mismo valor al caller.
> 2. Intercept `Math.random` igual.
> 3. Al flush on throw, incluir estos en el recording output.
>
> **Output esperado end-of-week-1**: workload test que llama Date.now + Math.random 1000× → recording flush en error captura los 1000 valores en orden. Overhead <5% medido.
>
> **Lee antes**: `SUBSTRATE_V2_DESIGN.md` §3.1 + `CLAUDE.md` sección Substrate.

**Meeting day 1 con Jesus (30 min)**: walkthrough del código existente `@inariwatch/substrate-agent`.

---

### Team 3 — Staff ML Engineer

**Día 1 ticket**: `RCA-001` — "Corpus bootstrap pipeline + baseline SFT"

**Brief:**
> Arranca el corpus pipeline:
> 1. Script Python que scrapea GitHub issues cerrados de `facebook/react` + `vercel/next.js` + `prisma/prisma` (top 3 inicial), extrae (error_message + stack + commit_fix_diff).
> 2. Filtros de calidad: solo issues con linked PR merged + diff <200 LOC + reviewer approved.
> 3. Target: 5k ejemplos curados end-of-week-2.
> 4. Paralelo: setup de GEX44 Hetzner — cuda toolkit, torch, transformers, TRL. Run `Qwen/Qwen2.5-Coder-1.5B` inference básico.
>
> **Output esperado end-of-week-1**: 1k ejemplos scraped + GEX44 corriendo inference Qwen. Dashboard métricas corpus.
>
> **Lee antes**: `RCA_NET_PLAN.md` completo.

**Meeting day 1 con Jesus (30 min)**: alignment en corpus + el balance SFT vs RL timeline.

---

### Team 4 — Staff Polyglot SDK Engineer

**Día 1 ticket**: `SDK-PYTHON-001` — "Python SDK skeleton con PEP 669 hook"

**Brief:**
> Crear `capture/python/` directorio en el monorepo. Implementar:
> 1. Package Python `inariwatch-capture` (pyproject.toml, src/inariwatch_capture/).
> 2. Entry: `init(dsn=...)` registra un handler via `sys.monitoring` (PEP 669) para eventos `RAISE`.
> 3. Handler captura stack via `sys._getframe` + frame locals + serializa payload v2.
> 4. Transport: HMAC-SHA256 signing + POST to ingest endpoint (reuse schema de SDK Node).
>
> **Output esperado end-of-week-1**: `pip install ./capture/python` + script test `raise ValueError("test")` → evento v2 llegan a inari-web ingest.
>
> **Lee antes**: `SKYNET_MASTER_PLAN.md` §3 + `HIRING_SPEC.md` §2.4 + source del SDK Node (`capture/src/`).

**Meeting day 1 con Jesus + Team 2 (30 min)**: payload v2 schema finalizado antes de arrancar.

---

### Team 5 — Senior Kernel/eBPF Engineer

**Día 1 ticket**: `EBPF-001` — "Throw-aware uprobe en V8 Isolate::Throw"

**Brief:**
> `inariwatch-agent` (existente) ya tiene 7 probes activos. Extender con:
> 1. Uprobe en `v8::internal::Isolate::Throw` — scan `/proc/PID/maps` dinámico para localizar símbolo en binarios Node (y electron/deno si aparecen).
> 2. Al hit, captura PID + TID + timestamp + primer frame de stack (ya tienes infra stack sampling).
> 3. Envía evento tipo `runtime_exception` al cloud via mismo HTTPS transport existente.
>
> **Output esperado end-of-week-1**: workload Node con `throw new Error()` → evento `runtime_exception` llega al endpoint `/api/agent/events` con PID + stack + timestamp. Overhead <1% medido.
>
> **Lee antes**: `project_ebpf_agent.md` (memory) + codebase `inariwatch-agent/`.

**Meeting day 1 con Jesus + Team 1 (30 min)**: correlación con ForensicVM — cómo matcheamos uprobe event (PID+TS) con in-process locals capture.

---

### Team 6 — Senior TS/Node Engineer

**Día 1 ticket**: `CAPTURE-001` — "Implement payload v2 in SDK Node + ingest"

**Brief:**
> Completar lo que Jesus arrancó pre-hiring (feat/capture-v2-payload-schema):
> 1. Schema v2 completo tipado (`types-v2.ts`).
> 2. Transport envía v2 cuando `INARIWATCH_SCHEMA_V2=true` (flag), v1 default por backward-compat.
> 3. Server ingest (inari-web `/api/webhooks/capture/[integrationId]`) detecta v2 vs v1 y rutea.
> 4. Persist `evidence.*` campos en DB (Drizzle schema extension — nueva tabla `alertEvidence` vinculada por alertId).
>
> **Output esperado end-of-week-1**: SDK manda v2, server lo persiste, UI dashboard muestra evidence.stack[0].locals si existen.
>
> **Lee antes**: `SKYNET_MASTER_PLAN.md` §12 + branch `feat/capture-v2-payload-schema`.

**Meeting day 1 con Jesus (30 min)**: handoff del trabajo pre-hiring.

---

### Team 7 — Data/Corpus Engineer (contractor)

**Día 1 ticket**: `CORPUS-001` — "GitHub issues scraping pipeline: top 10 repos"

**Brief:**
> Expandir el corpus bootstrap (arrancado por Team 3) de 3 repos a 10:
> - facebook/react, vercel/next.js, prisma/prisma, drizzle-team/drizzle-orm
> - django/django, pallets/flask, rails/rails
> - nodejs/node, tokio-rs/tokio, microsoft/TypeScript
>
> Quality filters: issues closed con linked merged PR, PR diff <500 LOC, at least 2 reviewers approved, issue body length >200 chars.
>
> **Output esperado end-of-week-1**: 3k ejemplos curados commiteados a `rca-net-corpus/` (repo privado separado). Dashboard en Notion con counts per repo.

**Meeting day 1 con Team 3**: alignment de filtros y formato output JSONL.

---

## Rituales weekly post-team-onboardeado

### Monday 9am — Weekly planning (30 min)
- Jesus + 6 FTE.
- Cada uno shares: what I did last week + what I'll ship this week + blockers.
- Ticket priorities adjust.

### Wednesday 2pm — Technical deep-dive rotativo (60 min)
- 1 team member presenta sobre un problema técnico suyo.
- Rotate semanal.
- Goal: cross-pollination técnica.

### Friday 3pm — Demo day (60 min)
- Cada team demoes lo que shippearon.
- Async recording posted si alguien no puede asistir.
- Customer calls incluidos cuando posible.

### Daily standup — NO
- Async updates en Slack `#daily-updates` por cada quién una vez al día. No call diario.

---

## Primer milestone colectivo (end-of-mes-3)

Visible a un inversor / customer potencial:

> **MVP Capture Skynet** — demo que muestra:
> 1. Script Node trivial con `throw new Error()` dentro de función con locals.
> 2. SDK captura + forensics on throw (inspector.Session fallback) + envía payload v2 al ingest.
> 3. Ingest firma evidence con EAP v1 (Merkle + Ed25519).
> 4. Inari-web dashboard muestra: stack + locals + evidence.eap_signatures verificables.
> 5. Agent (capture-agent peer) produce 3 hipótesis pre-rankeadas inline.
> 6. Python SDK equivalente demuestra multi-lang.
> 7. eBPF agent corre paralelo y correlaciona con in-process por PID.
>
> **No incluye**: ForensicVM (POC only), Substrate v2 replay (recording only), RCA-Net custom (SFT baseline only).
>
> **Incluye**: arquitectura vista end-to-end funcionando en un demo 3 min.

Este demo = valida que el equipo puede shippear juntos + vende al inversor / primer customer enterprise.

---

## Resumen TL;DR

**Mañana tú (antes de hiring)**:
1. Publicar 6 JDs + outreach a 20 targets (9am-11am).
2. Arrancar payload v2 implementation en SDK Node (11am-1pm).
3. Provisionar 3 servers Hetzner nuevos (2pm-5pm).
4. Tweet thread + update PRODUCT_BIBLE (5pm-6pm).

**Día 1 post-hiring por rol**:
- Team 1 (Runtime): POC V8 fork capture locals.
- Team 2 (Rust): Extend Substrate con Date+Math record.
- Team 3 (ML): Corpus 1k + GEX44 setup.
- Team 4 (SDK polyglot): Python SDK skeleton PEP 669.
- Team 5 (eBPF): Uprobe V8 Isolate::Throw.
- Team 6 (TS/Node): Complete payload v2 end-to-end.
- Team 7 (Corpus): Scraping 10 repos → 3k examples.

**Primer milestone mes 3**: MVP end-to-end demoable.
