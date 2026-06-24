/**
 * Layer 0 — deterministic intent classifier.
 *
 * Pure function, synchronous, zero external dependencies. Runs in ~0ms
 * on every sendMessage call before any IPC or LLM cost is incurred.
 *
 * Scoring system:
 *   - strongKeyword match  → intent fires immediately with confidence 1.0
 *   - keyword match        → +1 point each
 *   - phrase match         → +3 points each (structural regex patterns)
 *   - negation match       → -5 points each (reasoning / analysis markers)
 *   - intent fires if final score ≥ threshold
 *   - tie within 1 point between top two → null (ambiguous, pass to LLM)
 *
 * NOTE: \b word boundaries are NOT used for accented/non-ASCII words
 * because JavaScript's \b only works with [a-zA-Z0-9_]. Phrases are
 * specific enough to avoid false positives without boundaries.
 */

import type { ChatMessage } from "@/lib/store/chat";
import type { IntentKind, L0Match } from "./types";

// ── Config ────────────────────────────────────────────────────────────

interface IntentConfig {
  /**
   * Any single token from this list triggers the intent immediately
   * (confidence 1.0). Use for unambiguous single-word commands like
   * "uptime" or "ayuda".
   */
  readonly strongKeywords: readonly string[];
  /** Individual tokens. Each match adds +1. */
  readonly keywords: readonly string[];
  /** Multi-word structural patterns. Each match adds +3. */
  readonly phrases: readonly RegExp[];
  /** Analysis/reasoning markers. Each match subtracts 5. */
  readonly negations: readonly RegExp[];
  /** Minimum net score (after negations) to trigger this intent. */
  readonly threshold: number;
}

const CONFIGS: Readonly<Record<IntentKind, IntentConfig>> = {
  list_alerts: {
    strongKeywords: ["alerts", "alertas", "alert", "alerta"],
    keywords: [
      "error", "errors", "errores",
      "fallo", "fallos", "fail", "failed", "failing",
      "warning", "warnings",
      "issue", "issues",
      "problema", "problemas",
      "crítico", "critico", "critical",
      "show", "muestra", "muéstrame", "dame", "lista", "list",
      "recientes", "recent", "activas", "active",
      "reventó", "rompió", "broke",
    ],
    phrases: [
      // "¿cuántos errores hay?" / "how many alerts"
      /(?:qué|que|cuántos?|cuantos?|cuántas?|cuantas?|how\s+many)\s+(?:alertas?|alerts?|errores?|errors?|issues?)/i,
      // "show me my alerts" / "dame las alertas"
      /(?:show|muéstrame|dame|lista|list|muestra)\s+(?:me\s+)?(?:mis?\s+)?(?:las?\s+)?(?:alertas?|alerts?|errores?|errors?)/i,
      // "qué pasó" / "qué reventó"
      /(?:qué|que)\s+(?:pasó|hay|reventó|rompió|está\s+(?:fallando|roto))/i,
      // "what's wrong" / "what happened"
      /what(?:'s)?\s+(?:wrong|broken|failing|happened|going\s+on)/i,
      // "últimas 5 alertas" / "last errors"
      /(?:últimas?|últimos?|last|recent)\s+\d*\s*(?:alertas?|alerts?|errores?|errors?)/i,
      // "any new errors?"
      /(?:any|alguna?)\s+(?:new\s+)?(?:alertas?|alerts?|errores?|errors?)/i,
    ],
    negations: [
      /por\s+qué/i,     /\bwhy\b/i,
      /\bcausa\b/i,     /\bcause\b/i,
      /diagnos/i,       /analiz/i,
      /\bfix\b/i,       /soluciona/i, /arregla/i,
      /explica/i,       /\bexplain\b/i,
      /root\s+cause/i,  /correlat/i,
    ],
    threshold: 2,
  },

  status_summary: {
    strongKeywords: [],   // "status" alone is too ambiguous ("uptime status", "on call status")
    keywords: ["status",
      "estado",
      "salud", "health",
      "bien", "good", "ok", "okay",
      "verde", "green",
      "operational", "operacional",
      "degradado", "degraded",
      "sistema", "system",
      "overview", "resumen", "summary",
      "general",
    ],
    phrases: [
      /(?:cómo|como)\s+(?:está|va)\s+(?:el\s+)?(?:sistema|todo|la\s+app?|el\s+proyecto)/i,
      /(?:todo|everything)\s+(?:bien|ok|good|working|fine|verde|green)/i,
      /(?:system|service)\s+(?:status|health|overview)/i,
      /(?:está|is)\s+(?:todo|everything)\s+(?:ok|bien|fine|working)/i,
      /(?:qué|que)\s+tal\s+(?:está|va)/i,
    ],
    negations: [
      /por\s+qué/i, /\bwhy\b/i,
      /alerta/i,     /\balert\b/i,
      /\buptime\b/i, /deploy/i,
    ],
    threshold: 2,
  },

  uptime_monitors: {
    strongKeywords: ["uptime", "latencia", "latency"],
    keywords: [
      "monitor", "monitors", "monitores",
      "caído", "caido", "caídos", "caidos", "down",
      "disponible", "disponibilidad", "availability",
      "offline", "unreachable",
      "ping", "endpoint",
    ],
    phrases: [
      /(?:monitors?|monitores?)\s+(?:de\s+)?(?:uptime|estado|status)/i,
      /(?:están?|is|are)\s+(?:algo|something|los\s+monitores?|monitors?)\s+(?:caídos?|down|offline)/i,
      /(?:hay\s+algo|anything)\s+(?:caído|down|offline|unreachable)/i,
      /(?:cuántos?|how\s+many)\s+(?:monitores?|monitors?)/i,
      /(?:response\s+time|tiempo\s+de\s+respuesta)/i,
    ],
    negations: [
      /por\s+qué/i, /\bwhy\b/i,
      /deploy/i,     /alerta/i,
    ],
    threshold: 2,
  },

  recent_deploys: {
    strongKeywords: ["deploys", "deployments", "deployment"],
    keywords: [
      "deploy", "despliegue", "despliegues",
      "subida", "subidas", "últimas", "últimos",
      "release", "releases",
      "pushed", "push",
      "build", "builds",
      "vercel",
      "merged", "merge",
      "lanzamiento",
    ],
    phrases: [
      /(?:últimos?|last|recent)\s+(?:\d+\s+)?(?:deploys?|deployments?|releases?|builds?|subidas?)/i,
      /(?:qué|que)\s+(?:se\s+)?(?:deployó|desplegó|subió|publicó|salió|lanzó)/i,
      /what(?:'s)?\s+(?:been\s+)?(?:deployed|released|pushed|merged)/i,
      /what\s+(?:was|has\s+been)\s+(?:deployed|released|pushed|merged)/i,
      /(?:recent|últimos?)\s+(?:changes?|cambios?|updates?|actualizaciones?)/i,
      /(?:últimas?|últimos?)\s+(?:subidas?|builds?|releases?)/i,
    ],
    negations: [
      /por\s+qué/i, /\bwhy\b/i,
      /fallando/i,   /fail/i,
    ],
    threshold: 2,
  },

  oncall_status: {
    strongKeywords: [],
    keywords: [
      "guardia", "turno", "shift",
      "quién", "quien", "who",
      "responsable", "responsible",
      "schedule", "horario",
      "rotation", "rotación",
    ],
    phrases: [
      /(?:quién|quien|who(?:'s)?)\s+(?:está\s+|is\s+)?(?:de\s+)?(?:guardia|on[- ]?call|en\s+turno)/i,
      /who\s+is\s+on\s+call/i,
      /on[- ]?call\s+(?:schedule|horario|status|now|today|ahora|hoy)/i,
      /a\s+quién\s+(?:le\s+toca|contacto|escalo)/i,
    ],
    negations: [
      /por\s+qué/i, /\bwhy\b/i,
    ],
    threshold: 2,
  },

  help: {
    strongKeywords: ["ayuda", "help"],
    keywords: [
      "instrucciones", "instructions",
      "comandos", "commands",
    ],
    phrases: [
      /(?:qué|que)\s+(?:puedes|sabes|haces)(?:\s+hacer)?/i,
      /what\s+can\s+you\s+(?:do|help|tell)/i,
      /(?:cómo|como)\s+(?:te\s+uso|puedo\s+usarte|funciona)/i,
      /how\s+(?:to\s+use|do\s+i\s+use)/i,
    ],
    negations: [],
    threshold: 1,
  },

  open_player: {
    strongKeywords: [],
    keywords: [],
    phrases: [],
    negations: [],
    threshold: 999,
  },

  error_trends: {
    strongKeywords: ["tendencias", "tendencia"],
    keywords: [
      "trend", "trends", "trending",
      "semana", "week", "weekly",
      "diario", "daily", "day",
      "frecuencia", "frequency",
      "recurrente", "recurrent", "recurring",
      "top", "más", "mas", "most",
    ],
    phrases: [
      /(?:error|alert|alerta)\s+trend/i,
      /(?:tendencia|tendencias)\s+(?:de\s+)?(?:errores?|alerts?)/i,
      /(?:cuántos?|cuantos?|how\s+many)\s+errores?\s+(?:esta?\s+semana|en\s+\d+\s+días?|last\s+\d+\s+days?)/i,
      /(?:errores?|errors?|alerts?)\s+(?:en\s+la\s+)?(?:semana|week|últimos?\s+\d+\s+días?)/i,
      /(?:breakdown|desglose)\s+(?:de\s+)?errores?/i,
      /top\s+(?:errores?|errors?|recurring)/i,
    ],
    negations: [
      /por\s+qué/i, /\bwhy\b/i,
      /root\s+cause/i, /diagnos/i,
    ],
    threshold: 2,
  },

  root_cause: {
    strongKeywords: [],
    keywords: [
      "causa", "cause",
      "diagnóstico", "diagnostico", "diagnosis",
      "diagnose", "diagnoses",
      "explicación", "explicacion", "explanation",
      "porque", "porqué", "why",
      "análisis", "analisis", "analysis",
      "ai", "inteligencia",
    ],
    phrases: [
      // Anchored "root cause" — only fires for the bare 2-word shortcut.
      // "root cause of the 500 errors" / "root cause of last deploy" are
      // scoped questions the resolver can't answer; let those fall to the
      // full AI which can pick the right cloud.* tool with context.
      /^\s*root\s+cause\s*\??\s*$/i,
      /(?:por\s+qué|porqué|why)\s+(?:falló|falla|failed?|is\s+failing)/i,
      /(?:qué|que)\s+(?:causó|causa|caused?)\s+(?:el|this|the)?\s+(?:error|fallo|problema)/i,
      /(?:diagnos|analiz|explain)\s+(?:this\s+)?(?:error|alert|alerta|fallo)/i,
      /(?:qué|que)\s+(?:dice|dijo)\s+(?:la\s+)?(?:ia|ai|inari)/i,
      /(?:ai|inari)\s+(?:diagnosis|analysis|diagnóstico|análisis)/i,
    ],
    negations: [
      /trend/i, /tendencia/i,
      /semana/i, /weekly/i,
    ],
    threshold: 2,
  },

  // set_project is handled as a fast-path in classifyL0 — this entry
  // exists only to satisfy Record<IntentKind, IntentConfig>.
  set_project: {
    strongKeywords: [],
    keywords: [],
    phrases: [],
    negations: [],
    threshold: 999,
  },

  ack_alert: {
    strongKeywords: ["ack"],
    keywords: [
      "ack", "acknowledge", "acusar", "enterado", "visto", "noted", "received",
    ],
    phrases: [
      /\back\b/i,
      /\backnowledge\b/i,
      /(?:ya\s+)?(?:lo\s+|la\s+)?vi\b/i,
      /got\s+it/i,
      /entendido|enterado/i,
      /(?:mark|marcar)\s+(?:como\s+)?(?:leída?|visto|read|seen)/i,
      /acusar\s+recibo/i,
    ],
    negations: [
      /silencia/i, /\bsilence\b/i, /dismiss/i,
      /resolve/i, /resuelv/i, /cerrar/i, /\bclose\b/i,
    ],
    threshold: 2,
  },

  silence_alert: {
    strongKeywords: ["silencia", "silence", "dismiss"],
    keywords: [
      "silence", "dismiss", "cerrar", "close", "resolve",
      "resolver", "mute", "ignorar", "ignore",
    ],
    phrases: [
      /(?:silencia|silence|mute|dismiss)\s+(?:this\s+|the\s+|la\s+|esta\s+)?(?:alert|alerta)/i,
      /(?:mark|marcar)\s+(?:as\s+)?(?:resolved|resuelto|closed|cerrado)/i,
      /(?:cierra|close|dismiss)\s+(?:this|it|la\s+alerta|el\s+error)/i,
      /(?:ya\s+)?(?:fue\s+|está\s+)?(?:resuelto|fixed|arreglado|resolved)\b/i,
      /(?:silence|silenciar)\s+(?:this|esto|eso)/i,
    ],
    negations: [
      /\back\b/i, /acknowledge/i,
    ],
    threshold: 2,
  },

  // Social turns / opening pleasantries. Match these deterministically so
  // they never bubble up to the Layer-3 LLM where the SYSTEM_OPS scope
  // rule used to make the model return empty content. resolveGreeting()
  // does a parallel fetch of alerts/status/deploys and renders a state-
  // aware response with concrete next-step suggestions — the empty
  // bubble for "hola" / "como estas" / "haha" is fixed here, not in the
  // model. Phrases are anchored to ^ so a stray "hola" inside a longer
  // monitoring question doesn't hijack the intent.
  greeting: {
    // Only unambiguous social-turn tokens. NOTE: "qué" / "que" are
    // deliberately EXCLUDED — they're shared with `help` ("que haces")
    // and `list_alerts` ("qué alertas") so making them strong here
    // would steal those intents. The phrase regexes below pin "que tal"
    // / "que onda" specifically to greeting via full-scoring.
    strongKeywords: [
      "hola", "hey", "hi", "hello", "buenas", "holi",
    ],
    keywords: [
      "haha", "jaja", "jeje", "lol", "gracias", "thanks", "thx",
      "ty", "saludos", "ola",
    ],
    phrases: [
      /^\s*(?:hola|hey|hi|hello|holi|ola)\b/i,
      /^\s*buen[oa]s?\s+(?:d[ií]as|tardes|noches)/i,
      /^\s*buenas\s*[!?¿]*\s*$/i,
      /^\s*(?:c[oó]mo|como)\s+(?:est[áa]s|andas|vas|te\s+va)\s*[?¿!]*\s*$/i,
      /^\s*(?:qu[eé]|que)\s+(?:tal|onda|pex|hubo|pedo|pasa)\s*[?¿!]*\s*$/i,
      /^\s*(?:how(?:'s)?\s+(?:it\s+going|are\s+you|things))\s*[?]*\s*$/i,
      /^\s*(?:s'?up|wassup|what'?s\s+up)\s*[?]*\s*$/i,
      /^\s*(?:thanks|gracias|thank\s+you|ty|thx)\s*[!.]*\s*$/i,
      /^\s*(?:haha|jaja|jeje|lol+|xd+|jajaja+)\s*[!.]*\s*$/i,
    ],
    // No negations needed — the ^ anchor on phrases is enough. A query
    // like "hola, what alerts do I have" is structurally "list_alerts"
    // (matches list_alerts phrases with higher score) so it wins on
    // full-scoring even if the greeting strong-keyword fires.
    negations: [],
    threshold: 1,
  },
};

// ── Tokenizer ─────────────────────────────────────────────────────────

/** Split on non-letter / non-digit Unicode characters. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1),
  );
}

// ── Confidence mapping ────────────────────────────────────────────────

function toConfidence(score: number, threshold: number): number {
  // threshold → 0.60, 2× → 0.73, 4× → ~0.95
  const ratio = score / threshold;
  return Math.min(0.6 + 0.35 * Math.log2(ratio), 1.0);
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Classify a user message using deterministic patterns. Returns `null`
 * when the message is ambiguous or requires reasoning — the caller
 * should forward to the LLM.
 *
 * `tail` is reserved for Layer 1 follow-up context resolution.
 */
export function classifyL0(
  text: string,
  _tail: ChatMessage[],
): L0Match | null {
  if (!text.trim()) return null;

  // Fast-path: /project <name> or @<name> → set active project
  // /project off | /project clear → clears active project (name = "")
  const projectCmd = text.match(/^(?:\/project|@)\s+(.+)$/i);
  if (projectCmd) {
    const name = projectCmd[1]!.trim();
    return {
      intent: "set_project",
      confidence: 1.0,
      params: { name: /^(?:off|clear|ninguno|none)$/i.test(name) ? "" : name },
    };
  }

  // Fast-path: inari hash → open player
  const hashMatch = text.match(/\binari:alert:[a-f0-9]{16}\b/i);
  if (hashMatch) {
    return {
      intent: "open_player",
      confidence: 1.0,
      params: { hash: hashMatch[0].toLowerCase() },
    };
  }

  const tokens = tokenize(text);
  const entries = Object.entries(CONFIGS) as [IntentKind, IntentConfig][];

  // Check strongKeywords — fires immediately IF no negation blocks the intent.
  // Collect all strong matches first to handle ties (e.g. "uptime status").
  const strongMatches: IntentKind[] = [];
  for (const [intent, config] of entries) {
    if (intent === "open_player") continue;
    const blocked = config.negations.some((re) => re.test(text));
    if (!blocked && config.strongKeywords.some((sk) => tokens.has(sk.toLowerCase()))) {
      strongMatches.push(intent);
    }
  }
  if (strongMatches.length === 1) {
    return { intent: strongMatches[0]!, confidence: 1.0, params: {} };
  }
  // Multiple strong matches → fall through to full scoring for disambiguation

  // Full scoring for everything else
  type Scored = { intent: IntentKind; score: number; threshold: number };
  const scored: Scored[] = [];

  for (const [intent, config] of entries) {
    if (intent === "open_player") continue;

    let score = 0;
    for (const kw of config.keywords) {
      if (tokens.has(kw.toLowerCase())) score += 1;
    }
    for (const re of config.phrases) {
      if (re.test(text)) score += 3;
    }
    for (const re of config.negations) {
      if (re.test(text)) score -= 5;
    }

    if (score >= config.threshold) {
      scored.push({ intent: intent as IntentKind, score, threshold: config.threshold });
    }
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);

  const top    = scored[0]!;
  const runner = scored[1];

  // Ambiguous: tie within 1 point → pass to LLM
  if (runner && top.score - runner.score <= 1) return null;

  return {
    intent: top.intent,
    confidence: toConfidence(top.score, top.threshold),
    params: {},
  };
}
