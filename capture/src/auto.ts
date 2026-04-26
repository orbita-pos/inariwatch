// Auto-initializing import. See README §Auto-init for env var contract.
// INARIWATCH_CAPTURE_V2=true opts in to peer integrations (capture-agent,
// capture-fleet, node-forensic) — each is an optional peer, missing peers
// are skipped silently and contribute zero weight to non-opt-in users.
import type { Integration } from "./types.js"
import { init } from "./client.js"

interface Ctx { debug: boolean }

function warn(ctx: Ctx, msg: string, err?: unknown): void {
  if (!ctx.debug) return
  console.warn(`[@inariwatch/capture] ${msg}`, err instanceof Error ? err.message : err ?? "")
}

async function loadAgent(ctx: Ctx): Promise<Integration | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.INARIWATCH_PEER_AGENT_API_KEY
  if (!apiKey) { warn(ctx, "v2 agent: OPENAI_API_KEY not set, skipping"); return null }
  try {
    const pkg = "@inariwatch/capture-agent"
    const mod = await import(/* webpackIgnore: true */ pkg) as { peerAgentIntegration?: (c: unknown) => Integration }
    return mod.peerAgentIntegration?.({
      apiKey,
      model: process.env.INARIWATCH_PEER_AGENT_MODEL,
      baseUrl: process.env.INARIWATCH_PEER_AGENT_BASE_URL,
    }) ?? null
  } catch (err) { warn(ctx, "v2 agent peer not installed", err); return null }
}

async function loadFleet(ctx: Ctx): Promise<Integration | null> {
  try {
    const pkg = "@inariwatch/capture-fleet"
    const mod = await import(/* webpackIgnore: true */ pkg) as { fleetBloomIntegration?: (c: unknown) => Integration }
    return mod.fleetBloomIntegration?.({
      baseUrl: process.env.INARIWATCH_FLEET_BASE_URL,
      contribute: process.env.INARIWATCH_FLEET_CONTRIBUTE === "true",
    }) ?? null
  } catch (err) { warn(ctx, "v2 fleet peer not installed", err); return null }
}

async function loadForensic(ctx: Ctx): Promise<Integration | null> {
  try {
    const pkg = "@inariwatch/node-forensic"
    const mod = await import(/* webpackIgnore: true */ pkg) as { forensicIntegration?: () => Integration }
    return mod.forensicIntegration?.() ?? null
  } catch (err) { warn(ctx, "v2 forensic peer not installed", err); return null }
}

async function loadV2Integrations(): Promise<Integration[]> {
  const ctx: Ctx = { debug: process.env.INARIWATCH_DEBUG === "1" }
  const xs = await Promise.all([loadForensic(ctx), loadFleet(ctx), loadAgent(ctx)])
  return xs.filter((x): x is Integration => x !== null)
}

const baseConfig = {
  release: process.env.INARIWATCH_RELEASE,
  substrate: process.env.INARIWATCH_SUBSTRATE === "true",
}

const v2Flag = process.env.INARIWATCH_CAPTURE_V2
const v2Enabled = v2Flag === "true" || v2Flag === "1" || v2Flag === "yes"

let integrations: Integration[] = []
if (v2Enabled) {
  // Top-level await: peer dynamic imports are local and resolve sub-ms
  // when present, or reject fast with MODULE_NOT_FOUND when absent —
  // either way the delay before init is negligible.
  integrations = await loadV2Integrations()
}

init({ ...baseConfig, integrations })
