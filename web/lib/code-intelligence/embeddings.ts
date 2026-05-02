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

type EmbeddingResult = { embeddings: number[][]; model: string };

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

// ── Unified API ──────────────────────────────────────────────────────────────

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
 * Generate embedding for a single query (for search).
 */
export async function embedQuery(
  query: string,
  apiKey: string
): Promise<number[] | null> {
  try {
    const results = await embedTexts([query], apiKey, "query");
    return results[0] ?? null;
  } catch {
    return null;
  }
}
