/**
 * Code Intelligence v2 — Phase 0.1
 * Unit tests for the embedding-model-version helpers.
 */

import { describe, expect, it } from "vitest";

import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL_OPENAI_TES_SMALL,
  EMBEDDING_MODEL_VOYAGE_CODE_3,
  EMBEDDING_MODEL_LOCAL,
  LOCAL_EMBED_KEY,
  detectEmbeddingProvider,
  resolveEmbeddingModelLabel,
} from "../embeddings";

describe("embeddings — model version labels", () => {
  it("exposes a 768-dim contract (nomic-embed-code)", () => {
    expect(EMBEDDING_DIMS).toBe(768);
  });

  it("exports stable string labels", () => {
    expect(EMBEDDING_MODEL_VOYAGE_CODE_3).toBe("voyage-code-3");
    expect(EMBEDDING_MODEL_OPENAI_TES_SMALL).toBe("openai-text-embedding-3-small");
    expect(EMBEDDING_MODEL_LOCAL).toBe("nomic-embed-code");
  });

  it("LOCAL_EMBED_KEY is a non-empty sentinel string", () => {
    expect(typeof LOCAL_EMBED_KEY).toBe("string");
    expect(LOCAL_EMBED_KEY.length).toBeGreaterThan(0);
  });

  it("detectEmbeddingProvider routes Voyage (pa-) keys to voyage", () => {
    expect(detectEmbeddingProvider("pa-test-1234")).toBe("voyage");
  });

  it("detectEmbeddingProvider routes all other keys to local", () => {
    expect(detectEmbeddingProvider("sk-proj-abc123")).toBe("local");
    expect(detectEmbeddingProvider(LOCAL_EMBED_KEY)).toBe("local");
    expect(detectEmbeddingProvider("")).toBe("local");
  });

  it("resolveEmbeddingModelLabel returns voyage label for Voyage keys", () => {
    expect(resolveEmbeddingModelLabel("pa-test-1234")).toBe("voyage-code-3");
  });

  it("resolveEmbeddingModelLabel returns local label for non-Voyage keys", () => {
    expect(resolveEmbeddingModelLabel("sk-proj-abc")).toBe("nomic-embed-code");
    expect(resolveEmbeddingModelLabel(LOCAL_EMBED_KEY)).toBe("nomic-embed-code");
  });
});
