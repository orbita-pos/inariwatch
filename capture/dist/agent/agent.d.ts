/**
 * Peer agent orchestrator.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * Flow:
 *   1. Build system + user prompts. The system prompt + tool schemas form
 *      the cache prefix (cache_control: ephemeral). Per-event content goes
 *      after the breakpoint so cache hit rate stays high (~95% expected).
 *   2. Single tool-use loop, max 4 iterations or `deadlineMs`, whichever
 *      hits first. Each iteration:
 *        a. Send messages to OpenAI.
 *        b. If choice.finish_reason === "tool_calls", run them (in-process,
 *           ~1ms each), feed results back as tool messages, repeat.
 *        c. If finish_reason === "stop", parse hypotheses out of the final
 *           assistant message and return.
 *   3. On deadline, return partial hypotheses (or empty array) — never
 *      throw. The peer is best-effort by design (Q5.3 acceptance).
 */
import type { ErrorEvent, Hypothesis } from "../types.js";
export interface PeerAgentConfig {
    /** OpenAI API key — required. */
    apiKey: string;
    /** Model override. Default: gpt-5.4. */
    model?: string;
    /** OpenAI base URL override (Azure / proxy). */
    baseUrl?: string;
    /** Hard deadline for the entire diagnose call. Default: 1500ms. */
    deadlineMs?: number;
    /** Optional debug logger; called with structured events. */
    debug?: (msg: string, ctx?: Record<string, unknown>) => void;
}
export declare class PeerAgent {
    private readonly client;
    private readonly deadlineMs;
    private readonly debug?;
    constructor(opts: PeerAgentConfig);
    /**
     * Diagnose an event. Returns a hypotheses array (possibly empty) within
     * the deadline. Never throws — all errors are swallowed and logged via
     * the optional debug callback.
     */
    diagnose(event: ErrorEvent): Promise<Hypothesis[]>;
}
//# sourceMappingURL=agent.d.ts.map