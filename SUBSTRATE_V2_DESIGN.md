# Substrate v2 Design — Deterministic Record-and-Replay

**Status:** Design spec, recruiting doc for Staff Rust Systems Engineer
**Owner:** Staff Rust Systems Engineer (TBD)
**Base:** Substrate v1 (existente) — I/O ring buffer 60s, flush on error

---

## 1. Por qué v2

Substrate v1 captura I/O (HTTP, DB, file ops) en ring buffer y lo adjunta al error. Suficiente para contexto, **no suficiente** para replay determinista.

"Replay determinista" significa: dado un recording, podemos re-ejecutar el proceso con la misma secuencia exacta de eventos y obtener el **mismo crash en el mismo lugar con el mismo stack**. Eso permite:

- Agente server-side re-ejecuta el bug en sandbox gVisor en inari-staging.
- Mutate-testing del fix: cambio una línea → replay → el error desaparece? → fix validado sin push.
- Bisect automático: ¿cuándo se introdujo el bug? Replay contra cada commit reciente.
- Flaky tests deterministas: si pasa localmente pero falla en CI, replay recording de CI → reproducible.

Referencia de mercado: **Replay.io ($20M ARR)** existe exclusivamente por tener esto en Node. Forkearon V8 para lograrlo. Nosotros lo construimos dentro del SDK sin forkear el runtime (Substrate v2 no requiere ForensicVM — son piezas ortogonales).

---

## 2. Fuentes de no-determinismo en Node.js

Hay que capturar y replayear estas:

### Time
- `Date.now()`, `Date.prototype.*`
- `process.hrtime()`, `process.hrtime.bigint()`
- `performance.now()`, `performance.timeOrigin`

### Randomness
- `Math.random()`
- `crypto.randomBytes()`, `crypto.randomUUID()`, `crypto.getRandomValues()`
- V8 internal hash seed

### I/O (ya cubierto en v1, extender para determinismo)
- HTTP client responses (status, headers, body, timing)
- DB responses (rows, timing)
- File system reads (content, mtime, stat)
- DNS resolution (IP results, order)
- TCP packet ordering + timing

### Concurrency / scheduling
- libuv event loop ordering (qué I/O callback se ejecuta primero cuando varios están listos)
- Microtask queue ordering
- setTimeout/setInterval jitter (timer wheel dispatches)
- Promise resolution order cuando hay empate

### Runtime state
- `process.env` en el momento del fork (capturado una vez)
- `process.pid`, `process.ppid`
- `os.hostname()`, `os.networkInterfaces()`

### Cuando hay cluster/worker_threads
- Mensaje inter-proceso: orden de recepción.

---

## 3. Arquitectura

### 3.1 Recording layer

Escrito en **Rust**, linkado al proceso Node como native addon (`neon` o `napi-rs`).

**Modo record (flag on):**

```
Node.js process
  |
  +-- V8 engine
  |     |
  |     +-- @inariwatch/substrate-agent (Node addon, Rust impl)
  |           |
  |           +-- Intercepts:
  |                 - Date.now, hrtime, performance.now → records nanosecond + returns
  |                 - Math.random, crypto.random* → records bytes + returns
  |                 - fs.*, http.*, pg.query, etc. → records syscall + return value
  |                 - libuv callbacks → records scheduling decision
  |
  +-- Ring buffer (configurable 60s-10min, default 120s)
        |
        +-- On throw: flush + sign with EAP + attach to ErrorEvent v2
```

Implementación:
- Monkey-patch de los APIs no-det con Rust fast-path (microsegundos overhead).
- Ring buffer shared memory (zero-copy entre threads).
- Serialización: MessagePack o bincode custom.
- Overhead target: **<3% throughput** en workload I/O-bound (match a Replay.io).

### 3.2 Replay engine

Proceso separado que corre en **inari-staging** (sandbox gVisor).

**Modo replay (flag on + recording loaded):**

```
Node.js process (replay mode)
  |
  +-- @inariwatch/substrate-agent (replay mode)
        |
        +-- Same monkey-patches, pero ahora:
              - Date.now() → returns recorded value, no wall clock
              - Math.random() → returns recorded bytes
              - fs/http/db calls → returns recorded response, no network
              - libuv scheduling → forced order match
        |
        +-- Loads recording file
```

Al final del replay, el proceso debería crashear **en el mismo lugar** que el recording original. Si no:
- El recording no capturó toda la fuente de no-det (bug en nuestra implementación).
- El código cambió entre record y replay (mutate-test case — esto es feature, no bug).

### 3.3 Integration con inari-staging (Replay-as-a-Service)

```
POST /replay/run
  body: { recording_id, code_ref?: git_sha }
  ↓
inari-staging:
  1. Pull recording from R2/S3.
  2. Pull code at `code_ref` (default: original recording's SHA).
  3. Spawn gVisor container with Node + @inariwatch/substrate-agent replay mode.
  4. Mount recording as input.
  5. Run.
  6. Capture: did it crash? where? stack match recording?
  7. Return {crashed, frame_match, time_ms, output}
```

Para mutate-test del fix:
```
POST /replay/verify-fix
  body: { recording_id, fix_patch: unified_diff }
  ↓
  1. Apply patch to code.
  2. Run replay.
  3. Return: fixed? (crash disappeared = true)
```

---

## 4. EAP v2 chain integration

Cada recording firmado Ed25519 al momento del record. El Merkle root del recording se incluye en `evidence.eap_signatures.evidence_merkle_root` del ErrorEventV2.

Cuando el agente server-side re-ejecuta:
1. Verifica la firma del recording (integridad).
2. Si cruisha en el mismo frame → firma `replay_verified: true` con su propia key.
3. El PR de autofix incluye la cadena: `recording@sha256:... → replay_verified@sha256:... → fix_patch@sha256:... → build@sha256:...`.

Auditor puede verificar end-to-end sin confiar en ninguna pieza individual.

---

## 5. Qué NO es Substrate v2

- **NO** es ForensicVM — no captura locals, eso es la otra pieza.
- **NO** es debugger step-by-step — es record + replay automatizado.
- **NO** funciona en Edge runtimes (Vercel Edge, Cloudflare Workers) — requiere Node full. Fallback v1.
- **NO** captura memoria del heap — solo I/O + timing + scheduling.
- **NO** es adecuado para workloads >1000 req/s por instancia (overhead marginal acumulado). Throttle automático + sampling.

---

## 6. Timeline

| Fase | Duración | Entregable |
|---|---|---|
| **Recording layer v0.3** | Mes 1-3 | Extender `substrate-agent` existente con captura de Date/Math/crypto/scheduling. Overhead <5%. |
| **Replay layer v1** | Mes 3-5 | Engine que re-ejecuta recording. Deterministic para workloads simples. |
| **inari-staging integration** | Mes 5-6 | API `/replay/run` + `/replay/verify-fix` + gVisor sandboxing. |
| **Overhead optimization** | Mes 6-8 | Target <3% match Replay.io. Zero-copy serialization. |
| **Mutate-test pipeline** | Mes 8-10 | Auto-validate fix candidates sin push. Integración con auto-merge gates. |
| **Multi-process support** | Mes 10-12 | cluster + worker_threads + child_process. |

---

## 7. Perfil del engineer

**Staff Rust Systems Engineer** — 1 FTE.

**Must have:**
- 5+ años Rust producción.
- Systems-level: syscall interception, libuv/async I/O, low-level timing.
- Experiencia con native addons Node (neon/napi-rs) o similar.
- Haber shippeado al menos 1 producto con performance-critical Rust.

**Nice to have:**
- Ex-Replay.io (ideal — tienen el stack exacto).
- Ex-Cloudflare Workers, ex-TigerBeetle, ex-Oxide, ex-Meta infra.
- Experience con record-and-replay (rr, Hermit, Pernosco).
- Criptografía aplicada (Ed25519, Merkle trees) — para integración EAP v2.

**Compensación:** $280-380k base + 0.3-0.5% equity. Remoto global.

---

## 8. Éxito medido

- **Mes 3**: recording layer captura Date/Math/crypto/scheduling en workload test. Overhead <5%.
- **Mes 6**: replay engine re-ejecuta un bug real (pull de alguno de los 50 top errors ya en DB) → crashea en el mismo frame → fingerprint match.
- **Mes 9**: mutate-test pipeline vivo en CI → auto-valida fix del agente antes del push.
- **Mes 12**: <3% overhead en record, >95% determinism rate en workloads reales.

Cuando se logra el 95% → Capture se convierte en "la única herramienta donde el AI re-ejecuta tu bug antes de proponer el fix, con proof criptográfico".
