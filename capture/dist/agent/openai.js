/**
 * Minimal OpenAI client for the local peer agent.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.3.
 *
 * Why a hand-rolled fetch instead of the official SDK:
 *   - The official `openai` npm pkg is ~6 MB and pulls Node-specific deps
 *     that bloat the SDK install for end users who never opt in to the peer.
 *   - We need exactly one endpoint (chat completions w/ tools) and the
 *     prompt-cache breakpoint header. Hand-rolled keeps capture-agent at
 *     ~30 KB total.
 *   - Mirrors the prompt-caching pattern used in
 *     `web/lib/ai/remediate.ts` (commit `d5ea113`) — same breakpoint
 *     placement so the user's account benefits from the cache on the
 *     server side too.
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_DEADLINE_MS = 1500;
export class OpenAIClient {
    constructor(opts) {
        if (!opts.apiKey)
            throw new Error("OpenAIClient: apiKey is required");
        this.apiKey = opts.apiKey;
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
        this.model = opts.model ?? DEFAULT_MODEL;
        this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    }
    /** Make a single chat request. Throws on HTTP error or deadline. */
    async chat(req) {
        const body = {
            model: req.model ?? this.model,
            messages: req.messages,
            tools: req.tools,
            temperature: req.temperature ?? 0.2,
            max_tokens: req.max_tokens ?? 600,
        };
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.deadlineMs),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
        }
        return (await res.json());
    }
    /** Default deadline (test introspection). */
    get deadline() {
        return this.deadlineMs;
    }
}
//# sourceMappingURL=openai.js.map