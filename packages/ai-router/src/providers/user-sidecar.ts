// User-sidecar (Inari Live) provider adapter.
//
// PHASE 1 STUB. Will be wired up in v0.3 S2 (WS relay) — see
// INARI_LIVE_V0_3_HANDOFF.md §S2. Until then, every dispatch that resolves
// to substrate "user-sidecar" hits this stub, which throws — and the
// caller's fallback rule routes it back to cloud transparently.

import type {
  AIResponse,
  CompleteOpts,
  ToolUseOpts,
  ToolUseProviderResult,
  VisionOpts,
  VisionProviderResult,
} from "./types";

const NOT_IMPL =
  "user-sidecar substrate not implemented yet (lands in v0.3 S2)";

export async function complete(_opts: CompleteOpts): Promise<AIResponse> {
  throw new Error(NOT_IMPL);
}

export async function withTools(
  _opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  throw new Error(NOT_IMPL);
}

export async function vision(_opts: VisionOpts): Promise<VisionProviderResult> {
  throw new Error(NOT_IMPL);
}
