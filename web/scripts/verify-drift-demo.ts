/**
 * Quick sanity check — reads back the seeded drift run to confirm it's
 * queryable and fields are intact.
 */
import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

const env = readFileSync(".env.local", "utf-8");
const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
if (!match) {
  console.error("DATABASE_URL not found");
  process.exit(1);
}
const sql = neon(match[1]);

const alertId = "d0e9e62e-b08e-4dd8-89ca-08ab142019ee";

async function main() {
  const drift = await sql`
    SELECT
      status, passed, analyzed_endpoints, drifted_endpoints, improved_endpoints,
      insufficient_data_endpoints, max_drift_score, threshold_drifted_percent,
      window_days,
      jsonb_array_length(endpoint_details) AS drift_count,
      jsonb_array_length(improvements_detected) AS improved_count
    FROM behavioral_drift_runs
    WHERE alert_id = ${alertId}::uuid
  `;

  const metrics = await sql`
    SELECT COUNT(*)::int AS n, MIN(latency_ms) AS min_lat, MAX(latency_ms) AS max_lat
    FROM session_endpoint_metrics
    WHERE endpoint_signature = 'POST /api/checkout/:id'
      AND healthy = TRUE
  `;

  console.log("behavioral_drift_runs:", drift);
  console.log("session_endpoint_metrics (baseline):", metrics);
}

main();
