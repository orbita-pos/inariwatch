/**
 * Layer 1 centroid generator.
 *
 * Embeds the Layer 0 example phrases per intent using
 * @xenova/transformers (MiniLM-L6-v2 — same model as fastembed's
 * AllMiniLML6V2), averages the embeddings to produce one centroid
 * per intent, then writes `src-tauri/resources/intent-centroids.json`.
 *
 * Run:
 *   node desktop/scripts/gen-centroids.mjs
 *
 * Requirements:
 *   npm install @xenova/transformers
 *   (or: npx --yes @xenova/transformers — the import below handles it)
 *
 * After running, rebuild the Tauri app for the new centroids to take effect:
 *   cd desktop && npm run tauri dev   (dev)
 *   cd desktop && npm run tauri build (release)
 */

import { pipeline } from "@xenova/transformers";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../src-tauri/resources/intent-centroids.json");

// ── Example phrases per intent ────────────────────────────────────────
// Mirrors the Layer 0 test cases. Add more phrases to improve coverage.

const EXAMPLES = {
  list_alerts: [
    "show me my alerts",
    "show alerts",
    "list alerts",
    "¿cuántos errores hay?",
    "cuantas alertas tengo",
    "qué pasó esta noche",
    "qué reventó",
    "what's wrong",
    "what's broken",
    "any new errors?",
    "dame las alertas críticas",
    "alertas recientes",
    "recent alerts",
    "últimas 5 alertas",
    "last errors",
    "muéstrame los fallos",
    "any active alerts",
    "show me what's failing",
    "what issues are open",
    "are there any problems",
  ],

  status_summary: [
    "cómo está el sistema",
    "cómo va todo",
    "¿todo bien?",
    "todo ok?",
    "system status",
    "service health",
    "system overview",
    "everything ok?",
    "everything working?",
    "qué tal está todo",
    "está todo bien",
    "is the system healthy",
    "how is the app doing",
    "overall system health",
    "is everything up",
  ],

  uptime_monitors: [
    "uptime",
    "uptime status",
    "monitors de uptime",
    "hay algo caído",
    "anything down",
    "están los monitores caídos",
    "cuántos monitores hay",
    "how many monitors",
    "check uptime",
    "response time",
    "latencia",
    "are any monitors down",
    "is the site up",
    "ping check",
    "which endpoints are failing",
    "check availability",
  ],

  recent_deploys: [
    "últimos deploys",
    "recent deployments",
    "last deployments",
    "qué se deployó",
    "qué se subió ayer",
    "what's been deployed",
    "what was merged",
    "recent builds",
    "últimas subidas",
    "últimos releases",
    "vercel deploys",
    "what was released",
    "show me recent releases",
    "what got pushed",
    "latest changes",
  ],

  oncall_status: [
    "quién está de guardia",
    "quien está en turno",
    "who is on call",
    "who's on call right now",
    "on-call schedule",
    "on call status",
    "on call ahora",
    "a quién contacto",
    "on call hoy",
    "who should I contact",
    "who is responsible now",
    "who is the engineer on call",
    "oncall rotation",
  ],

  help: [
    "ayuda",
    "help",
    "qué puedes hacer",
    "que sabes hacer",
    "what can you do",
    "what can you help with",
    "cómo te uso",
    "how to use",
    "instrucciones",
    "what commands do you support",
    "how do I use this",
    "show me what you can do",
  ],
};

// ── Similarity threshold per intent ──────────────────────────────────
// Conservative starting points; tune after evaluating on held-out queries.

const THRESHOLDS = {
  list_alerts:     0.40,
  status_summary:  0.40,
  uptime_monitors: 0.40,
  recent_deploys:  0.40,
  oncall_status:   0.42,
  help:            0.38,
};

// ── Helpers ────────────────────────────────────────────────────────────

function normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm < 1e-8 ? v : v.map(x => x / norm);
}

function mean(vectors) {
  const dim = vectors[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  return sum.map(x => x / vectors.length);
}

function cosineSim(a, b) {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("Loading MiniLM-L6-v2 via @xenova/transformers...");
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    revision: "main",
  });

  const output = [];

  for (const [intent, phrases] of Object.entries(EXAMPLES)) {
    console.log(`\nEmbedding ${phrases.length} phrases for "${intent}"...`);

    const rawVectors = [];
    for (const phrase of phrases) {
      const result = await extractor(phrase, { pooling: "mean", normalize: false });
      rawVectors.push(Array.from(result.data));
    }

    // Compute centroid and L2-normalize it.
    const centroid = normalize(mean(rawVectors));

    // Compute cosine similarities of each phrase to the centroid.
    const sims = rawVectors.map(v => cosineSim(normalize(v), centroid));
    const sorted = [...sims].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.10)];
    const p50 = sorted[Math.floor(sorted.length * 0.50)];
    const p90 = sorted[Math.floor(sorted.length * 0.90)];

    console.log(`  p10=${p10.toFixed(3)}  p50=${p50.toFixed(3)}  p90=${p90.toFixed(3)}`);
    console.log(`  threshold=${THRESHOLDS[intent]} (manual — adjust if needed)`);

    output.push({
      intent,
      threshold: THRESHOLDS[intent],
      vector: Array.from(centroid),
    });
  }

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✓ Written to ${OUT_PATH}`);
  console.log("Rebuild the Tauri app for the new centroids to take effect.");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
