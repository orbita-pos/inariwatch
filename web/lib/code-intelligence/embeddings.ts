/**
 * Embedding provider for Code Intelligence.
 *
 * Primary  : Voyage Code 3 (768 dims, optimized for code retrieval)
 * Fallback : nomic-ai/nomic-embed-code running locally via ONNX Runtime
 *            (768 dims, free, no API key needed, ~65 MB quantized model)
 *
 * Use LOCAL_EMBED_KEY as the apiKey argument to force the local provider.
 * Any non-Voyage key also routes to local.
 */

import { embedBatch, LOCAL_EMBED_DIMS } from "@/lib/ai/local-embeddings";
import { logCodeIntelEvent } from "./logger";

export const EMBEDDING_DIMS = LOCAL_EMBED_DIMS; // 768

// Stable labels stamped on code_chunks.embedding_model_version.
// EMBEDDING_MODEL_OPENAI_TES_SMALL kept for backward compatibility with rows
// written before migration 0094 (those rows have NULL embeddings after the migration).
export const EMBEDDING_MODEL_VOYAGE_CODE_3 = "voyage-code-3";
export const EMBEDDING_MODEL_OPENAI_TES_SMALL = "openai-text-embedding-3-small";
export const EMBEDDING_MODEL_LOCAL = "nomic-embed-code";

// Pass as apiKey to explicitly request local inference.
export const LOCAL_EMBED_KEY = "__local__";

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

// ── Local inference (nomic-embed-code via ONNX) ─────────────────────────────

async function localEmbed(texts: string[]): Promise<number[][]> {
  return embedBatch(texts);
}

// ── Auto-detect provider from API key ────────────────────────────────────────

export type EmbeddingProvider = "voyage" | "local";

export function detectEmbeddingProvider(key: string): EmbeddingProvider {
  if (key.startsWith("pa-")) return "voyage";
  return "local";
}

export function resolveEmbeddingModelLabel(apiKey: string): string {
  return detectEmbeddingProvider(apiKey) === "voyage"
    ? EMBEDDING_MODEL_VOYAGE_CODE_3
    : EMBEDDING_MODEL_LOCAL;
}

// ── Unified API ──────────────────────────────────────────────────────────────

export type EmbeddingBatchResult = {
  vectors: number[][];
  modelVersion: string;
};

export async function embedTexts(
  texts: string[],
  apiKey: string,
  inputType: "document" | "query" = "document"
): Promise<number[][]> {
  if (detectEmbeddingProvider(apiKey) === "voyage") {
    return voyageEmbed(texts, inputType, apiKey);
  }
  return localEmbed(texts);
}

export async function embedTextsWithModel(
  texts: string[],
  apiKey: string,
  inputType: "document" | "query" = "document"
): Promise<EmbeddingBatchResult> {
  const modelVersion = resolveEmbeddingModelLabel(apiKey);
  const vectors = await embedTexts(texts, apiKey, inputType);
  return { vectors, modelVersion };
}

export async function embedQuery(
  query: string,
  apiKey: string
): Promise<number[] | null> {
  try {
    const results = await embedTexts([query], apiKey, "query");
    return results[0] ?? null;
  } catch (err) {
    logCodeIntelEvent({
      event: "search.embedding_unavailable",
      severity: "warn",
      provider: resolveEmbeddingModelLabel(apiKey),
      error: err,
    });
    return null;
  }
}
