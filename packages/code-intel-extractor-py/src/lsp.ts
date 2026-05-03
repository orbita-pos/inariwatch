// Minimal LSP client for pyright-langserver --stdio.
//
// Phase 2.1 confirmed pyright-langserver as the integration mode (see README).
// This module owns the JSON-RPC framing, request/response correlation, and
// notification fan-out. Phase 2.2 builds the extractor on top.
//
// Why hand-rolled? Adding `vscode-jsonrpc` would force `npm install` in a
// worktree that uses a junctioned node_modules — and the Content-Length
// framing is ~50 lines. Keeping the dep surface small also keeps the
// extractor portable to environments where running `npm i` is awkward
// (Hetzner worker, container-agent's gVisor sandbox).
//
// Pyright-langserver implements the standard LSP. We only use a subset:
//
//   - `initialize` / `initialized` / `shutdown` / `exit`     — lifecycle
//   - `textDocument/didOpen`                                  — hand pyright a file
//   - `textDocument/documentSymbol`                           — symbols
//   - `textDocument/hover`                                    — type info
//   - `textDocument/references`                               — use-sites
//   - `textDocument/definition` / `typeDefinition`            — cross-file links
//   - `workspace/didChangeConfiguration`                      — push config
//
// Server-originated notifications (window/logMessage, publishDiagnostics) are
// captured into a buffer and ignored by default; tests can inspect them via
// `getLogs()` if needed.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";

// Subset of LSP types we actually use. Keeping these inline (instead of
// pulling vscode-languageserver-types) avoids a runtime/devdep + matches
// the no-extra-deps stance documented in the README.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

/**
 * Per LSP spec — DocumentSymbol when the server supports hierarchical symbols,
 * SymbolInformation otherwise. Pyright returns the flat (SymbolInformation)
 * shape with `containerName`. We model the union and let the extractor
 * normalize.
 */
export interface SymbolInformation {
  name: string;
  /**
   * LSP `SymbolKind` — see https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
   * 5 = Class, 6 = Method, 12 = Function, 13 = Variable, 14 = Constant,
   * 9 = Constructor, 10 = Enum, 11 = Interface, 22 = EnumMember, 23 = Struct,
   * 26 = TypeParameter, etc.
   */
  kind: number;
  location: Location;
  containerName?: string;
  deprecated?: boolean;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
  deprecated?: boolean;
}

export type DocumentSymbolResult = SymbolInformation[] | DocumentSymbol[];

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export interface Hover {
  contents: MarkupContent | string | Array<MarkupContent | string>;
  range?: Range;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type IncomingMessage = JsonRpcResponse | JsonRpcNotification;

export interface PyrightLspClientOptions {
  /**
   * Absolute path to `pyright/dist/pyright-langserver.js`. If omitted, the
   * client resolves it from the workspace via `require.resolve("pyright/package.json")`
   * and walks to `dist/pyright-langserver.js`.
   */
  langserverPath?: string;
  /**
   * Working directory for the spawned langserver. Pyright reads
   * `pyrightconfig.json` / `pyproject.toml` from the rootUri sent in
   * `initialize`, so this rarely matters — but if a target repo relies on
   * relative paths in its config, this matches IDE behavior.
   */
  cwd?: string;
  /**
   * Optional rootUri for `initialize`. Defaults to `null` (per LSP spec —
   * server falls back to the file's own dir).
   */
  rootUri?: string | null;
  /**
   * Per-request timeout in ms. Default 20s. Pyright cold-start + first
   * `documentSymbol` on Windows can take ~1s; subsequent calls are sub-100ms.
   */
  requestTimeoutMs?: number;
}

export interface ServerLogMessage {
  /** LSP `MessageType`: 1=error, 2=warning, 3=info, 4=log */
  type: number;
  message: string;
}

export class PyrightLspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly logs: ServerLogMessage[] = [];
  private startedAt = 0;
  private readonly opts: Required<Omit<PyrightLspClientOptions, "langserverPath" | "cwd" | "rootUri">> & {
    langserverPath: string | undefined;
    cwd: string | undefined;
    rootUri: string | null;
  };

  constructor(options: PyrightLspClientOptions = {}) {
    this.opts = {
      langserverPath: options.langserverPath,
      cwd: options.cwd,
      rootUri: options.rootUri ?? null,
      requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
    };
  }

  /**
   * Spawn pyright-langserver and complete the LSP handshake (initialize +
   * initialized). Resolves once the server is ready to accept document
   * requests.
   */
  async start(): Promise<void> {
    if (this.proc) throw new Error("PyrightLspClient: already started");
    const langserverPath = this.opts.langserverPath ?? resolveLangserverPath();
    this.proc = spawn(process.execPath, [langserverPath, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
    }) as ChildProcessWithoutNullStreams;
    this.startedAt = Date.now();
    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      // Pyright prints warm-up info on stderr; capture but don't fail.
      this.logs.push({ type: 4, message: `[stderr] ${chunk.toString().trimEnd()}` });
    });
    this.proc.on("error", (err) => this.failAllPending(err));
    this.proc.on("exit", (code, signal) => {
      const reason = code != null ? `code=${code}` : `signal=${signal}`;
      this.failAllPending(new Error(`pyright-langserver exited (${reason})`));
    });

    await this.request<unknown>("initialize", {
      processId: process.pid,
      rootUri: this.opts.rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: false,
          },
          hover: { contentFormat: ["plaintext"] },
          references: { dynamicRegistration: false },
        },
      },
    });
    this.notify("initialized", {});
  }

  /** Send `shutdown` + `exit`, then kill the process. Idempotent. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request<unknown>("shutdown", null);
    } catch {
      // Server may have already crashed; we still want to kill it.
    }
    try {
      this.notify("exit", null);
    } catch {
      // ignore
    }
    const proc = this.proc;
    this.proc = null;
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        res();
      }, 500);
      proc.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
    // Reject anything that was still waiting.
    this.failAllPending(new Error("pyright-langserver: client stopped"));
  }

  /** Hand pyright a file to analyze. */
  didOpen(uri: string, languageId: string, text: string, version = 1): void {
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /** Notify pyright the file is no longer needed. Releases its caches. */
  didClose(uri: string): void {
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** Document-level symbol list — the basis of `code_symbols` rows. */
  async documentSymbol(uri: string): Promise<DocumentSymbolResult> {
    const result = await this.request<DocumentSymbolResult | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
    return result ?? [];
  }

  /** Hover info at a position — used to extract signatures and return types. */
  async hover(uri: string, position: Position): Promise<Hover | null> {
    const result = await this.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    return result;
  }

  /** Use-sites for the symbol at a position. */
  async references(
    uri: string,
    position: Position,
    includeDeclaration = true,
  ): Promise<Location[]> {
    const result = await this.request<Location[] | null>(
      "textDocument/references",
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration },
      },
    );
    return result ?? [];
  }

  /** Cross-file definition link for the symbol at a position. */
  async definition(uri: string, position: Position): Promise<Location | Location[] | null> {
    return await this.request<Location | Location[] | null>(
      "textDocument/definition",
      { textDocument: { uri }, position },
    );
  }

  /** Drain captured `window/logMessage` notifications. */
  getLogs(): ServerLogMessage[] {
    return this.logs.slice();
  }

  /** Wall-clock ms since `start()` resolved. Useful for debugging cold-start. */
  uptimeMs(): number {
    return this.startedAt > 0 ? Date.now() - this.startedAt : 0;
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed framing — skip the bad bytes and try again.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1]!, 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(body) as IncomingMessage;
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: IncomingMessage): void {
    if ("id" in msg && typeof msg.id === "number") {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) {
        slot.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        slot.resolve(msg.result);
      }
      return;
    }
    if ("method" in msg) {
      // Server notification or request. We capture log messages and discard
      // the rest (we don't implement any reverse handlers).
      if (msg.method === "window/logMessage" && msg.params && typeof msg.params === "object") {
        const p = msg.params as { type?: number; message?: string };
        this.logs.push({ type: p.type ?? 4, message: p.message ?? "" });
      }
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.proc) throw new Error("PyrightLspClient: not started");
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method} (${this.opts.requestTimeoutMs}ms)`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send(req);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc) throw new Error("PyrightLspClient: not started");
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.send(note);
  }

  private send(payload: JsonRpcRequest | JsonRpcNotification): void {
    const json = JSON.stringify(payload);
    const framed = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    this.proc!.stdin.write(framed);
  }

  private failAllPending(err: Error): void {
    for (const [id, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(err);
      this.pending.delete(id);
    }
  }
}

/** Exposed for tests so they can use the same resolution logic. */
export function resolveLangserverPath(): string {
  // `import.meta.url` would work too, but `createRequire(__filename-equiv)`
  // gives us node's normal hoisted-module resolution which is what users get.
  const req = createRequire(import.meta.url);
  // `pyright/package.json` is guaranteed to be in the package root; we walk
  // to dist/pyright-langserver.js from there. This works whether pyright is
  // installed in this package's node_modules or hoisted to a parent.
  const pkgJson = req.resolve("pyright/package.json");
  // Replace the trailing `package.json` with `dist/pyright-langserver.js`.
  const parent = pkgJson.replace(/[\\/]package\.json$/, "");
  return `${parent}/dist/pyright-langserver.js`;
}

/**
 * Convert a filesystem path to an LSP-compatible `file://` URI. Handles the
 * Windows drive-letter encoding pyright expects (`file:///c%3A/...`).
 */
export function pathToFileUri(absPath: string): string {
  const fwd = absPath.replace(/\\/g, "/");
  // Already a URI? pass through.
  if (/^file:\/\//i.test(fwd)) return fwd;
  // Drive letter on Windows: encode the colon and ensure the triple slash.
  const driveMatch = /^([a-zA-Z]):(.*)$/.exec(fwd);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = driveMatch[2]!;
    return `file:///${drive}%3A${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  // Posix-style absolute path.
  return `file://${fwd.startsWith("/") ? fwd : `/${fwd}`}`;
}

/** Inverse of `pathToFileUri`. Returns a forward-slashed absolute path. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let body = uri.slice("file://".length);
  // Strip a leading slash before a drive letter on Windows.
  const driveMatch = /^\/([a-zA-Z])(?:%3A|:)(.*)$/i.exec(body);
  if (driveMatch) {
    body = `${driveMatch[1]!.toUpperCase()}:${driveMatch[2]!}`;
  } else if (body.startsWith("/")) {
    // Posix path stays as-is (with the leading slash).
  }
  // Decode %XX escapes.
  try {
    body = decodeURI(body);
  } catch {
    // ignore decode failure — return the raw body.
  }
  return body;
}
