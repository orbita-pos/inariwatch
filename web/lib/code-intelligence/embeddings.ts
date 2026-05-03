/**
 * Embedding provider for Code Intelligence.
 *
 * Primary: Voyage Code 3 (1024 dims, optimized for code retrieval)
 * Fallback: OpenAI text-embedding-3-small (1536 dims → truncated to 1024)
 *
 * Voyage Code 3 achieves 12-15% better similarity on code vs OpenAI.
 * Uses input_type "document" for indexing, "query" for search.
 */

export const EMBEDDING_DIMS = 1024;

// Stable labels stamped on `code_chunks.embedding_model_version`.
// Bump when the model changes — never silently. Used for v1↔v2 A/B parity
// checks and to keep older embeddings queryable when a future migration
// introduces a different vector space.
export const EMBEDDING_MODEL_VOYAGE_CODE_3 = "voyage-code-3";
export const EMBEDDING_MODEL_OPENAI_TES_SMALL = "openai-text-embedding-3-small";

// ── Voyage Code 3 (primary) ─────────────────────────────────────────────────

async function voyageEmbed(
  texts: string[],
  inputType: "document" | "query",
  apiKey: string
): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voyage-code-3",
      input: texts,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMS,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    // Surface the HTTP status so /admin/ops can correlate Voyage outages
    // with embedding-coverage drops on the baseline widget.
    const { logCodeIntelEvent } = await import("./logger");
    logCodeIntelEvent({
      event: "embedding.failure",
      severity: "warn",
      provider: EMBEDDING_MODEL_VOYAGE_CODE_3,
      detail: { httpStatus: res.status, batchSize: texts.length, inputType },
    });
    throw new Error(`Voyage API error (${res.status})`);
  }

  const data = await res.json();
  return (data.data as { embedding: number[] }[]).map((d) => d.embedding);
}

// ── OpenAI fallback (truncated to 1024 dims) ────────────────────────────────

async function openaiEmbed(
  texts: string[],
  apiKey: string
): Promise<number[][]> {
  const { callAIEmbed } = await import("@inariwatch/ai-router");
  const r = await callAIEmbed(apiKey, texts, {
    model: "text-embedding-3-small",
    dimensions: EMBEDDING_DIMS,
    timeout: 30000,
  });
  return r.vectors;
}

// ── Auto-detect provider from API key ────────────────────────────────────────

export type EmbeddingProvider = "voyage" | "openai";

export function detectEmbeddingProvider(key: string): EmbeddingProvider {
  if (key.startsWith("pa-")) return "voyage"; // Voyage keys start with pa-
  return "openai";
}

/**
 * Stable identifier for the embedding model that will be used with this key.
 * Persisted on `code_chunks.embedding_model_version`.
 */
export function resolveEmbeddingModelLabel(apiKey: string): string {
  return detectEmbeddingProvider(apiKey) === "voyage"
    ? EMBEDDING_MODEL_VOYAGE_CODE_3
    : EMBEDDING_MODEL_OPENAI_TES_SMALL;
}

// ── Unified API ──────────────────────────────────────────────────────────────

export type EmbeddingBatchResult = {
  vectors: number[][];
  modelVersion: string;
};

/**
 * Generate embeddings for a batch of texts.
 * Auto-detects provider from key prefix.
 */
export async function embedTexts(
  texts: string[],
  apiKey: string,
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  const provider = detectEmbeddingProvider(apiKey);

  if (provider === "voyage") {
    return voyageEmbed(texts, inputType, apiKey);
  }
  return openaiEmbed(texts, apiKey);
}

/**
 * Generate embeddings AND surface the model label used. Indexers should
 * call this so the resulting `code_chunks.embedding_model_version` is
 * always in sync with the actual vector that was written.
 */
export async function embedTextsWithModel(
  texts: string[],
  apiKey: string,
  inputType: "document" | "query" = "document"
): Promise<EmbeddingBatchResult> {
  const modelVersion = resolveEmbeddingModelLabel(apiKey);
  const vectors = await embedTexts(texts, apiKey, inputType);
  return { vectors, modelVersion };
}

/**
 * Generate embedding for a single query (for search).
 */
export async function embedQuery(
  query: string,
  apiKey: string
): Promise<number[] | null> {
  try {
    const results = await embedTexts([query], apiKey, "query");
    return results[0] ?? null;
  } catch (err) {
    // Search will fall back to BM25-only retrieval. Logged so the baseline
    // widget can flag "vector search silently disabled" — same blind spot
    // as the rerank failure path in search.ts.
    const { logCodeIntelEvent } = await import("./logger");
    logCodeIntelEvent({
      event: "search.embedding_unavailable",
      severity: "warn",
      provider: resolveEmbeddingModelLabel(apiKey),
      error: err,
    });
    return null;
  }
}
