/**
 * Local embedding inference via nomic-ai/nomic-embed-code (ONNX).
 *
 * Runs inside a worker_threads thread so the CPU-bound ONNX inference
 * (~20-50ms per text) never blocks the Next.js event loop.
 *
 * Model: nomic-ai/nomic-embed-code
 *   Output dimensions : 768
 *   Quantized ONNX    : ~65 MB (loaded once, stays in worker memory)
 *   Full ONNX         : ~262 MB
 *
 * Docker / Hetzner cache — model downloads once from HuggingFace Hub.
 * Mount a named volume so the download survives container restarts:
 *   docker run -v transformers_cache:/root/.cache/huggingface ...
 * Override the path with TRANSFORMERS_CACHE=/your/path env var.
 */

import { Worker } from "worker_threads";

export const LOCAL_EMBED_MODEL = "nomic-ai/nomic-embed-code";
export const LOCAL_EMBED_DIMS = 768;

type PendingRequest = {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
};

let _worker: Worker | null = null;
const _pending = new Map<string, PendingRequest>();
let _reqId = 0;

// CJS worker: uses dynamic import() to load the ESM @xenova/transformers package.
// Texts are processed one-at-a-time for model compatibility (no batching assumptions).
const WORKER_CODE = `
const { parentPort } = require('worker_threads');
let _pipe = null;
let _initPromise = null;

function ensurePipeline() {
  if (_pipe) return Promise.resolve(_pipe);
  if (!_initPromise) {
    _initPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      _pipe = await pipeline('feature-extraction', '${LOCAL_EMBED_MODEL}', { quantized: true });
      return _pipe;
    })();
  }
  return _initPromise;
}

parentPort.on('message', async ({ id, texts }) => {
  try {
    const pipe = await ensurePipeline();
    const vectors = [];
    for (const text of texts) {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(out.data));
    }
    parentPort.postMessage({ id, vectors });
  } catch (err) {
    parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
});
`;

function getWorker(): Worker {
  if (_worker) return _worker;

  const w = new Worker(WORKER_CODE, { eval: true });

  w.on("message", ({ id, vectors, error }: { id: string; vectors?: number[][]; error?: string }) => {
    const req = _pending.get(id);
    if (!req) return;
    _pending.delete(id);
    if (error !== undefined) {
      req.reject(new Error(`Local embedding worker: ${error}`));
    } else {
      req.resolve(vectors!);
    }
  });

  w.on("error", (err: Error) => {
    const msg = `Embedding worker crashed: ${err.message}`;
    for (const [id, req] of _pending) {
      req.reject(new Error(msg));
      _pending.delete(id);
    }
    _worker = null;
  });

  w.on("exit", (code: number) => {
    if (code !== 0) {
      const msg = `Embedding worker exited with code ${code}`;
      for (const [id, req] of _pending) {
        req.reject(new Error(msg));
        _pending.delete(id);
      }
      _worker = null;
    }
  });

  _worker = w;
  return w;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const id = String(++_reqId);
  const worker = getWorker();
  return new Promise<number[][]>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, texts });
  });
}

export async function embed(text: string): Promise<number[]> {
  const [vec] = await embedBatch([text]);
  return vec;
}
