/**
 * Code Intelligence v2 — Phase 0.1
 * Unit tests for the embedding-model-version helpers.
 */

import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL_OPENAI_TES_SMALL,
  EMBEDDING_MODEL_VOYAGE_CODE_3,
  detectEmbeddingProvider,
  resolveEmbeddingModelLabel,
} from "../embeddings";

describe("embeddings — model version labels", () => {
  it("exposes a 1024-dim contract", () => {
    expect(EMBEDDING_DIMS).toBe(1024);
  });

  it("uses stable string labels for migration 0078", () => {
    expect(EMBEDDING_MODEL_VOYAGE_CODE_3).toBe("voyage-code-3");
    expect(EMBEDDING_MODEL_OPENAI_TES_SMALL).toBe("openai-text-embedding-3-small");
  });

  it("detectEmbeddingProvider routes Voyage (pa-) keys to voyage", () => {
    expect(detectEmbeddingProvider("pa-test-1234")).toBe("voyage");
  });

  it("detectEmbeddingProvider routes OpenAI (sk-) keys to openai", () => {
    expect(detectEmbeddingProvider("sk-proj-abc123")).toBe("openai");
  });

  it("resolveEmbeddingModelLabel matches the schema default for Voyage keys", () => {
    expect(resolveEmbeddingModelLabel("pa-test-1234")).toBe("voyage-code-3");
  });

  it("resolveEmbeddingModelLabel returns the OpenAI label for non-Voyage keys", () => {
    expect(resolveEmbeddingModelLabel("sk-proj-abc")).toBe("openai-text-embedding-3-small");
  });
});
