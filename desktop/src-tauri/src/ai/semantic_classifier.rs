//! Layer 1 — nearest-centroid semantic intent classifier.
//!
//! On first call `classify()` triggers a one-time centroid bootstrap:
//!   1. Try loading `<app_data>/inari-live/intent-centroids.json` (fast path).
//!      If the cache has a different number of intents than EXAMPLES (e.g. after
//!      an update), the cache is discarded and recomputed automatically.
//!   2. If absent or stale: embed the built-in example phrases via fastembed's
//!      `embed_batch`, average per intent, L2-normalize → cache to disk.
//!
//! Both paths are synchronous + blocking; callers must use `spawn_blocking`.
//! The `OnceLock` guarantees the bootstrap runs exactly once per process.
//!
//! After bootstrap, classify() costs ~3-8ms (one `embed_one` call).
//! Bootstrap on a warm model: ~100-300ms. On first-ever launch (model
//! download): up to 1-3s.
//!
//! Taxonomy designed by Opus 4.7 extended thinking — 22 intents, ~1,400 phrases.
//! 7 existing intents (enhanced) + 15 new intents (escape-valve: routed to L2/LLM
//! until resolvers are wired). Adversarial phrase set of 100 validated null-routes.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::indexer::embeddings::{embed_batch, embed_one, EMBEDDING_DIM};

// ── Wire types ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SemanticMatch {
    pub intent:     String,
    pub confidence: f32,
}

// ── Disk cache format (read + write) ───────────────────────────────────

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    intent:    String,
    threshold: f32,
    vector:    Vec<f32>,
}

// ── Example phrases used to compute centroids ──────────────────────────
//
// Format: (intent_name, cosine_similarity_threshold, &[phrases])
// Thresholds calibrated by Opus 4.7 for MiniLM-L6-v2 cosine similarity.
// Destructive-action intents (trigger_fix, silence_alert, rollback_deploy, etc.)
// use higher thresholds (0.46-0.47) to fail-closed.

static EXAMPLES: &[(&str, f32, &[&str])] = &[
    // ── Existing intents (enhanced) ────────────────────────────────────

    ("list_alerts", 0.42, &[
        "show me my alerts", "show alerts", "list alerts", "list all alerts",
        "alerts please", "alerts?", "any new alerts", "any new errors",
        "any new issues", "any active alerts", "any open issues",
        "are there any alerts", "are there any problems", "are there any errors today",
        "what's wrong", "whats wrong", "what's broken", "whats broken",
        "what is failing", "show me what's failing", "what issues are open",
        "what alerts came in", "any criticals", "show me criticals",
        "show critical alerts", "show me only critical alerts", "show warnings",
        "list warnings", "recent alerts", "alerts from today", "alerts from last hour",
        "alerts last 24h", "alerts overnight", "alerts since this morning",
        "last 5 alerts", "last 10 errors", "top 20 alerts",
        "give me the alert list", "pull up the alerts", "open alerts",
        "alertas", "alertas por favor", "lista de alertas", "dame las alertas",
        "dame mis alertas", "muéstrame las alertas", "muestrame las alertas",
        "mostrar alertas", "ver alertas", "qué alertas tengo", "que alertas hay",
        "cuántas alertas tengo", "cuantas alertas tengo",
        "cuántos errores hay", "cuantos errores hay",
        "alertas críticas", "alertas criticas", "dame las alertas críticas",
        "solo las críticas", "alertas activas", "alertas recientes",
        "últimas alertas", "ultimas alertas", "últimas 5 alertas",
        "ultimas 10 alertas", "últimos errores", "ultimos errores",
        "qué pasó", "que paso", "qué pasó esta noche", "qué pasó ayer",
        "qué reventó", "que reventó", "qué rompió", "qué se rompió",
        "muéstrame los fallos", "muestrame los fallos", "muéstrame las fallas",
        "alertas hoy", "errores recientes", "incidencias abiertas",
        "issues abiertos", "errores activos", "alerts de hoy", "alerts criticas",
        "que errors hay", "show errores", "any errores",
        "alertas de sentry", "errores de sentry", "alertas de vercel",
        "fallos de vercel", "alertas de github", "datadog alerts", "expo alerts",
        "capture alerts", "errores de capture", "uptime alerts", "anomaly alerts",
        "npm audit alerts", "cve alerts", "security alerts",
        "alertas no leídas", "unread alerts", "incidents", "incident list",
    ]),

    ("status_summary", 0.44, &[
        "cómo está el sistema", "como esta el sistema", "cómo va todo",
        "como va todo", "cómo va la cosa", "cómo anda todo", "como anda todo",
        "qué tal está todo", "que tal esta todo", "qué tal va",
        "qué tal va el sistema", "todo bien", "todo ok", "todo en orden",
        "todo verde", "está todo bien", "esta todo bien", "estamos bien",
        "todo funcionando", "todo operativo", "sistema operacional",
        "sistema en verde", "sistema degradado", "estamos degradados",
        "salud del sistema", "estado del sistema", "estado general",
        "resumen general", "resumen del sistema", "panorama general",
        "vista general", "overview", "system status", "system health",
        "service health", "service status", "system overview", "overall health",
        "overall system health", "platform health", "everything ok",
        "everything okay", "everything good", "everything green",
        "everything working", "everything fine", "are we good", "are we ok",
        "are we healthy", "are we green", "are we operational",
        "is the system healthy", "is the system up", "is everything up",
        "is everything fine", "is everything running", "how is the app doing",
        "how's the app", "how's prod", "how's production",
        "cómo está prod", "cómo está producción", "cómo va prod",
        "prod status", "production status", "production health",
        "health check overall", "give me a status report", "give me a summary",
        "give me an overview", "dame un resumen", "dame el resumen",
        "summary please", "status please", "tldr status", "general status",
        "todo good", "all good?", "everything alright",
    ]),

    ("uptime_monitors", 0.43, &[
        "uptime", "uptime status", "uptime check", "uptime monitors",
        "check uptime", "uptime de los monitores", "monitores de uptime",
        "monitors status", "status de monitores", "estado de monitores",
        "estado de los monitores", "anything down", "is anything down",
        "is anything offline", "any monitors down", "are any monitors down",
        "are any endpoints down", "which endpoints are down",
        "which endpoints are failing", "which sites are down",
        "endpoints caídos", "endpoints offline", "monitores caídos",
        "monitores caidos", "monitores offline", "están los monitores caídos",
        "estan los monitores caidos", "hay algo caído", "hay algo caido",
        "algo caído", "algo offline", "qué está caído", "que esta caido",
        "qué endpoint está roto", "is the site up", "is the site down",
        "is prod up", "is prod down", "is the api up", "is the api responding",
        "está caído el sitio", "está caída la api", "está caída la página",
        "está la app caída", "ping check", "ping status",
        "ping a los monitores", "ping the monitors", "ping prod",
        "response time", "response times", "tiempo de respuesta",
        "tiempos de respuesta", "latencia", "latencia de la api",
        "latency", "latency check", "p95 latency", "p99 latency",
        "availability", "availability check", "check availability",
        "disponibilidad", "disponibilidad del sitio",
        "cuántos monitores hay", "cuantos monitores hay",
        "how many monitors", "how many monitors are down",
        "consecutive failures", "fallos consecutivos", "monitor failures",
        "http checks", "site reachable", "is the endpoint reachable",
        "está respondiendo el endpoint", "está respondiendo la api",
    ]),

    ("recent_deploys", 0.42, &[
        "deploys", "deployments", "recent deploys", "recent deployments",
        "last deploys", "last deployments", "latest deploys", "latest deployments",
        "show recent deployments", "show latest deploys",
        "show me recent releases", "show recent builds",
        "last 5 deploys", "last 10 deployments",
        "últimos deploys", "ultimos deploys", "últimos despliegues",
        "últimas subidas", "ultimas subidas", "últimos releases",
        "ultimos releases", "últimos lanzamientos",
        "qué se deployó", "que se deployo", "qué se desplegó",
        "que se desplego", "qué se subió", "que se subio",
        "qué se subió ayer", "qué se publicó", "qué salió", "qué se lanzó",
        "qué deployaron", "qué desplegaron", "qué se mergeó", "qué se mergeo",
        "qué se pusheó", "qué pushearon",
        "what's been deployed", "what has been deployed", "what was deployed",
        "what was deployed today", "what got deployed", "what was released",
        "what got released", "what was merged", "what got merged",
        "what was pushed", "what got pushed", "what's been pushed",
        "what's been merged", "what's been shipped", "what shipped",
        "recent builds", "recent releases", "recent merges", "recent pushes",
        "vercel deploys", "vercel deployments", "deploys de vercel",
        "production deploys", "preview deploys", "deploys a producción",
        "deploys a preview", "failed deploys", "failed deployments",
        "deploys fallidos", "builds que fallaron", "deploy history",
        "deploy log", "historial de deploys", "last release", "latest release",
        "latest changes", "recent changes", "cambios recientes",
        "qué cambió", "qué cambios hubo",
    ]),

    ("oncall_status", 0.44, &[
        "on call", "on-call", "oncall", "on call now", "on call right now",
        "on call ahora", "on call hoy", "on call today", "on call this week",
        "on-call schedule", "oncall schedule", "on call status",
        "on-call rotation", "oncall rotation", "rotation", "rotación",
        "rotacion", "horario de guardia", "horario on call",
        "schedule de guardia", "schedule on-call",
        "who is on call", "who's on call", "whos on call",
        "who is on call right now", "who is on call today",
        "who's on duty", "who is on duty",
        "who is the on-call engineer", "who is the engineer on call",
        "who is responsible right now", "who is responsible now",
        "who is responsible", "who should I contact", "who do I contact",
        "who do I call", "who do I ping", "who do I escalate to",
        "quién está de guardia", "quien esta de guardia",
        "quién está en turno", "quien esta en turno",
        "quién tiene la guardia", "quién tiene el turno",
        "quién está oncall", "quien esta oncall", "quién está on call",
        "a quién contacto", "a quien contacto", "a quién le toca",
        "a quien le toca", "a quién escalo", "a quién aviso",
        "a quién llamo", "a quién pingueo", "responsable de guardia",
        "ingeniero de guardia", "engineer on call",
        "primary on call", "secondary on call", "backup on call",
        "primario de guardia", "secundario de guardia",
        "shift", "turno", "turno de guardia", "guardia", "guardia ahora",
        "guardia hoy", "duty roster", "escalation policy",
        "política de escalación", "quién está disponible",
        "quien esta disponible",
    ]),

    ("help", 0.40, &[
        "help", "ayuda", "ayúdame", "ayudame", "necesito ayuda",
        "help please", "ayuda por favor", "halp", "hlp", "?", "??",
        "instrucciones", "instructions", "manual", "guía", "guia",
        "guide", "tutorial", "comandos", "commands", "command list",
        "lista de comandos", "qué comandos hay",
        "what commands do you support", "what commands are available",
        "what slash commands", "qué puedes hacer", "que puedes hacer",
        "qué sabes hacer", "que sabes hacer", "qué haces", "que haces",
        "qué eres", "que eres", "para qué sirves", "para que sirves",
        "what can you do", "what can you help with",
        "what are you able to do", "what are your capabilities",
        "what features do you have", "what can you tell me",
        "show me what you can do", "show me capabilities",
        "list your capabilities", "list your features",
        "cómo te uso", "como te uso", "cómo puedo usarte",
        "cómo funciona", "como funciona", "cómo funciona esto",
        "cómo funciona el bot", "how do I use this", "how do I use you",
        "how to use", "how to use this", "how does this work",
        "how does inari work", "what is inari", "qué es inari",
        "que es inari", "qué es inariwatch", "explain yourself",
        "explícate", "explicate", "preséntate", "presentate",
        "introduction", "intro", "getting started", "starting guide",
        "options", "opciones",
    ]),

    // ── New intents — escape valves (no resolver yet, routed to L2/LLM) ─

    ("error_trends", 0.44, &[
        "error trends", "alert trends", "trends", "tendencias",
        "tendencias de errores", "tendencias de alertas",
        "show me error trends", "show error trends", "show trends",
        "graph errors", "chart errors", "alert chart", "error chart",
        "alert frequency", "alert volume", "error volume",
        "error rate", "error rate over time", "alerts over time",
        "errors over time", "errores en el tiempo", "errores por día",
        "alertas por día", "alerts per day", "errors per day",
        "errors this week", "errors last week", "alerts this week",
        "alerts last 7 days", "alertas esta semana",
        "alertas última semana", "errores esta semana",
        "errores ultima semana", "are errors increasing",
        "are alerts increasing", "are we seeing more errors",
        "we are getting more errors", "estamos viendo más errores",
        "estamos teniendo más alertas", "están subiendo los errores",
        "subieron los errores", "is there an error spike", "error spike",
        "spike in errors", "pico de errores", "pico en las alertas",
        "is there a regression", "regression in errors",
        "trending errors", "top errors", "top alerts this week",
        "errores más frecuentes", "alertas más frecuentes",
        "most common errors", "most frequent alerts",
        "errors by severity over time", "alerts breakdown",
        "alert breakdown by severity", "alert breakdown by source",
        "errors by integration", "errors by service",
        "compare this week vs last", "week over week errors",
        "delta semanal", "delta de alertas", "weekly alert summary",
        "weekly error report", "resumen semanal",
        "reporte semanal de errores",
    ]),

    ("root_cause", 0.46, &[
        "root cause", "root cause analysis", "rca",
        "causa raíz", "causa raiz", "análisis de causa raíz",
        "analisis de causa raiz", "what's the root cause",
        "what is the root cause", "find the root cause",
        "give me the root cause", "dame la causa raíz",
        "encuentra la causa raíz", "cuál es la causa", "cual es la causa",
        "cuál es la causa raíz", "diagnose this alert", "diagnose this error",
        "diagnose the alert", "diagnose this", "diagnostica esto",
        "diagnostica esta alerta", "diagnose latest",
        "diagnose latest alert", "diagnose the latest",
        "run diagnosis", "run a diagnosis", "haz un diagnóstico",
        "hacer diagnóstico", "ai diagnosis", "ai diagnose this",
        "analyze this alert", "analyze the alert", "analiza la alerta",
        "analiza este error", "what caused this alert",
        "what caused this error", "what caused the failure",
        "qué causó la alerta", "qué causó el error",
        "que causo este error", "porqué falló esto",
        "por qué falló esto", "porqué se rompió",
        "explica esta alerta", "explain this alert", "explain this error",
        "explain the latest alert", "give me the diagnosis",
        "dame el diagnóstico", "dame el análisis", "give me the analysis",
        "ai analysis", "ai reasoning", "show me the reasoning",
        "show ai reasoning", "muestra el razonamiento",
        "stack trace analysis", "análisis del stack trace",
        "substrate context", "contexto substrate", "session context",
        "session replay context", "correlate this alert", "correlations",
        "alertas relacionadas", "related alerts", "what's related",
        "what alerts are related",
    ]),

    ("trigger_fix", 0.46, &[
        "fix it", "fix this", "fix this alert", "fix this error",
        "fix latest", "fix the latest", "fix the latest alert",
        "fix the latest error", "fix this for me",
        "auto fix", "auto-fix", "autofix", "auto fix this",
        "remediate", "remediate this", "remediate the alert",
        "remediate latest", "start remediation", "kick off remediation",
        "trigger remediation", "trigger fix", "trigger a fix",
        "run remediation", "run a fix", "run the fix",
        "apply a fix", "apply the fix", "ship a fix", "ship the fix",
        "open a fix PR", "open a PR with the fix", "raise a PR fix",
        "create a fix PR", "arregla esto", "arréglalo", "arreglalo",
        "arregla la alerta", "arregla el error", "arregla lo último",
        "arregla lo ultimo", "soluciona esto", "soluciona la alerta",
        "soluciona el error", "soluciónalo", "solucionalo",
        "repara esto", "repáralo", "haz un fix", "hazme un fix",
        "haz el fix", "lanza el fix", "lanza una remediación",
        "dispara remediación", "dispara el fix", "haz remediation",
        "abre un PR de fix", "crea un PR con el fix",
        "deja que la AI lo arregle", "que la AI lo arregle",
        "que inari lo arregle", "let inari fix it", "let the ai fix it",
        "have the ai fix it", "let ai handle this",
        "ai fix", "ai fix this", "ai remediate",
    ]),

    ("build_logs", 0.44, &[
        "build logs", "build log", "build output", "show build logs",
        "show me the build logs", "show me build output",
        "get build logs", "fetch build logs", "pull build logs",
        "build log please", "logs del build", "logs de build",
        "logs del deploy", "logs de deploy", "logs del despliegue",
        "muéstrame los logs", "muestrame los logs", "dame los logs",
        "ver los logs", "ver logs", "qué dice el build",
        "que dice el build", "qué dijo el build",
        "qué pasó en el build", "qué falló en el build",
        "por qué falló el build", "porqué falló el build",
        "why did the build fail", "why is the build failing",
        "why did it fail to build", "what did the build say",
        "what's in the logs", "what's in the build logs",
        "what's in the deploy log", "deploy log", "deploy logs",
        "deployment logs", "deployment log", "vercel build logs",
        "vercel deploy logs", "vercel logs", "logs de vercel",
        "ci logs", "ci log", "github actions logs",
        "logs de github actions", "logs del workflow", "workflow logs",
        "pipeline logs", "logs del pipeline", "build errors",
        "errores del build", "build error output",
        "stderr del build", "stdout del build", "failed build logs",
        "failed deploy logs", "logs del último build",
        "logs del ultimo deploy", "last build logs", "latest build logs",
        "latest deploy logs", "tail of the build", "tail logs",
        "logs cola",
    ]),

    ("ack_alert", 0.46, &[
        "ack", "ack it", "ack this", "ack this alert", "ack latest",
        "ack the latest alert", "acknowledge", "acknowledge it",
        "acknowledge this", "acknowledge this alert",
        "acknowledge the latest alert", "acknowledge latest",
        "acknowledge the alert", "mark as acknowledged",
        "mark this acknowledged", "mark alert acknowledged",
        "acknowledge alert", "acknowledged", "ack'd",
        "i am on it", "i'm on it", "i'm handling this",
        "i'm working on it", "i got it", "i've got this",
        "looking into it", "investigating", "voy a investigarlo",
        "lo estoy viendo", "lo estoy revisando", "ya lo estoy viendo",
        "lo tomo yo", "yo me encargo", "yo lo veo", "estoy en eso",
        "reconocer alerta", "reconozco la alerta", "reconocer esto",
        "ack la alerta", "ack alerta", "marca como reconocida",
        "marca la alerta como acknowledged", "acuso recibo",
        "acuso de recibo", "stop paging me", "stop the page",
        "stop escalating", "detén la escalación", "para la escalación",
        "stop escalation", "pause escalation", "pausa la escalación",
        "i see it stop alerting", "ack and assign to me",
        "take this assign to me", "asignamela", "asígnamela",
        "asignar a mí", "ack alert latest", "ack last alert",
    ]),

    ("silence_alert", 0.46, &[
        "silence", "silence it", "silence this", "silence this alert",
        "silence latest", "silence the alert", "silence the latest alert",
        "silence this for 24h", "silence for an hour", "silence for the day",
        "silence for 6 hours", "silence for a week",
        "mute", "mute it", "mute this", "mute this alert", "mute latest",
        "mute the alert", "mute for 24 hours", "mute for the day",
        "silenciar", "silencia esto", "silencia la alerta",
        "silencia lo último", "silencia esta alerta", "silenciar alerta",
        "silenciar por 24h", "silenciar por una hora",
        "silenciar todo el día", "mutea esto", "mutea la alerta",
        "muteala", "muteala por 1 hora", "muteala por 24h",
        "snooze", "snooze this", "snooze it", "snooze the alert",
        "snooze 1h", "snooze 24h", "snooze for 24 hours",
        "snooze for an hour", "snooze the alert for the night",
        "posponer alerta", "pospón esto", "posponer 24h",
        "pospón por 24h", "shut this up", "shut up the alert",
        "stop firing", "stop alerting on this", "stop these pages",
        "stop emailing me about this", "para de avisar de esto",
        "deja de avisar", "para de molestar con esto",
        "ignora esta alerta por hoy", "ignore this alert today",
        "suppress this alert", "suppress this", "suppress for 24h",
        "suprime esta alerta", "supresión 24h",
        "no me avises de esto hoy", "dont alert me about this",
        "no quiero saber de esto hoy",
    ]),

    ("rollback_deploy", 0.46, &[
        "rollback", "roll back", "rollback now", "roll it back",
        "roll back now", "roll back the deploy", "rollback the deploy",
        "rollback the deployment", "rollback prod", "rollback production",
        "rollback to last good", "rollback to previous",
        "rollback to last working", "rollback to previous deploy",
        "rollback vercel", "vercel rollback",
        "rollback to the last green deploy",
        "revert", "revert deploy", "revert the deploy",
        "revert the deployment", "revert prod", "revert production",
        "revert to last good", "revert vercel", "revertir",
        "revertir el deploy", "revertir despliegue",
        "revertir a producción anterior", "revertir a la anterior",
        "revertir vercel", "volver atrás", "volver al deploy anterior",
        "volver al deploy previo", "volver al último estable",
        "volver al verde", "regresa al deploy anterior",
        "regresar a la versión anterior", "regresa a la versión estable",
        "regresa producción", "echa para atrás", "echa atrás el deploy",
        "echar para atrás el despliegue", "haz rollback", "haz un rollback",
        "haz rollback de prod", "deshaz el deploy",
        "deshaz el último deploy", "undo last deploy", "undo deploy",
        "undo the deployment", "undo last release", "back out the deploy",
        "back this deploy out", "back it out", "downgrade prod",
        "downgrade production", "downgrade deploy",
        "go back to the last working deploy", "go back to previous",
        "deploy the previous version", "redeploy previous",
        "re-deploy old version", "promote previous deploy",
        "promote last good deploy",
    ]),

    ("community_fixes", 0.44, &[
        "community fixes", "community fix", "show community fixes",
        "find community fixes", "search community fixes",
        "search the community", "search the network",
        "search the fix network", "any community fixes",
        "any known fixes", "any known patterns", "is this a known issue",
        "is this a known error", "is this known",
        "has this been fixed before", "have others fixed this",
        "how did others fix this", "how have others solved this",
        "how do others fix this", "known pattern", "known patterns",
        "patrón conocido", "patrones conocidos",
        "es un error conocido", "es conocido este error",
        "este error es conocido", "ya se vio este error",
        "ya alguien arregló esto", "fix conocido", "fixes conocidos",
        "hay fix de la comunidad", "fixes de la comunidad",
        "busca en la comunidad", "busca un fix", "busca un fix conocido",
        "buscar patrones", "buscar parches", "comunidad",
        "fleet fixes", "fleet patterns", "crowdsourced fixes",
        "crowd fixes", "what does the community say",
        "what does the network say", "ask the fleet",
        "consultar la flota", "consulta la red",
        "find similar fixes", "find similar issues", "errores similares",
        "find a similar fix", "anyone seen this before",
        "alguien ya vio esto", "alguien ya lo arregló",
        "has anyone fixed this", "show me how others solved this",
        "show fixes from the network", "show fleet fixes",
        "looking for prior art", "prior art for this error",
        "is there a recipe for this", "any recipe for this",
        "any pattern for this error",
    ]),

    ("risk_assessment", 0.45, &[
        "risk assessment", "risk score", "assess risk", "assess this PR",
        "assess this deploy", "assess this change",
        "assess risk of this PR", "how risky is this",
        "how risky is this PR", "how risky is this deploy",
        "how risky is this change", "how dangerous is this",
        "is this PR risky", "is this deploy risky",
        "is this change risky", "is it risky to deploy",
        "is it safe to deploy", "is it safe to merge",
        "should i be worried about this", "should I deploy this",
        "should I merge this", "is this safe to ship",
        "qué tan riesgoso es esto", "que tan riesgoso es esto",
        "qué tan peligroso es esto", "es seguro deployear",
        "es seguro mergear", "es riesgoso este PR",
        "es seguro este cambio", "qué riesgo tiene este PR",
        "riesgo del PR", "evalúa el riesgo", "evalua el riesgo",
        "evalúa este PR", "evalúa este cambio", "calcula el riesgo",
        "riesgo del deploy", "score de riesgo", "puntaje de riesgo",
        "blast radius", "radio de impacto", "impact analysis",
        "análisis de impacto", "PR risk", "PR risk score",
        "deploy risk", "deployment risk", "merge risk", "change risk",
        "change risk score", "riesgo del cambio",
        "predict failure", "predict deploy failure",
        "predicción de falla", "qué probabilidad hay de que falle",
        "what's the chance this breaks", "what's the chance this fails",
        "probability this fails", "preview the impact",
        "previsualiza el impacto", "simulate this fix", "simula el fix",
        "simulación del fix", "shadow replay this",
        "what could go wrong with this", "what might go wrong",
        "what are the risks",
    ]),

    ("create_monitor", 0.46, &[
        "create monitor", "create a monitor", "create an uptime monitor",
        "add monitor", "add a monitor", "add an uptime monitor",
        "add a new monitor", "new monitor", "new uptime monitor",
        "set up a monitor", "setup monitor", "setup a new monitor",
        "set up uptime check", "set up uptime monitoring",
        "set up monitoring for this URL", "monitor this URL",
        "monitor this endpoint", "monitor this site",
        "monitor this domain", "monitor this api",
        "watch this URL", "watch this endpoint", "watch this site",
        "track this endpoint", "track uptime of this",
        "crear monitor", "crear un monitor", "agregar monitor",
        "añadir monitor", "añade un monitor", "agrega un monitor",
        "monitor nuevo", "nuevo monitor", "monitorea este endpoint",
        "monitorea este URL", "monitorea este sitio",
        "monitorea esta api", "ponle un monitor a esto",
        "ponle monitor a esta URL", "vigila este endpoint",
        "vigila esta URL", "configura un monitor", "configurar monitor",
        "configura uptime para esto", "configura uptime para esta URL",
        "registra este endpoint para monitoreo", "agregar uptime check",
        "agrega uptime check", "uptime check para este URL",
        "add uptime check", "add http check", "add health check monitor",
        "create health check", "create a health monitor",
        "watch this status page", "expect 200 on this URL",
        "expect 201 on this endpoint", "ping every minute",
        "check this every minute", "check every 60s",
        "monitor con código esperado",
    ]),

    ("ask_inari", 0.45, &[
        "ask inari", "ask the ai", "ask the assistant", "ask the bot",
        "pregúntale a inari", "preguntale a inari", "pregunta a inari",
        "pregúntale al asistente", "pregunta a la AI", "pregunta a la IA",
        "inari", "hey inari", "ok inari", "inari ayúdame", "inari help",
        "inari can you tell me", "inari what do you think",
        "inari opinion", "qué opinas inari", "que opinas inari",
        "inari qué crees", "inari what do you think about this",
        "inari give me your opinion", "tell me inari", "tell me about",
        "explain in plain words", "explica en palabras simples",
        "summary of the situation", "give me a summary inari",
        "summarize the alerts", "summarize my projects", "summarize today",
        "resúmeme el día", "resúmeme las alertas", "resume el estado",
        "resume mi día", "what do you recommend",
        "what would you recommend", "recommend an action",
        "give me a recommendation", "qué recomiendas", "que recomiendas",
        "qué me sugieres", "qué sugieres", "your take", "what's your take",
        "what is your take", "your opinion", "tu opinión", "tu opinion",
        "give me your take", "dame tu opinión", "dame tu opinion",
        "lay it out for me", "tldr please", "tldr inari",
        "give me the tldr", "explícame esto", "explain me this",
        "explain me what's going on", "explícame qué está pasando",
        "talk to me about", "háblame de", "cuéntame qué pasa",
        "what should I do", "qué hago", "que hago",
    ]),

    ("postmortem", 0.46, &[
        "postmortem", "post-mortem", "post mortem", "the postmortem",
        "generate postmortem", "generate a postmortem",
        "write a postmortem", "write the postmortem",
        "draft postmortem", "draft a postmortem", "give me a postmortem",
        "give me the postmortem", "show me the postmortem",
        "fetch postmortem", "create postmortem",
        "create a postmortem for this", "postmortem of this incident",
        "postmortem of latest", "postmortem para este incidente",
        "postmortem del incidente", "haz un postmortem",
        "hazme un postmortem", "redacta un postmortem",
        "escribe un postmortem", "genera un postmortem",
        "dame el postmortem", "dame un postmortem",
        "incident report", "incident write-up", "incident writeup",
        "incident summary", "reporte de incidente",
        "reporte del incidente", "informe de incidente",
        "resumen de incidente", "redacta el informe", "redacta el reporte",
        "write the incident report", "draft the incident report",
        "draft an incident summary", "post-incident review", "PIR",
        "RCA write-up", "RCA report", "informe RCA", "reporte RCA",
        "5 whys analysis", "5 porqués", "análisis 5 porqués",
        "after-action review", "AAR", "lessons learned",
        "lecciones aprendidas", "what did we learn from this",
        "qué aprendimos de esto", "action items from the incident",
        "action items del incidente", "tareas derivadas del incidente",
        "incident timeline", "línea de tiempo del incidente",
        "timeline of what happened", "draft a writeup",
        "writeup for this incident", "incident retrospective",
        "retrospectiva del incidente",
    ]),

    ("reopen_alert", 0.47, &[
        "reopen", "reopen it", "reopen alert", "reopen this alert",
        "reopen the alert", "reopen latest", "reopen latest alert",
        "reopen the latest alert", "reopen this", "re-open",
        "re-open the alert", "re-open latest", "open again",
        "abrir de nuevo", "abrir otra vez", "abre esto otra vez",
        "abre la alerta otra vez", "abre de nuevo la alerta",
        "reabre la alerta", "reabrir alerta", "reabrir esto",
        "reabrelo", "reábrelo", "vuelvelo a abrir",
        "vuélvelo a abrir", "vuelve a abrir la alerta",
        "vuelve a abrir esto", "unresolve", "unresolve it",
        "unresolve this", "unresolve the alert", "unresolve latest",
        "desresolver la alerta", "deshacer resolución",
        "mark as not resolved", "marcar como no resuelta",
        "marca como no resuelto", "marcar como abierto",
        "marca como abierta", "mark as open", "mark as unresolved",
        "set as open", "set as unresolved", "this isn't fixed",
        "this is not fixed", "esto no está arreglado",
        "esto no esta arreglado", "esto sigue mal", "it's back",
        "it came back", "the error is back", "the alert is back",
        "regresó el error", "regreso el error", "volvió la alerta",
        "volvió a fallar", "regression on this alert",
        "regresión en esta alerta", "still broken",
        "todavía está roto", "todavia esta roto",
        "sigue roto", "sigue fallando",
    ]),

    ("run_health_check", 0.45, &[
        "run a health check", "run health check", "run health checks",
        "do a health check", "do a health check now",
        "trigger health check", "trigger a health check",
        "fire a health check", "kick off health check",
        "kick off a health check", "execute health check",
        "execute a health check", "perform health check",
        "perform a health check", "health check now",
        "health check please", "haz un health check",
        "hazme un health check", "lanza un health check",
        "lanzar health check", "lanza el health check",
        "corre el health check", "ejecuta el health check",
        "ejecutar health check", "dispara un health check",
        "haz un chequeo", "haz un chequeo de salud",
        "chequeo de salud", "haz un check", "haz un check ahora",
        "probe the system", "probe everything", "probe production",
        "probe prod", "ping everything", "ping all monitors",
        "ping all the things", "ping all monitors now",
        "ping todos los monitores", "pingueando todo", "ping todo",
        "run a check", "run the check", "run checks",
        "run a smoke test", "smoke test", "smoke test prod",
        "smoke test production", "test the system live",
        "live health check", "live probe", "verify health",
        "verify system health", "verify production",
        "verificar salud", "verifica la salud del sistema",
        "verifica producción", "verificar producción", "verificar prod",
        "cómo está en vivo", "como esta en vivo", "estado en vivo",
        "live status", "real-time status", "estado en tiempo real",
        "force a probe",
    ]),

    ("search_codebase", 0.44, &[
        "search code", "search the code", "search the codebase",
        "search code for", "search codebase for", "find in code",
        "find in the codebase", "find code for", "find this in the code",
        "look up in code", "look up in the codebase",
        "look in the codebase for", "grep code for", "grep the codebase",
        "grep for", "find where this function is defined",
        "find where this is used", "find usage of", "find usages of",
        "find references to", "find references for", "find callers of",
        "find callers", "find the file for", "where is this function",
        "where is this defined", "where is this code",
        "where is this used", "show me the code for", "show code for",
        "show me where X is", "show the implementation of",
        "show the source of", "buscar en el código",
        "buscar en el codigo", "busca en el código",
        "busca en la base de código", "busca código",
        "busca esto en el código", "buscar función", "buscar funcion",
        "buscar referencias", "dónde está esta función",
        "donde esta esta funcion", "dónde se usa esto",
        "donde se usa esto", "dónde se llama", "dónde se define",
        "muéstrame el código de", "muestrame el codigo de",
        "muéstrame la implementación", "muestrame la implementacion",
        "código de esta función", "show me the implementation",
        "show me the function", "find that function", "find function",
        "find class", "find module", "code search", "code search for",
        "code lookup", "lookup function in code",
        "semantic code search", "vector search code",
        "reindex code", "reindex codebase", "reindex the code",
        "re-index the codebase", "reindexar el código",
        "reindexar codigo",
    ]),
];

// ── Classifier ─────────────────────────────────────────────────────────

pub struct SemanticClassifier {
    // (intent, L2-normalized centroid, similarity threshold)
    centroids: Vec<(String, [f32; EMBEDDING_DIM], f32)>,
}

impl SemanticClassifier {
    fn empty() -> Self {
        Self { centroids: Vec::new() }
    }

    /// Initialize: load from disk cache or compute from examples.
    /// Blocking — must be called from `spawn_blocking`.
    pub fn init(cache_path: Option<PathBuf>) -> Self {
        // Fast path: load existing cache — but only if the intent count
        // matches EXAMPLES. A mismatch means EXAMPLES was updated and the
        // cache is stale; recompute automatically.
        if let Some(ref path) = cache_path {
            if let Ok(c) = Self::load(path) {
                if !c.centroids.is_empty() {
                    if c.centroids.len() == EXAMPLES.len() {
                        tracing::info!("[L1] centroids loaded from cache ({} intents)", c.centroids.len());
                        return c;
                    }
                    tracing::info!(
                        "[L1] cache has {} intents, EXAMPLES has {} — recomputing",
                        c.centroids.len(),
                        EXAMPLES.len()
                    );
                }
            }
        }

        // Slow path: compute from examples using fastembed.
        tracing::info!("[L1] computing centroids from {} intents ({} total phrases)…",
            EXAMPLES.len(),
            EXAMPLES.iter().map(|(_, _, p)| p.len()).sum::<usize>()
        );
        match Self::compute() {
            Ok(c) => {
                if let Some(path) = cache_path {
                    if let Err(e) = c.save(&path) {
                        tracing::warn!(error = %e, "[L1] could not save centroid cache");
                    } else {
                        tracing::info!("[L1] centroid cache written to {}", path.display());
                    }
                }
                tracing::info!("[L1] {} intent centroids ready", c.centroids.len());
                c
            }
            Err(e) => {
                tracing::warn!(error = %e, "[L1] centroid generation failed; L1 disabled");
                Self::empty()
            }
        }
    }

    fn compute() -> Result<Self, String> {
        let mut centroids = Vec::new();

        for (intent, threshold, phrases) in EXAMPLES {
            let texts: Vec<String> = phrases.iter().map(|s| s.to_string()).collect();
            let embeddings = embed_batch(&texts)
                .map_err(|e| format!("embed {intent}: {e}"))?;

            if embeddings.is_empty() {
                continue;
            }

            // Average all phrase embeddings.
            let mut sum = [0f32; EMBEDDING_DIM];
            for emb in &embeddings {
                for (s, v) in sum.iter_mut().zip(emb.iter()) {
                    *s += v;
                }
            }
            let n = embeddings.len() as f32;
            let mut centroid = [0f32; EMBEDDING_DIM];
            for (c, s) in centroid.iter_mut().zip(sum.iter()) {
                *c = s / n;
            }

            // L2-normalize.
            let norm: f32 = centroid.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm < f32::EPSILON {
                continue;
            }
            centroid.iter_mut().for_each(|x| *x /= norm);

            centroids.push((intent.to_string(), centroid, *threshold));
        }

        Ok(Self { centroids })
    }

    fn load(path: &PathBuf) -> Result<Self, String> {
        let json = std::fs::read_to_string(path)
            .map_err(|e| format!("read: {e}"))?;
        let entries: Vec<CacheEntry> = serde_json::from_str(&json)
            .map_err(|e| format!("parse: {e}"))?;

        let centroids = entries
            .into_iter()
            .filter_map(|e| {
                if e.vector.len() != EMBEDDING_DIM {
                    return None;
                }
                let mut arr = [0f32; EMBEDDING_DIM];
                arr.copy_from_slice(&e.vector);
                let norm: f32 = arr.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm < f32::EPSILON {
                    return None;
                }
                arr.iter_mut().for_each(|x| *x /= norm);
                Some((e.intent, arr, e.threshold))
            })
            .collect();

        Ok(Self { centroids })
    }

    fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir: {e}"))?;
        }
        let entries: Vec<CacheEntry> = self
            .centroids
            .iter()
            .map(|(intent, arr, threshold)| CacheEntry {
                intent:    intent.clone(),
                threshold: *threshold,
                vector:    arr.to_vec(),
            })
            .collect();
        let json = serde_json::to_string_pretty(&entries)
            .map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(path, json).map_err(|e| format!("write: {e}"))
    }

    /// Classify `text`. Returns `None` when L1 is disabled or no intent
    /// exceeds its threshold.
    pub fn classify(&self, text: &str) -> Option<SemanticMatch> {
        if self.centroids.is_empty() {
            return None;
        }

        let raw = embed_one(text).ok()?;

        let norm: f32 = raw.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm < f32::EPSILON {
            return None;
        }
        let mut qvec = raw;
        qvec.iter_mut().for_each(|x| *x /= norm);

        let mut best: Option<(f32, &str)> = None;
        for (intent, centroid, threshold) in &self.centroids {
            let sim: f32 = qvec.iter().zip(centroid.iter()).map(|(a, b)| a * b).sum();
            if sim >= *threshold {
                if best.map_or(true, |(prev, _)| sim > prev) {
                    best = Some((sim, intent));
                }
            }
        }

        best.map(|(sim, intent)| SemanticMatch {
            intent:     intent.to_string(),
            confidence: sim,
        })
    }
}

// ── Global singleton ───────────────────────────────────────────────────

static CLASSIFIER: OnceLock<SemanticClassifier> = OnceLock::new();

/// Return the classifier, initializing it on first call.
/// `cache_path` is only used on the first call; subsequent calls ignore it.
pub fn get_or_init(cache_path: Option<PathBuf>) -> &'static SemanticClassifier {
    CLASSIFIER.get_or_init(|| SemanticClassifier::init(cache_path))
}
