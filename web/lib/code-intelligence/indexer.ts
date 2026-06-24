/**
 * Code Intelligence Indexer
 *
 * Pipeline: GitHub API → parse → docstrings (AI batch) → embeddings → pgvector
 * Supports incremental indexing via git diff.
 */

import { db, codeRepositories, codeChunks, codeDependencies } from "@/lib/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import * as gh from "@/lib/services/github-api";
import { parseFileAsync, shouldSkipFile, detectLanguage } from "./parser";
import type { ParsedChunk } from "./parser";
import { callAI } from "@/lib/ai/client";
import { embedTextsWithModel, resolveEmbeddingModelLabel, LOCAL_EMBED_KEY } from "./embeddings";
import { logCodeIntelEvent } from "./logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type IndexProgress = {
  phase: "fetching" | "parsing" | "docstrings" | "embeddings" | "dependencies" | "done" | "error";
  current: number;
  total: number;
  message: string;
};

export type IndexOptions = {
  ghToken: string;
  owner: string;
  repo: string;
  projectId: string;
  openaiKey?: string; // for docstrings (GPT-4o-mini)
  embeddingKey?: string; // for embeddings (Voyage Code 3 or OpenAI); falls back to openaiKey
  onProgress?: (p: IndexProgress) => void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_FILES = 2000;
const MAX_FILE_SIZE = 100_000; // 100KB per file
const DOCSTRING_BATCH_SIZE = 15; // chunks per AI call
const EMBEDDING_BATCH_SIZE = 50; // embeddings per OpenAI call
const MAX_CHUNKS_PER_REPO = 10_000;

/** Strip tokens/keys from error messages before storing or emitting. */
function sanitizeError(msg: string): string {
  return msg
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/ghp_[a-zA-Z0-9]{10,}/g, "[REDACTED]")
    .replace(/gho_[a-zA-Z0-9]{10,}/g, "[REDACTED]")
    .replace(/key=[^\s&"']+/gi, "key=[REDACTED]");
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function indexRepository(opts: IndexOptions): Promise<{ repoId: string; chunksIndexed: number }> {
  const { ghToken, owner, repo, projectId, openaiKey, onProgress } = opts;
  // Default to local nomic inference when no cloud key is provided.
  const embeddingKey = opts.embeddingKey ?? openaiKey ?? LOCAL_EMBED_KEY;
  const emit = onProgress ?? (() => {});

  // 1. Upsert code_repository record
  const existing = await db
    .select()
    .from(codeRepositories)
    .where(
      and(
        eq(codeRepositories.projectId, projectId),
        eq(codeRepositories.githubOwner, owner),
        eq(codeRepositories.githubRepo, repo)
      )
    )
    .then((r) => r[0]);

  let repoId: string;
  if (existing) {
    repoId = existing.id;
    await db
      .update(codeRepositories)
      .set({ status: "indexing", errorMessage: null, updatedAt: new Date() })
      .where(eq(codeRepositories.id, repoId));
  } else {
    const defaultBranch = await gh.getDefaultBranch(ghToken, owner, repo);
    const [inserted] = await db
      .insert(codeRepositories)
      .values({ projectId, githubOwner: owner, githubRepo: repo, defaultBranch, status: "indexing" })
      .returning({ id: codeRepositories.id });
    repoId = inserted.id;
  }

  try {
    // 2. Get the current HEAD SHA
    const repoRecord = await db.select().from(codeRepositories).where(eq(codeRepositories.id, repoId)).then((r) => r[0]!);
    const branch = repoRecord.defaultBranch;
    const headSha = await gh.getBranchSha(ghToken, owner, repo, branch);

    // 3. Determine files to process (incremental if possible)
    const lastCommit = repoRecord.lastIndexedCommit;
    let filesToProcess: string[];

    if (lastCommit) {
      // Incremental: get changed files since last index
      emit({ phase: "fetching", current: 0, total: 0, message: "Calculando diff incremental..." });
      const changedFiles = await getChangedFiles(ghToken, owner, repo, lastCommit, headSha);
      if (changedFiles) {
        filesToProcess = changedFiles.filter((f) => !shouldSkipFile(f) && detectLanguage(f) !== null);
        // Delete old chunks for changed files
        if (filesToProcess.length > 0) {
          await db.delete(codeChunks).where(
            and(
              eq(codeChunks.repoId, repoId),
              inArray(codeChunks.filePath, filesToProcess)
            )
          );
        }
      } else {
        // Diff failed (force-push, etc.) — full re-index
        filesToProcess = await getFullFileList(ghToken, owner, repo, headSha);
        await db.delete(codeChunks).where(eq(codeChunks.repoId, repoId));
      }
    } else {
      // First index
      filesToProcess = await getFullFileList(ghToken, owner, repo, headSha);
    }

    emit({ phase: "fetching", current: 0, total: filesToProcess.length, message: `${filesToProcess.length} archivos a procesar` });

    if (filesToProcess.length === 0) {
      await db.update(codeRepositories).set({
        status: "ready",
        lastIndexedCommit: headSha,
        lastIndexedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(codeRepositories.id, repoId));
      emit({ phase: "done", current: 0, total: 0, message: "Sin cambios" });
      return { repoId, chunksIndexed: 0 };
    }

    // 4. Fetch + parse files
    emit({ phase: "parsing", current: 0, total: filesToProcess.length, message: "Parseando archivos..." });
    const allChunks: (ParsedChunk & { filePath: string; language: string; docstring?: string | null })[] = [];

    // Process files in batches to avoid memory spikes
    const FILE_BATCH = 20;
    for (let i = 0; i < filesToProcess.length; i += FILE_BATCH) {
      const batch = filesToProcess.slice(i, i + FILE_BATCH);
      const contents = await Promise.all(
        batch.map(async (path) => {
          const content = await gh.getFileContent(ghToken, owner, repo, path, headSha);
          return { path, content };
        })
      );

      for (const { path, content } of contents) {
        if (!content || content.length > MAX_FILE_SIZE) continue;
        const result = await parseFileAsync(path, content);
        if (!result || result.chunks.length === 0) continue;
        for (const chunk of result.chunks) {
          allChunks.push({ ...chunk, filePath: path, language: result.language });
        }
      }

      emit({ phase: "parsing", current: Math.min(i + FILE_BATCH, filesToProcess.length), total: filesToProcess.length, message: `Parseados ${Math.min(i + FILE_BATCH, filesToProcess.length)}/${filesToProcess.length}` });
    }

    // Cap total chunks
    const chunks = allChunks.slice(0, MAX_CHUNKS_PER_REPO);
    emit({ phase: "parsing", current: filesToProcess.length, total: filesToProcess.length, message: `${chunks.length} chunks extraídos` });

    if (chunks.length === 0) {
      await db.update(codeRepositories).set({
        status: "ready",
        lastIndexedCommit: headSha,
        lastIndexedAt: new Date(),
        totalChunks: 0,
        updatedAt: new Date(),
      }).where(eq(codeRepositories.id, repoId));
      emit({ phase: "done", current: 0, total: 0, message: "Sin chunks parseables" });
      return { repoId, chunksIndexed: 0 };
    }

    // 5. Generate docstrings (AI batch)
    if (openaiKey) {
      emit({ phase: "docstrings", current: 0, total: chunks.length, message: "Generando docstrings con AI..." });
      await generateDocstrings(chunks, openaiKey, (current) => {
        emit({ phase: "docstrings", current, total: chunks.length, message: `Docstrings: ${current}/${chunks.length}` });
      });
    }

    // 6. Insert chunks into DB
    // Stamp every row with the embedding model label up-front. If embeddingKey is
    // unset, embeddings won't run (BM25-only chunk) but we still pin a model label
    // so the v1↔v2 A/B widget can attribute "no embedding" rows to a real provider
    // intent rather than the schema default.
    const embeddingModelVersion = embeddingKey
      ? resolveEmbeddingModelLabel(embeddingKey)
      : "voyage-code-3";

    const insertBatch = chunks.map((c) => ({
      repoId,
      filePath: c.filePath,
      chunkType: c.chunkType as "function" | "class" | "method" | "module" | "type",
      name: c.name,
      startLine: c.startLine,
      endLine: c.endLine,
      code: c.code.slice(0, 50_000), // cap code size
      docstring: c.docstring ?? null,
      embeddingModelVersion,
      language: c.language,
      dependencies: c.dependencies,
    }));

    // Insert in batches to avoid query size limits
    const DB_BATCH = 100;
    const insertedIds: string[] = [];
    for (let i = 0; i < insertBatch.length; i += DB_BATCH) {
      const batch = insertBatch.slice(i, i + DB_BATCH);
      const rows = await db.insert(codeChunks).values(batch).returning({ id: codeChunks.id });
      insertedIds.push(...rows.map((r) => r.id));
    }

    // 7. Generate embeddings (Voyage Code 3 or local nomic-embed-code)
    if (embeddingKey) {
      emit({ phase: "embeddings", current: 0, total: chunks.length, message: "Generando embeddings..." });
      await generateEmbeddings(insertedIds, chunks, embeddingKey, (current) => {
        emit({ phase: "embeddings", current, total: chunks.length, message: `Embeddings: ${current}/${chunks.length}` });
      });
    }

    // 8. Build dependency graph
    emit({ phase: "dependencies", current: 0, total: 0, message: "Construyendo grafo de dependencias..." });
    await buildDependencyGraph(repoId, insertedIds, chunks);

    // 9. Update repo status
    const totalChunks = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(codeChunks)
      .where(eq(codeChunks.repoId, repoId))
      .then((r) => r[0]?.count ?? 0);

    await db.update(codeRepositories).set({
      status: "ready",
      lastIndexedCommit: headSha,
      lastIndexedAt: new Date(),
      totalChunks,
      updatedAt: new Date(),
    }).where(eq(codeRepositories.id, repoId));

    emit({ phase: "done", current: chunks.length, total: chunks.length, message: `Indexación completada: ${chunks.length} chunks` });

    return { repoId, chunksIndexed: chunks.length };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : "Unknown error";
    const msg = sanitizeError(rawMsg);
    await db.update(codeRepositories).set({
      status: "failed",
      errorMessage: msg,
      updatedAt: new Date(),
    }).where(eq(codeRepositories.id, repoId));
    emit({ phase: "error", current: 0, total: 0, message: msg });
    throw error;
  }
}

// ── File listing ─────────────────────────────────────────────────────────────

async function getFullFileList(token: string, owner: string, repo: string, ref: string): Promise<string[]> {
  const allFiles = await gh.getRepoTree(token, owner, repo, ref);
  return allFiles
    .filter((f) => !shouldSkipFile(f) && detectLanguage(f) !== null)
    .slice(0, MAX_FILES);
}

async function getChangedFiles(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string[] | null> {
  try {
    const API = "https://api.github.com";
    const res = await fetch(`${API}/repos/${owner}/${repo}/compare/${base}...${head}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "InariWatch-CodeIntel/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.files ?? []).map((f: { filename: string }) => f.filename);
  } catch {
    return null;
  }
}

// ── Docstring generation ─────────────────────────────────────────────────────

const DOCSTRING_SYSTEM = `You are a code documentation expert. Given a batch of code chunks, generate a concise natural language description for each one.

For each chunk, write 1-3 sentences that describe:
- What the code does (purpose)
- Key inputs/outputs
- Important side effects or dependencies

Respond with a JSON array of strings, one description per chunk, in the same order as the input.
Keep descriptions under 200 words each. Be precise and technical.`;

async function generateDocstrings(
  chunks: (ParsedChunk & { filePath: string; language: string; docstring?: string | null })[],
  apiKey: string,
  onProgress: (n: number) => void
) {
  for (let i = 0; i < chunks.length; i += DOCSTRING_BATCH_SIZE) {
    const batch = chunks.slice(i, i + DOCSTRING_BATCH_SIZE);

    const prompt = batch
      .map((c, idx) => `[${idx}] ${c.language} ${c.chunkType} "${c.name}" in ${c.filePath}:\n\`\`\`\n${c.code.slice(0, 3000)}\n\`\`\``)
      .join("\n\n");

    try {
      const response = await callAI(apiKey, DOCSTRING_SYSTEM, [{ role: "user", content: prompt }], {
        maxTokens: 2048,
        model: "gpt-4o-mini",
        timeout: 60000,
        provider: "openai",
      });

      // Parse JSON array from response
      const cleaned = response.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const descriptions: string[] = JSON.parse(cleaned);

      for (let j = 0; j < batch.length && j < descriptions.length; j++) {
        batch[j].docstring = descriptions[j];
      }
    } catch (err) {
      // If AI fails for this batch, leave docstrings null — embeddings will use code directly.
      // Phase 0.4: surface the failure so the v1 baseline widget can attribute
      // missing docstrings to provider issues vs. cost-saving omission.
      logCodeIntelEvent({
        event: "indexer.docstring_batch_failed",
        severity: "warn",
        provider: "openai",
        detail: {
          batchOffset: i,
          batchSize: batch.length,
          model: "gpt-4o-mini",
        },
        error: err,
      });
    }

    onProgress(Math.min(i + DOCSTRING_BATCH_SIZE, chunks.length));
  }
}

// ── Embedding generation ─────────────────────────────────────────────────────

async function generateEmbeddings(
  chunkIds: string[],
  chunks: (ParsedChunk & { filePath: string; language: string; docstring?: string | null })[],
  apiKey: string,
  onProgress: (n: number) => void
) {
  for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchIds = chunkIds.slice(i, i + EMBEDDING_BATCH_SIZE);

    // Use docstring if available, otherwise use truncated code
    const texts = batchChunks.map((c) => {
      const base = c.docstring ?? c.code.slice(0, 2000);
      return `${c.language} ${c.chunkType} ${c.name} in ${c.filePath}:\n${base}`;
    });

    try {
      // Uses Voyage Code 3 if key starts with pa-, otherwise OpenAI fallback.
      // embedTextsWithModel returns the resolved model label so we can stamp
      // every updated row with the EXACT model that produced its vector,
      // even if the active model differs from the schema default.
      const { vectors, modelVersion } = await embedTextsWithModel(texts, apiKey, "document");

      // Update chunks with embeddings in batches
      for (let j = 0; j < vectors.length; j++) {
        const vec = `[${vectors[j].join(",")}]`;
        await db.execute(
          sql`UPDATE code_chunks
              SET embedding = ${vec}::vector,
                  embedding_model_version = ${modelVersion}
              WHERE id = ${batchIds[j]}::uuid`
        );
      }
    } catch (err) {
      // If embedding fails, chunks still work for BM25 search.
      // embedding_model_version remains as set on insert (caller's intent).
      // Phase 0.4: surface so /admin/ops can flag low embedding coverage as
      // a provider outage rather than a config gap.
      logCodeIntelEvent({
        event: "indexer.embedding_batch_failed",
        severity: "error",
        provider: resolveEmbeddingModelLabel(apiKey),
        detail: {
          batchOffset: i,
          batchSize: batchChunks.length,
        },
        error: err,
      });
    }

    onProgress(Math.min(i + EMBEDDING_BATCH_SIZE, chunks.length));
  }
}

// ── Dependency graph ─────────────────────────────────────────────────────────

async function buildDependencyGraph(
  repoId: string,
  chunkIds: string[],
  chunks: (ParsedChunk & { filePath: string; language: string })[]
) {
  // Build name→id lookup for this repo's chunks
  const nameToId = new Map<string, string>();
  for (let i = 0; i < chunks.length; i++) {
    nameToId.set(chunks[i].name, chunkIds[i]);
    // Also store with file prefix for disambiguation
    nameToId.set(`${chunks[i].filePath}:${chunks[i].name}`, chunkIds[i]);
  }

  const edges: { sourceChunkId: string; targetChunkId: string; dependencyType: "calls" | "imports" | "extends" | "implements" }[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const sourceId = chunkIds[i];

    for (const dep of chunk.dependencies) {
      const targetId = nameToId.get(dep);
      if (targetId && targetId !== sourceId) {
        edges.push({
          sourceChunkId: sourceId,
          targetChunkId: targetId,
          dependencyType: "calls",
        });
      }
    }
  }

  // Insert edges in batches
  if (edges.length > 0) {
    // First clean old edges for this repo's chunks
    await db.execute(sql`
      DELETE FROM code_dependencies
      WHERE source_chunk_id IN (
        SELECT id FROM code_chunks WHERE repo_id = ${repoId}::uuid
      )
    `);

    const EDGE_BATCH = 200;
    for (let i = 0; i < edges.length; i += EDGE_BATCH) {
      const batch = edges.slice(i, i + EDGE_BATCH);
      await db.insert(codeDependencies).values(batch);
    }
  }
}
