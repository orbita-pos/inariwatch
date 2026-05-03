/**
 * Phase 3.3 — cutover decision CLI.
 *
 * Reads `code_intel_shadow_log` + `code_intel_remediation_ab` over the
 * configured window, runs the same pure compute the admin endpoint uses,
 * and prints a colored GO/WAIT/ABORT report. Smoke-test guarantee: on
 * an empty DB the script always prints "WAIT" with "only 0 A/B samples".
 *
 * Usage:
 *   cd web
 *   npx tsx scripts/code-intel-v2-cutover-eval.ts [--window-hours 336] [--json]
 */

import { config } from "dotenv";
import path from "node:path";

config({ path: path.join(__dirname, "../.env.local") });

import {
  CUTOVER_DIVERGENCE_MAX_PCT,
  CUTOVER_MIN_SAMPLES,
  CUTOVER_SUCCESS_PARITY_PCT,
  CUTOVER_TURN_REDUCTION_PCT,
  CUTOVER_WINDOW_HOURS,
} from "../lib/code-intelligence-v2/cutover-criteria";

interface Args {
  windowHours: number;
  json: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.findIndex((a) => a === flag);
    if (i < 0) return undefined;
    return argv[i + 1];
  };
  const windowRaw = valueOf("--window-hours");
  const windowHours = windowRaw ? Number.parseInt(windowRaw, 10) : CUTOVER_WINDOW_HOURS;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    console.error(`Error: --window-hours must be a positive integer (got '${windowRaw}').`);
    process.exit(1);
  }
  return { windowHours, json: argv.includes("--json") };
}

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function paint(s: string, color: keyof typeof COLORS): string {
  if (!process.stdout.isTTY) return s;
  return `${COLORS[color]}${s}${COLORS.reset}`;
}

function badgeColor(rec: "GO" | "WAIT" | "ABORT"): keyof typeof COLORS {
  if (rec === "GO") return "green";
  if (rec === "WAIT") return "yellow";
  return "red";
}

async function main() {
  const args = parseArgs();
  const { fetchCutoverInputs } = await import("../lib/code-intelligence-v2/cutover-fetch");
  const { computeCutoverMetrics, decideCutover } = await import(
    "../lib/code-intelligence-v2/cutover-eval"
  );

  const inputs = await fetchCutoverInputs({ windowHours: args.windowHours });
  const metrics = computeCutoverMetrics(inputs);
  const decision = decideCutover(metrics);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          windowHours: args.windowHours,
          metrics,
          decision,
          thresholds: {
            CUTOVER_MIN_SAMPLES,
            CUTOVER_TURN_REDUCTION_PCT,
            CUTOVER_SUCCESS_PARITY_PCT,
            CUTOVER_DIVERGENCE_MAX_PCT,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(paint(`Code Intelligence v2 — Cutover Eval`, "bold"));
  console.log(`Window:     last ${args.windowHours}h`);
  console.log(
    `Thresholds: >=${CUTOVER_MIN_SAMPLES} samples, >=${CUTOVER_TURN_REDUCTION_PCT}% turn reduction, >=${CUTOVER_SUCCESS_PARITY_PCT}pp parity, <=${CUTOVER_DIVERGENCE_MAX_PCT}% divergence`,
  );
  console.log("");

  console.log(paint("A/B sample population", "cyan"));
  console.log(`  total:    ${metrics.ab.total}    (v1=${metrics.ab.v1Count}, v2=${metrics.ab.v2Count})`);
  console.log(`  v1 turns: ${fmtNum(metrics.ab.v1AvgTurns)}    success: ${fmtPct(metrics.ab.v1SuccessPct)}`);
  console.log(`  v2 turns: ${fmtNum(metrics.ab.v2AvgTurns)}    success: ${fmtPct(metrics.ab.v2SuccessPct)}`);
  console.log(
    `  delta:    turn reduction ${fmtPct(metrics.ab.turnReductionPct)}    success ${signed(metrics.ab.successDeltaPct)}pp`,
  );
  console.log("");

  console.log(paint("Shadow log", "cyan"));
  console.log(
    `  total:    ${metrics.shadow.total}    divergent: ${fmtPct(metrics.shadow.divergencePct)} (${metrics.shadow.divergentCount})    timeouts: ${fmtPct(metrics.shadow.timeoutPct)} (${metrics.shadow.timeoutCount})`,
  );
  console.log("");

  console.log(paint("Gates", "cyan"));
  for (const gate of decision.gates) {
    const mark = gate.passed ? paint("ok  ", "green") : paint("fail", "red");
    console.log(`  ${mark} ${gate.id.padEnd(16)} ${gate.detail}`);
  }
  console.log("");

  const badge = paint(`  ${decision.recommendation}  `, badgeColor(decision.recommendation));
  console.log(paint("Recommendation:", "bold"), badge);
  for (const reason of decision.reasons) {
    console.log(paint(`  ->`, "dim"), reason);
  }
  console.log("");

  if (decision.recommendation === "GO") {
    console.log(paint("Next steps:", "bold"));
    console.log("  1. kamal env set CODE_INTEL_V2=on  (web service)");
    console.log("  2. kamal redeploy web              (or wait for next deploy)");
    console.log("  3. Watch /admin/ops for the next 30 min — divergence ramps to 0%, errors stay flat");
    console.log("  4. Rollback: kamal env set CODE_INTEL_V2=off + redeploy (<5 min)");
    console.log("");
  }
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? n.toString() : "-";
}
function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}
function signed(n: number): string {
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

main().catch((err) => {
  console.error("\ncutover-eval failed:", err);
  process.exit(1);
});
