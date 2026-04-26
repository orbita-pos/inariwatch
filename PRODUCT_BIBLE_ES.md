# InariWatch — Product Bible

> Actualizado: 12 de abril de 2026
> Fundador & CEO: Jesus Bernal (@JesusBrDev) — Mexico

---

# Capa 1 — La Historia

*Para cualquier audiencia: inversionistas, prensa, audiencias no tecnicas, elevator pitches.*

---

## El Problema

Todo developer conoce la llamada de las 3am. Algo se rompio en produccion. Abres tu laptop, miras un stack trace, buscas en los logs, encuentras el bug, escribes el fix, lo subes, esperas CI, haces merge, deploy, y rezas para que no rompa otra cosa.

Este ciclo — detectar, diagnosticar, arreglar, probar, desplegar, monitorear — toma horas. A veces dias. Y el 70% del tiempo de ingenieria se gasta en mantenimiento, no en construir cosas nuevas.

Las herramientas que tenemos hoy estan fragmentadas. Sentry te dice *algo se rompio*. PagerDuty te dice *despierta*. GitHub te dice *donde esta el codigo*. Pero ninguna arregla nada. Sigues necesitando un humano en el loop, cada vez.

## La Solucion

**InariWatch es monitoreo que se arregla solo.**

Cuando algo se rompe, la IA lee tu codigo, escribe el fix y abre un PR. CI pasa. Tu apruebas. O si confias lo suficiente — se mergea automaticamente.

En una frase: **InariWatch es el sistema inmunologico autonomo para tu codigo.**

## Como Funciona (La Version Simple)

1. **Algo se rompe** — un error de Sentry, un deploy fallido en Vercel, un CI fallido en GitHub, un crash en Expo. InariWatch lo captura.
2. **La IA lo diagnostica** — lee el stack trace, tu codigo y los incidentes pasados. Entiende la causa raiz en segundos.
3. **La IA escribe el fix** — un cambio de codigo minimo y enfocado mas un test de regresion. Dentro de un contenedor sandbox donde puede compilar, construir y correr tests antes de subir.
4. **11 compuertas de seguridad lo verifican** — CI, escaneo de seguridad, auto-revision, tests en staging, replay de I/O. Todo verde? Auto-merge. Un rojo? Draft PR para ti.
5. **10 minutos de monitoreo** — vigila por regresiones. Si el fix rompio algo, auto-revierte al ultimo deploy bueno.

De error a PR mergeado en minutos — no dias.

## La Vision

El software es el unico sistema de ingenieria que no puede sanarse solo. Un corte sana. Un fusible se dispara y se resetea. Pero el software simplemente... se queda roto hasta que un humano interviene.

InariWatch esta construyendo el sistema nervioso que hace al software auto-reparable.

**Hoy:** Cuando algo se rompe, InariWatch lo arregla.
**Manana:** Antes de que algo se rompa, InariWatch lo previene.
**Eventualmente:** El software se mantiene solo — bugs, dependencias, parches de seguridad, ajuste de rendimiento — y los ingenieros construyen cosas nuevas.

La pregunta loca hoy: "Dejarias que una IA suba codigo a produccion?"

La pregunta loca en cinco anos: "Todavia despiertas ingenieros a las 3am?"

## La Historia del Fundador

Soy Jesus Bernal, fundador solo desde Mexico. Construi InariWatch porque estaba cansado de ser el unico developer de guardia, ahogado en alertas, pasando noches arreglando bugs que una IA podria haber manejado. Queria una herramienta que no solo te diga que algo se rompio — que lo arregle por ti.

Cada linea de codigo en InariWatch — la app web, el pipeline de IA, el CLI en Rust, el agente eBPF del kernel, la app movil, la extension de VS Code — la escribi yo. No porque tuviera que hacerlo, sino porque entender todo el stack es como construyes algo que realmente funciona de punta a punta.

Hecho en MX. Monitoreando el mundo.

---

# Capa 2 — El Producto

*Para CTOs, developers y audiencias tecnicas evaluando el producto.*

---

## Que Hace InariWatch

InariWatch es una plataforma de monitoreo impulsada por IA que cierra el loop desde la deteccion hasta la resolucion. Ingiere alertas de tus herramientas existentes, las enriquece con analisis de IA, y — cuando la confianza es suficientemente alta — las arregla de forma autonoma.

### El Ciclo de Vida de una Alerta

```
Alerta llega → IA auto-analiza → Diagnostico guardado
                                        ↓
                       Usuario clickea "Fix" (o modo autonomo se activa)
                                        ↓
                            Recopilacion de contexto
                       (Sentry + Vercel + GitHub + Datadog + Code RAG)
                                        ↓
                            IA explora el codebase
                       (Container Agent → Agentic Loop → Single-shot)
                                        ↓
                            Fix generado + test de regresion
                                        ↓
                            Escaneo de seguridad (3 capas)
                            Auto-revision (IA se califica a si misma)
                                        ↓
                            Push a branch → CI corre
                            (hasta 3 reintentos si CI falla)
                                        ↓
                            11 Compuertas de Seguridad evaluan
                                        ↓
                  ┌─── Todas pasan ──┐      ┌─── Alguna falla ──┐
                  │   Auto-merge     │      │    Draft PR        │
                  │   10-min vigilia │      │    Revision humana │
                  └──────────────────┘      └────────────────────┘
                            ↓
                  Regresion? → Auto-revert + Escalar
                  Limpio? → Resolver + Contribuir a la comunidad
```

### Funcionalidades Principales

**Ingesta de Alertas y Analisis con IA**
Ingiere de Sentry, Vercel, GitHub, Datadog, Expo, y tu propia app via el Capture SDK. Cada alerta recibe analisis automatico con IA al llegar — causa raiz, evaluacion de severidad y accion recomendada. No necesitas API key; nosotros financiamos la IA.

**Pipeline de Remediacion con IA**
El pipeline completo: diagnosticar, leer codigo, generar fix, escaneo de seguridad, auto-revision, push, CI (3x reintento), PR, compuertas de auto-merge, monitoreo post-merge, escalacion si falla. Cuatro estrategias de fix en cascada segun la infraestructura disponible — desde ejecucion completa en contenedor hasta generacion single-shot.

**11 Compuertas de Seguridad**
Antes de cualquier auto-merge, el fix debe pasar:

| # | Compuerta | Que verifica |
|---|-----------|--------------|
| 1 | Auto-merge habilitado | Esta activada la funcion para este proyecto? |
| 2 | CI paso | Todos los checks de GitHub verdes? |
| 3 | Umbral de confianza | Confianza de IA >= minimo (default 70%) |
| 4 | Lineas cambiadas | Bajo el maximo (default 500 lineas) |
| 5 | Auto-revision | IA reviso su propio fix y puntuo >= 70 |
| 6 | Substrate simulate | Score de riesgo de replay I/O <= 40 |
| 7 | Cadena EAP verificada | Recibos de ejecucion criptograficos validos |
| 8 | Prediccion segura | Riesgo de prediccion pre-deploy <= 40 |
| 9 | Escaneo de seguridad | Cero hallazgos de severidad ALTA |
| 10 | Substrate replay | Replay de I/O confirma que el fix previene el crash |
| 11 | E2E staging | Tests en staging pasan |

**Niveles de Confianza**
Los proyectos ganan confianza con el tiempo basado en su historial de fixes con IA:

| Nivel | Requisitos | Que cambia |
|-------|-----------|------------|
| Novato | Proyecto nuevo | Solo draft PRs, sin auto-merge |
| Aprendiz | 3+ fixes, 50%+ exito, 7 dias | Estricto: confianza >= 90, <= 50 lineas |
| Confiable | 5+ fixes, 70%+ exito, 14 dias | Estandar: confianza >= 80, <= 100 lineas |
| Experto | 10+ fixes, 85%+ exito, 30 dias | Relajado: confianza >= 70, <= 200 lineas |

**Motor de Prediccion**
Tres capas de evaluacion de riesgo pre-deploy en cada PR:
1. **Pattern matching** — compara el diff del PR contra 90 dias de alertas historicas
2. **Prediccion con IA** — predice errores especificos (archivo, linea, confianza) antes del deploy
3. **Shadow replay** — ejecuta el codigo del PR contra patrones de I/O de produccion grabados

**Red de Fixes Comunitarios**
Cuando InariWatch arregla un error, el patron se anonimiza y comparte. El proximo equipo con el mismo error recibe un match instantaneo — porque alguien ya lo resolvio.

> "47 equipos arreglaron esto. 96% tasa de exito. Aplica en un click."

Esto es inmunidad de manada para codigo. Cada fix exitoso hace a toda la red mas fuerte.

**Guardias On-Call**
Rotaciones por proyecto, politicas de escalacion multi-nivel, overrides de horario, consciente de zonas horarias. Cuando la IA no puede arreglar algo, escala a la persona correcta con todo el contexto.

**Auto-Heal**
Cuando el monitoreo de uptime detecta que tu sitio esta caido (3 fallos consecutivos), InariWatch auto-revierte al ultimo deploy bueno Y empieza remediacion con IA simultaneamente. Cooldown de 10 minutos previene loops.

**Monitoreo Post-Merge**
Despues del auto-merge, monitoreo canario agresivo de 10 minutos revisa Sentry por nuevos errores, uptime por disponibilidad, y fingerprints de alertas por recurrencia. Si detecta regresion: auto-revert, escalar y actualizar la pagina de status.

**Automatizacion de Status Page**
Alertas criticas auto-crean incidentes publicos. Actualizaciones durante la remediacion. Auto-resuelve cuando el fix se despliega. Sin gestion manual de status page.

### Ecosistema de Integraciones

InariWatch llega a los developers donde ya trabajan:

| Superficie | Que hace |
|------------|---------|
| **Dashboard Web** | Control completo — alertas, terminal de remediacion en vivo, analytics, on-call, settings |
| **Capture SDK** | `npm i @inariwatch/capture` — captura de errores zero deps, zero config para Node.js/TypeScript |
| **Servidor MCP** | 25 herramientas para asistentes de IA (Claude Code, Cursor, Windsurf, Copilot, Codex, Gemini CLI) |
| **Bot de Slack** | 14 slash commands, botones interactivos, [Fix It] en thread, health checks de deploys |
| **Bot de Telegram** | 15 comandos, teclados inline, tagging de on-call para alertas criticas |
| **Extension VS Code** | Diagnosticos inline, hover con IA, sidebar de alertas, contador en status bar |
| **GitHub Action** | Evaluacion de riesgo con IA en cada PR |
| **CLI (Rust)** | `inariwatch dev` captura errores locales, diagnostica, aplica fixes al disco |
| **App Movil** | Push notifications, gestion de alertas (Expo React Native) |
| **App Desktop** | Visor nativo de alertas (Tauri) |
| **InariWatch Agent** | Observabilidad a nivel kernel con eBPF — cero cambios de codigo, cualquier lenguaje |

### Estrategia de IA

**Financiada por la plataforma.** Todas las funciones de IA funcionan out of the box. Nosotros proveemos las API keys (GPT-4o-mini para analisis, GPT-5.4 para remediacion). No se requiere setup del usuario.

**BYOK opcional.** Usuarios avanzados pueden traer su propia key de Claude, OpenAI, Groq, Grok, DeepSeek o Gemini para usar modelos especificos.

**MCP es sampling-first.** Cuando asistentes de IA llaman a InariWatch via MCP, el analisis sucede en el LLM del cliente (Claude, GPT, etc.) — no en el nuestro. Nosotros damos el contexto; ellos piensan. Cero costo de IA server-side para herramientas de analisis.

### Que Hace Diferente a InariWatch

| | Sentry | PagerDuty | InariWatch |
|---|--------|-----------|------------|
| Detecta errores | Si | Via integraciones | Si |
| Notifica humanos | Si | Si | Si |
| Diagnostica causa raiz | No | No | Si (IA) |
| Escribe el fix | No | No | Si (IA) |
| Verifica el fix | No | No | Si (contenedor, CI, 11 compuertas) |
| Auto-mergea con seguridad | No | No | Si (con niveles de confianza) |
| Monitorea post-merge | No | No | Si (canario de 10 min) |
| Auto-revierte si falla | No | No | Si |
| Aprende de fixes pasados | No | No | Si (red comunitaria) |
| Predice antes del deploy | No | No | Si (prediccion de 3 capas) |

**La brecha:** Sentry se detiene en la deteccion. PagerDuty se detiene en la notificacion. InariWatch cierra el loop completo.

---

# Capa 3 — Bajo el Capo

*Para deep dives tecnicos, conferencias de ingenieria y referencia propia del fundador.*

---

## Vision General de Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│                        VERCEL (Produccion)                       │
│                                                                   │
│  Next.js 15 (App Router)                                         │
│  ├── 66+ rutas API (webhooks, cron, auth, MCP, mobile, etc.)    │
│  ├── Capa de IA (14+ modulos en lib/ai/)                         │
│  ├── Capa de Servicios (lib/services/ — SSOT para toda logica)   │
│  ├── 8 Pollers (Sentry, Vercel, GitHub, Expo, npm, PG, uptime)  │
│  └── Drizzle ORM → Neon PostgreSQL                               │
│                                                                   │
│  Redis: Upstash (rate limiting, cache de IA, dedup, salud)       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐
│ Neon Postgres │  │   Upstash    │  │  Hetzner CX22            │
│               │  │   Redis      │  │  (2 vCPU, 4GB RAM)       │
│ pgvector      │  │              │  │                          │
│ (1024D HNSW)  │  │ Rate limits  │  │  ├── Servidor Go staging │
│               │  │ Cache de IA  │  │  │   (puerto 9400)       │
│ BM25 full-text│  │ Dedup alertas│  │  ├── Worker IA Node.js   │
│               │  │ Salud serv.  │  │  │   (puerto 9401)       │
│               │  │ Cache Slack  │  │  ├── Redis (Docker)      │
└──────────────┘  └──────────────┘  │  ├── Caddy (TLS)         │
                                     │  └── InariWatch Agent     │
                                     │      (eBPF)              │
                                     └──────────────────────────┘
```

## Stack Tecnologico

| Capa | Tecnologia | Por que |
|------|-----------|---------|
| Framework | Next.js 15 (App Router) | Full-stack React, serverless en Vercel |
| Lenguaje | TypeScript | Seguridad de tipos en todo el stack web |
| Base de datos | Neon PostgreSQL + Drizzle ORM | Postgres serverless, queries type-safe |
| Auth | NextAuth (credenciales + Google) | Estandar, extensible |
| IA | 6 proveedores (Claude, OpenAI, Groq, Grok, DeepSeek, Gemini) | Sin vendor lock-in |
| Deploy | Vercel | Zero-config, edge functions, rollbacks instantaneos |
| Email | Resend (SMTP via Nodemailer) | API de email developer-friendly |
| Push | Web Push API + Expo Push | Notificaciones browser + mobile nativas |
| Mensajeria | Bot OAuth Slack + Telegram Bot API | Donde los equipos ya se comunican |
| Cache | Upstash Redis (Vercel) + Redis propio (Hetzner) | Rate limiting ~1ms, cache de respuestas IA |
| Busqueda | pgvector (1024D HNSW) + BM25 full-text | Busqueda hibrida semantica + por palabras clave |
| CLI | Rust | Rapido, binario estatico unico, multiplataforma |
| Desktop | Tauri | Rendimiento nativo, bundle pequeno |
| Movil | Expo React Native | Multiplataforma con push notifications |
| Agente | C (eBPF kernel) + Rust (userspace) | Observabilidad a nivel kernel, zero overhead |

## Deep Dive del Pipeline de IA

### Cuatro Estrategias de Fix (Fallback en Cascada)

```
Intento 1:
  ├── Container Agent (modo Worker) ←── preferido: 40 turnos, ~1ms tools, Docker en Hetzner
  ├── Container Agent (modo Vercel) ←── fallback: 15 turnos, round-trips HTTP
  ├── Agentic Loop                  ←── Haiku explora (12 turnos) → Sonnet arregla (3 turnos)
  └── Single-shot                   ←── un prompt, contexto completo

Reintentos (hasta 3x):
  └── Single-shot con anti-patrones de intentos fallidos
```

**Container Agent** es la joya de la corona. Clona el repo en Docker en Hetzner, le da a la IA 6 herramientas (read, write, grep, exec, list, submit_fix), y la deja compilar, construir y testear antes de subir. La IA se autocorrige: si `tsc` falla, lee el error y re-arregla.

**Seguridad:** Whitelist de comandos, bloqueo de subshells/backticks/punto y coma, proteccion contra path traversal, validacion de symlinks, limites de disco tmpfs, limites de tamano de input.

### Optimizacion de Costos

| Tecnica | Ahorro |
|---------|--------|
| Prompt caching (`cache_control: { type: "ephemeral" }`) | ~$0.25-0.30/remediacion |
| Ruteo de modelos (Haiku para auto-revision + seguridad, Sonnet para fixes) | ~40% por fix |
| MCP sampling-first (LLM del cliente analiza, no el nuestro) | 100% en herramientas de analisis |
| Cache de IA en Redis (mismo fingerprint = respuesta cacheada, 1h TTL) | Elimina llamadas IA duplicadas |
| **Costo estimado por remediacion:** | **~$0.25** (antes ~$0.56) |

### Escaneo de Seguridad (3 Capas)

| Capa | Motor | Cobertura |
|------|-------|-----------|
| 1 | ESLint + eslint-plugin-security | 17 reglas: eval inseguro, child_process, CSRF, timing attacks, chars bidi |
| 2 | 19 patrones regex inspirados en Semgrep | SQL injection, XSS, command injection, prototype pollution, secretos hardcodeados, SSRF, crypto inseguro, CORS wildcard |
| 3 | Revision de seguridad con IA (Claude) | 10 categorias de vulnerabilidad, analisis context-aware |

Las 3 capas se fusionan con dedup. Corre completamente in-memory en Vercel serverless — sin CLI externo.

## InariWatch Agent (eBPF)

El agente provee observabilidad a nivel kernel con cero cambios de codigo. Instala con un comando:

```bash
curl -sf https://install.inariwatch.com | sh
```

**Arquitectura:**
- **Lado kernel (C):** ~10 programas BPF, 50-120 lineas cada uno. Adjuntos a tracepoints, kprobes y uprobes.
- **Espacio usuario (Rust):** Consumidor de ring buffer, procesamiento de eventos, compresion por lotes, transporte HTTPS.

**7 Sondas Activas:**

| Sonda | Tipo de Hook | Que captura |
|-------|-------------|-------------|
| Procesos | tracepoint/sched | Ejecucion, salida, fork de procesos |
| Red | tracepoint/sock + kprobe | Cambios de estado TCP, retransmisiones, envio/recepcion |
| Sistema de archivos | kprobe/vfs | Apertura, escritura, eliminacion de archivos |
| DNS | kprobe/udp_sendmsg | Consultas DNS (captura raw, parsing en Rust) |
| Syscall | raw_tracepoint | Despacho de llamadas al sistema |
| TLS | uprobe en SSL_read/write | Intercepcion de trafico cifrado |
| Seguridad | LSM hooks | Aplicacion de politicas de seguridad |

**Decisiones de diseno:**
- Parsing de DNS en Rust, no en kernel (el verificador BPF rechaza loops complejos — mismo patron que Datadog, Coroot)
- TLS: escanea `/proc/PID/maps` cada 30s buscando libssl.so, adjunta uprobes dinamicamente
- CO-RE: binario estatico unico para todos los kernels 5.8+ (sin clang/headers en el objetivo)
- Rendimiento: 248 eventos/seg, ~88% compresion LZ4, <1% CPU

**Deteccion de amenazas (lado cloud):** SQL injection, XSS, SSRF, command injection, reverse shells, web shells, escape de contenedores, acceso a archivos sensibles, DNS malicioso.

## EAP (Execution Attestation Protocol)

Cadena de prueba criptografica para verificacion de fixes de IA. 6 crates de Rust en `orbita-pos/eap`.

- **Arboles Merkle** — verificacion content-addressed de pasos del fix
- **Firmas Ed25519** — no-repudio de decisiones de IA
- **Caso de uso:** Probar que un modelo de IA especifico genero un fix especifico, revisado por un escaneo de seguridad especifico, pasando checks de CI especificos. Audit trail para industrias reguladas.

## Substrate (Grabacion de I/O)

Grabacion y replay deterministico de I/O. 10 crates de Rust en `orbita-pos/substrate`.

- Graba peticiones HTTP, consultas a base de datos, lecturas de archivos, llamadas a APIs externas
- Diseno de ring buffer — captura las ultimas N operaciones, auto-flush en error
- **Modos de replay:** Analisis con IA (rapido, serverless) + GitHub Action (verificacion de I/O real)
- **Caso de uso:** Cuando un error ocurre, obtienes la secuencia exacta de I/O que lo causo. Cuando se propone un fix, replays esa secuencia para verificar que el fix realmente previene el crash.

## Numeros de Infraestructura

| Metrica | Numero |
|---------|--------|
| Rutas API | 66+ |
| Herramientas MCP | 25 |
| Comandos Slack | 14 |
| Comandos Telegram | 15 |
| Compuertas de seguridad | 11 |
| Modulos de IA | 14+ |
| Pollers | 8 |
| Tests de caos (Vitest) | 103 |
| Escenarios de stress test k6 | 14 (10 carga + 4 caos) |
| Reglas de escaneo de seguridad | 36+ (17 ESLint + 19 regex + IA) |
| Sondas eBPF | 7 |
| Cron jobs | 5 |

## Ingenieria del Caos y Stress Testing

**Tests de caos (103 tests, 3 niveles):**
- L1 Unitario: Timeout/retry de IA, fallos de notificacion, carreras de dedup, memory leaks de SSE
- L2 Integracion: Tormentas de alertas, escalacion sin on-call, cascadas de auto-heal, remediacion bajo fallo de API de GitHub
- L3 Seguridad: 46 vectores de bypass SSRF, spoofing de X-Forwarded-For, edge cases de firmas de webhooks, 14 payloads XSS en Slack/Telegram/JSX

**Stress tests k6 (14 escenarios):**
- Tormenta de webhooks, rate limits de MCP, 50 conexiones SSE concurrentes, dedup de alertas, fuerza bruta de auth, fan-out de cron, saturacion de DB, serializacion de push, auto-heal, ciclo completo de incidente, variantes de caos con payloads validos/malformados mezclados

## Arquitectura de Servicios

Toda la logica de negocio vive en `lib/services/`. Cada superficie (MCP, Slack, Telegram, dashboard, extension, cron, movil, desktop) llama a estos servicios en lugar de reimplementar queries.

```
  MCP ─────┐
  Slack ────┤
  Telegram ─┤
  Dashboard ┼──→ Capa de Servicios (lib/services/) ──→ Drizzle ORM ──→ Neon PostgreSQL
  VS Code ──┤                                       └──→ Redis (cache)
  Movil ────┤
  CLI ──────┘
```

**Servicios clave:**
- `alerts.service.ts` — consultar, obtener, silenciar, reconocer, reabrir, estadisticas, tendencias
- `diagnosis.service.ts` — diagnostico con IA con SSOT de prompts
- `vercel.service.ts` — deploys, rollback, build logs
- `chat.service.ts` — recopilacion de contexto de Ask Inari
- `code-intelligence.service.ts` — busqueda hibrida, reindexacion, grafo de llamadas
- `url-validation.ts` — proteccion SSRF

---

# Capa 4 — El Roadmap

*Direccion estrategica y hacia donde va el producto.*

---

## El Flywheel

InariWatch tiene un flywheel de datos que se fortalece con cada usuario:

```
Mas usuarios → Mas fixes → Mas patrones comunitarios → Mejores predicciones
     ↑                                                           │
     └──────── Fixes mas rapidos atraen mas usuarios ←───────────┘
```

**Hitos por escala:**
- **50+ usuarios:** Enviar telemetria anonimizada de patrones de reparacion
- **500+ usuarios:** Modelo predictivo ("este patron de PR causa incidentes en 12% de deploys similares")
- **1,000+ usuarios:** La comunidad maneja bugs comunes de frameworks autonomamente
- **5,000+ usuarios:** Open-source el formato de patrones — ser el protocolo, no solo el producto
- **100,000+ usuarios:** Predecir fallas antes de que sucedan
- **1,000,000+ usuarios:** "Tu deploy del lunes tiene 23% de probabilidad de causar un spike de latencia"

## Tres Direcciones Estrategicas

### Direccion A — Inari Cortex (Sistema Inmunologico del Software)

El loop de reparacion hoy es el sistema inmunologico *innato* — defensa generica. El siguiente paso es inmunidad *adaptativa*:
- **Celulas de memoria:** Patrones de fix almacenados, recordados instantaneamente en recurrencia
- **Generacion de anticuerpos:** Parches pre-preparados para CVEs conocidos antes de que lleguen a tu codigo
- **Tolerancia inmunologica:** Aprender de tests/docs que es intencional vs. que es un bug

### Direccion B — Inari Network (Grafo Global de Resiliencia)

Esta es la apuesta real. El diferenciador no es la IA — son los datos.
- Cada fix exitoso alimenta la red comunitaria
- Cada fallo ensena al modelo predictivo
- Quien acumule el mayor corpus de patrones de reparacion del mundo real primero, gana

### Direccion C — Inari OS (El Fin del Mantenimiento de Software)

Expandir de bugs a todo lo que mantiene despiertos a los ingenieros:
1. Bugs (hoy)
2. Actualizacion de dependencias + parches de seguridad
3. Auto-ajuste de rendimiento desde telemetria de produccion
4. Migraciones de schema, correccion de drift de infraestructura
5. Evolucion de features desde comportamiento del usuario

---

# Referencia Rapida — El Pitch

*Usa estos para diferentes audiencias y restricciones de tiempo.*

---

**Pitch de 5 segundos:**
> Monitoreo que se arregla solo.

**Pitch de 30 segundos:**
> InariWatch monitorea tu app, y cuando algo se rompe, la IA lee tu codigo, escribe el fix y abre un PR. 11 compuertas de seguridad lo verifican. Si todas pasan, auto-merge. Si el fix causa una regresion, auto-revierte. De error a PR mergeado en minutos.

**Pitch de 2 minutos:**
> Todo developer conoce la llamada de las 3am. Sentry te dice que algo se rompio. PagerDuty te despierta. Pero tu todavia tienes que diagnosticar la causa raiz, escribir el fix, testearlo y desplegarlo tu mismo.
>
> InariWatch cierra ese loop. Ingiere alertas de Sentry, Vercel, GitHub, Datadog — cualquier fuente. La IA auto-analiza cada alerta al llegar. Cuando clickeas "Fix" — o en modo autonomo, automaticamente — lee tu codebase dentro de un contenedor sandbox, escribe un fix minimo mas un test de regresion, lo pasa por 11 compuertas de seguridad incluyendo CI, escaneo de seguridad y replay de I/O, y abre un PR. Si todo pasa, auto-merge. Luego monitorea por 10 minutos. Si el fix causa una regresion, auto-revierte y escala.
>
> Pero lo que lo hace diferente: cada fix exitoso se anonimiza y comparte en la red. El proximo equipo con el mismo error recibe un match instantaneo. Y nuestro motor de prediccion atrapa bugs antes de que lleguen a produccion — analizando diffs de PR contra patrones historicos y replayando I/O grabado.
>
> Somos platform-funded — todas las funciones de IA funcionan out of the box, sin API keys. El producto esta en vivo, en beta, y es gratis. Tenemos un Capture SDK, bots de Slack y Telegram, una extension de VS Code, un servidor MCP con 25 herramientas para asistentes de IA, un CLI en Rust, apps movil y desktop, y un agente eBPF a nivel kernel que monitorea cualquier lenguaje con cero cambios de codigo.
>
> Construido por un fundador solo en Mexico. Cada linea de codigo. La vision es simple: hacer el software auto-reparable para que los ingenieros construyan en vez de apagar incendios.

---

*Este documento es una referencia viva. Actualizalo conforme el producto evolucione.*
