/**
 * Structural code context extraction for AI prompts.
 *
 * Primary path: regex-based line walker — zero deps, <1 ms, works in every
 *   environment including serverless.
 *
 * Enhancement path: web-tree-sitter WASM — more accurate, loaded lazily and
 *   cached. Silently falls back to regex when the grammar WASM isn't
 *   compatible with the installed runtime (e.g. tree-sitter-wasms 0.1.x vs
 *   web-tree-sitter 0.26+). The two packages will re-align in a future
 *   tree-sitter-wasms release; no code change needed at that point.
 */

import { join } from "path";

export interface ASTContext {
  enclosingFunction: string | null;
  enclosingClass: string | null;
  enclosingTryCatch: boolean;
  nearbyImports: string[];
  callExpression: string | null;
  errorLine: number;
}

export type SupportedLanguage = "typescript" | "javascript" | "tsx" | "jsx";

const LANG_TO_WASM: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
};

// ── WASM singleton (optional enhancement) ────────────────────────────────────

let _wasmReady: boolean | null = null;
let _parser: unknown = null;
const _grammarCache = new Map<string, unknown>();

async function ensureWasm(): Promise<boolean> {
  if (_wasmReady !== null) return _wasmReady;
  try {
    const mod = await import("web-tree-sitter");
    // v0.26.x: named exports — Parser is at mod.Parser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PC = (mod as any).Parser as { init: () => Promise<void>; new(): unknown } | undefined;
    if (!PC || typeof PC.init !== "function") { _wasmReady = false; return false; }
    await PC.init();
    _parser = new PC();
    _wasmReady = true;
    return true;
  } catch {
    _wasmReady = false;
    return false;
  }
}

async function loadGrammar(wasmFile: string): Promise<unknown | null> {
  const hit = _grammarCache.get(wasmFile);
  if (hit) return hit;
  try {
    const mod = await import("web-tree-sitter");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Language = (mod as any).Language as { load: (p: string) => Promise<unknown> } | undefined;
    if (!Language || typeof Language.load !== "function") return null;
    const wasmPath = join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmFile);
    const grammar = await Language.load(wasmPath);
    _grammarCache.set(wasmFile, grammar);
    return grammar;
  } catch {
    return null;
  }
}

// ── Regex-based extraction (primary path) ─────────────────────────────────────

function trunc(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

/**
 * Return the 0-based line index of the `}` that closes the try-block opening
 * at tryIdx. Stops at the character-level so `} catch {` on the same line
 * doesn't re-open depth before we record the close.
 */
function findTryBodyEnd(lines: string[], tryIdx: number): number {
  let depth = 0;
  for (let i = tryIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0 && i > tryIdx) return i;
      }
    }
  }
  return -1;
}

function regexExtract(
  lines: string[],
  errorLineIdx: number,
): Omit<ASTContext, "nearbyImports" | "errorLine"> {
  const targetLine = lines[errorLineIdx] ?? "";

  // Call expression on the error line — first `identifier(` that looks like a method call
  const callRaw = targetLine.match(/\b([a-zA-Z_$][\w$.]*)\s*\(/);
  const callExpression = callRaw ? callRaw[1] + "()" : null;

  let enclosingFunction: string | null = null;
  let enclosingClass: string | null = null;
  let enclosingTryCatch = false;

  // Walk backwards tracking brace depth relative to the error line.
  // Going backwards: "}" means we just exited a scope (depth++), "{" means
  // we entered a scope (depth--). When depth < 0 we've crossed into an
  // outer block.
  let depth = 0;

  for (let i = errorLineIdx; i >= 0; i--) {
    const line = lines[i];

    // Count braces — simplified (doesn't handle strings/comments, good enough
    // for 95 %+ of real TypeScript)
    const countLine = i === errorLineIdx ? "" : line; // skip error line itself
    for (const ch of countLine) {
      if (ch === "}") depth++;
      else if (ch === "{") depth--;
    }

    // When depth < 0 we've crossed into the block that opens here
    if (depth < 0) {
      const trimmed = line.trimStart();

      // Function — catches: function foo, async function, method() {, foo() {
      if (!enclosingFunction) {
        if (
          /(?:^|\s)(?:async\s+)?function[\s*]/.test(trimmed) ||
          /(?:^|\s)(?:async\s+)?\w+\s*\(.*\)\s*(?::\s*\S+\s*)?\{/.test(line) ||
          /=>\s*\{/.test(line)
        ) {
          enclosingFunction = trunc(line.trim().replace(/\s*\{[^}]*$/, "").trim());
        }
      }

      // Class
      if (!enclosingClass && /(?:^|\s)class\s+\w/.test(trimmed)) {
        const m = trimmed.match(/class\s+(\w+)/);
        enclosingClass = m ? `class ${m[1]}` : trunc(trimmed);
      }

      // Try block — only set if error line is inside the try body, not catch
      if (!enclosingTryCatch && /^\s*try\s*\{/.test(line)) {
        const tryBodyEnd = findTryBodyEnd(lines, i);
        if (tryBodyEnd === -1 || errorLineIdx <= tryBodyEnd) {
          enclosingTryCatch = true;
        }
      }

      // Reset depth for the next outer level
      depth = 0;
    }
  }

  return { enclosingFunction, enclosingClass, enclosingTryCatch, callExpression };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Infer supported language from file extension, or null for unsupported types. */
export function inferLanguage(filePath: string): SupportedLanguage | null {
  if (filePath.endsWith(".ts")) return "typescript";
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "javascript";
  if (filePath.endsWith(".jsx")) return "jsx";
  return null;
}

/**
 * Scan a stack trace for the first occurrence of `filePath` and return its
 * 1-based line number. Returns null if the file is not mentioned.
 */
export function extractErrorLineForFile(stackTrace: string, filePath: string): number | null {
  const name = filePath.split("/").pop()!;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`[/\\\\]?${escaped}:(\\d+)(?::\\d+)?`, "m");
  const m = re.exec(stackTrace);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract structural AST context for the given line in a source file.
 *
 * Uses regex extraction (always available). WASM path is attempted first
 * when the runtime supports it, but the result is always non-null as long
 * as the file is non-empty and errorLine is in range.
 *
 * Returns null only when errorLine is out of range or content is too large.
 * Never throws.
 */
export async function extractASTContext(
  fileContent: string,
  errorLine: number,
  language: SupportedLanguage,
): Promise<ASTContext | null> {
  if (errorLine < 1 || fileContent.length > 500_000) return null;

  const lines = fileContent.split("\n");
  if (errorLine > lines.length) return null;

  const errorLineIdx = errorLine - 1; // 0-based

  // Nearby imports (same regardless of parse strategy)
  const nearbyImports: string[] = [];
  const importRe = /^import\s+.*from\s+['"]([^'"]+)['"]/gm;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(fileContent)) !== null && nearbyImports.length < 5) {
    if (im[1].startsWith("./") || im[1].startsWith("../") || im[1].startsWith("@/")) {
      nearbyImports.push(im[1]);
    }
  }

  // ── Try WASM path (optional enhancement) ─────────────────────────────────
  try {
    if (await ensureWasm() && _parser) {
      const wasmFile = LANG_TO_WASM[language];
      let grammar = await loadGrammar(wasmFile);
      if (!grammar && language === "tsx") grammar = await loadGrammar("tree-sitter-typescript.wasm");

      if (grammar) {
        type TSNode = {
          type: string;
          text: string;
          startPosition: { row: number; column: number };
          endPosition: { row: number; column: number };
          startIndex: number;
          endIndex: number;
          parent: TSNode | null;
          child: (i: number) => TSNode | null;
          childForFieldName: (f: string) => TSNode | null;
          descendantForPosition: (p: { row: number; column: number }) => TSNode | null;
        };
        type AnyParser = {
          setLanguage: (l: unknown) => void;
          parse: (s: string) => { rootNode: TSNode; delete: () => void };
        };

        const FUNCTION_TYPES = new Set([
          "function_declaration", "function_expression", "arrow_function",
          "method_definition", "generator_function_declaration", "generator_function",
        ]);
        const CLASS_TYPES = new Set(["class_declaration", "class"]);

        const p = _parser as AnyParser;
        p.setLanguage(grammar);
        const tree = p.parse(fileContent);
        const root = tree.rootNode;

        const targetRow = errorLineIdx;
        const errorNode = root.descendantForPosition({ row: targetRow, column: 0 });
        if (errorNode) {
          let enclosingFunction: string | null = null;
          let enclosingClass: string | null = null;
          let enclosingTryCatch = false;
          let callExpression: string | null = null;

          let cur: TSNode | null = errorNode;
          while (cur) {
            const t = cur.type;
            if (!enclosingFunction && FUNCTION_TYPES.has(t)) {
              let sig = cur.text.split("\n")[0].trim();
              // For arrow functions, try to get the variable name too
              if (t === "arrow_function" && cur.parent?.type === "variable_declarator") {
                const decl = cur.parent;
                const lex = decl.parent;
                const src = (lex?.type === "lexical_declaration" ? lex : decl).text;
                sig = src.split("\n")[0].trim();
              }
              enclosingFunction = trunc(sig);
            }
            if (!enclosingClass && CLASS_TYPES.has(t)) {
              const line2 = cur.text.split("\n")[0].trim();
              const m2 = line2.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
              enclosingClass = m2 ? `class ${m2[1]}` : trunc(line2);
            }
            if (!enclosingTryCatch && t === "try_statement") {
              const handler = cur.childForFieldName("handler");
              const finalizer = cur.childForFieldName("finalizer");
              const beforeCatch = !handler || targetRow < handler.startPosition.row;
              const beforeFinally = !finalizer || targetRow < finalizer.startPosition.row;
              if (beforeCatch && beforeFinally) enclosingTryCatch = true;
            }
            if (!callExpression && t === "call_expression" && cur.startPosition.row === targetRow) {
              const callee = cur.child(0);
              const text = (callee ?? cur).text.split("\n")[0].trim();
              callExpression = trunc(text) + (callee ? "()" : "");
            }
            cur = cur.parent;
          }

          tree.delete();
          return { enclosingFunction, enclosingClass, enclosingTryCatch, nearbyImports, callExpression, errorLine };
        }
        tree.delete();
      }
    }
  } catch {
    // WASM path failed — fall through to regex
  }

  // ── Regex fallback (always works) ─────────────────────────────────────────
  const { enclosingFunction, enclosingClass, enclosingTryCatch, callExpression } =
    regexExtract(lines, errorLineIdx);

  return { enclosingFunction, enclosingClass, enclosingTryCatch, nearbyImports, callExpression, errorLine };
}
