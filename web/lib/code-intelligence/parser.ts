/**
 * Code parser — tree-sitter WASM (AST) with regex fallback.
 *
 * Primary: web-tree-sitter for precise AST parsing (TS/JS/Python/Go/Rust/Java)
 * Fallback: regex-based heuristics if WASM fails to load
 */

import type { Parser as TSParser, Language as TSLanguage, Node as TSNode } from "web-tree-sitter";
import { join } from "path";

export type ChunkType = "function" | "class" | "method" | "module" | "type";

export interface ParsedChunk {
  name: string;
  chunkType: ChunkType;
  startLine: number;
  endLine: number;
  code: string;
  dependencies: string[];
}

export interface ParseResult {
  chunks: ParsedChunk[];
  imports: string[];
  language: string;
}

// ── Language detection ───────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

export function detectLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

// ── File blocklist ───────────────────────────────────────────────────────────

const SKIP_PATTERNS = [
  /^\.env/i, /node_modules\//, /\.lock$/, /lock\.json$/, /lock\.yaml$/,
  /\.lockb$/, /\.min\.(js|css)$/, /\.(map|d\.ts)$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i,
  /\.(pdf|zip|tar|gz|bin|exe|dll|so|dylib)$/i,
  /vendor\//, /dist\//, /build\//, /\.next\//, /coverage\//,
  /\.git\//, /__pycache__\//, /\.pyc$/,
];

export function shouldSkipFile(path: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(path));
}

// ── Guards ───────────────────────────────────────────────────────────────────

const MAX_LINES = 20_000;
const MAX_CHUNKS_PER_FILE = 500;
const MAX_DEPS_PER_CHUNK = 200;

// ── Tree-sitter WASM file mapping ────────────────────────────────────────────

const LANG_WASM: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
};

// ── Singleton initialization ─────────────────────────────────────────────────

let tsParser: TSParser | null = null;
let initPromise: Promise<boolean> | null = null;
const langCache = new Map<string, TSLanguage>();

async function ensureParser(): Promise<TSParser | null> {
  if (tsParser) return tsParser;
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const TreeSitter = await import("web-tree-sitter");
        const ParserClass = (TreeSitter.default ?? TreeSitter) as unknown as {
          init: () => Promise<void>;
          new(): TSParser;
        };
        await ParserClass.init();
        tsParser = new ParserClass();
        return true;
      } catch {
        return false;
      }
    })();
  }
  await initPromise;
  return tsParser;
}

async function loadLanguage(lang: string): Promise<TSLanguage | null> {
  const cached = langCache.get(lang);
  if (cached) return cached;

  const wasmFile = LANG_WASM[lang];
  if (!wasmFile) return null;

  try {
    const TreeSitter = await import("web-tree-sitter");
    const LanguageClass = (TreeSitter.default ?? TreeSitter) as unknown as {
      Language: { load: (path: string) => Promise<TSLanguage> };
    };
    const wasmPath = join(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmFile);
    const language = await LanguageClass.Language.load(wasmPath);
    langCache.set(lang, language);
    return language;
  } catch {
    return null;
  }
}

// ── Main entry points ────────────────────────────────────────────────────────

/** Async parse — uses tree-sitter WASM, falls back to regex. */
export async function parseFileAsync(
  filePath: string,
  content: string
): Promise<ParseResult | null> {
  const language = detectLanguage(filePath);
  if (!language || content.length > 500_000) return null;

  const lines = content.split("\n");
  if (lines.length > MAX_LINES) return null;

  // Try tree-sitter first
  const parser = await ensureParser();
  if (parser) {
    const lang = await loadLanguage(language);
    if (lang) {
      const result = parseWithTreeSitter(parser, lang, content, language);
      if (result && result.chunks.length > 0) {
        if (result.chunks.length > MAX_CHUNKS_PER_FILE) {
          result.chunks = result.chunks.slice(0, MAX_CHUNKS_PER_FILE);
        }
        return result;
      }
    }
  }

  // Fallback to regex
  const { parseFileRegex } = await import("./parser-regex");
  return parseFileRegex(filePath, content);
}

/** Sync parse — regex only (backward compat). */
export function parseFile(filePath: string, content: string): ParseResult | null {
  const language = detectLanguage(filePath);
  if (!language || content.length > 500_000) return null;
  if (content.split("\n").length > MAX_LINES) return null;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseFileRegex } = require("./parser-regex") as { parseFileRegex: typeof import("./parser-regex").parseFileRegex };
  return parseFileRegex(filePath, content);
}

// ── Tree-sitter parsing ──────────────────────────────────────────────────────

function parseWithTreeSitter(
  parser: TSParser,
  language: TSLanguage,
  content: string,
  lang: string
): ParseResult | null {
  (parser as unknown as { setLanguage: (l: TSLanguage) => void }).setLanguage(language);
  const tree = (parser as unknown as { parse: (s: string) => { rootNode: TSNode; delete: () => void } }).parse(content);
  const root = tree.rootNode;

  const chunks: ParsedChunk[] = [];
  const imports: string[] = [];

  visitNode(root, chunks, imports, lang);
  tree.delete();

  return { chunks, imports, language: lang };
}

// ── AST visitor ──────────────────────────────────────────────────────────────

function visitNode(node: TSNode, chunks: ParsedChunk[], imports: string[], lang: string): void {
  if (chunks.length >= MAX_CHUNKS_PER_FILE) return;

  const type = node.type;

  // Imports
  if (isImportNode(type, lang)) {
    const p = extractImportPath(node, lang);
    if (p) imports.push(p);
  }

  // Functions
  if (isFunctionNode(type, lang)) {
    const name = extractName(node, lang, "function");
    if (name) {
      chunks.push(makeChunk(name, "function", node, lang));
      return;
    }
  }

  // Classes / impl blocks
  if (isClassNode(type, lang)) {
    const name = extractName(node, lang, "class");
    if (name) {
      chunks.push(makeChunk(name, "class", node, lang));
      extractMethods(node, chunks, lang);
      return;
    }
  }

  // Types / interfaces
  if (isTypeNode(type, lang)) {
    const name = extractName(node, lang, "type");
    if (name) {
      chunks.push(makeChunk(name, "type", node, lang));
      return;
    }
  }

  // Recurse
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) visitNode(child, chunks, imports, lang);
  }
}

function makeChunk(name: string, chunkType: ChunkType, node: TSNode, lang: string): ParsedChunk {
  return {
    name,
    chunkType,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    code: node.text.slice(0, 50_000),
    dependencies: extractDepsFromNode(node),
  };
}

// ── Node matchers ────────────────────────────────────────────────────────────

function isImportNode(t: string, l: string): boolean {
  if (l === "typescript" || l === "javascript") return t === "import_statement";
  if (l === "python") return t === "import_statement" || t === "import_from_statement";
  if (l === "go") return t === "import_declaration" || t === "import_spec";
  if (l === "rust") return t === "use_declaration";
  if (l === "java") return t === "import_declaration";
  return false;
}

function isFunctionNode(t: string, l: string): boolean {
  if (l === "typescript" || l === "javascript")
    return t === "function_declaration" || t === "export_statement" || t === "lexical_declaration";
  if (l === "python") return t === "function_definition";
  if (l === "go") return t === "function_declaration";
  if (l === "rust") return t === "function_item";
  if (l === "java") return t === "method_declaration" || t === "constructor_declaration";
  return false;
}

function isClassNode(t: string, l: string): boolean {
  if (l === "typescript" || l === "javascript") return t === "class_declaration";
  if (l === "python") return t === "class_definition";
  if (l === "rust") return t === "impl_item";
  if (l === "java") return t === "class_declaration";
  return false;
}

function isTypeNode(t: string, l: string): boolean {
  if (l === "typescript") return t === "interface_declaration" || t === "type_alias_declaration";
  if (l === "go") return t === "type_declaration";
  if (l === "rust") return t === "struct_item" || t === "enum_item" || t === "trait_item";
  if (l === "java") return t === "interface_declaration" || t === "enum_declaration";
  return false;
}

// ── Name extraction ──────────────────────────────────────────────────────────

function extractName(node: TSNode, lang: string, _kind: string): string | null {
  // TS/JS export → drill into declaration
  if ((lang === "typescript" || lang === "javascript") && node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl) return extractName(decl, lang, _kind);
    return null;
  }

  // TS/JS const arrow function
  if ((lang === "typescript" || lang === "javascript") && node.type === "lexical_declaration") {
    const declarator = node.namedChild(0);
    if (!declarator || declarator.type !== "variable_declarator") return null;
    const nameNode = declarator.childForFieldName("name");
    const value = declarator.childForFieldName("value");
    if (value && (value.type === "arrow_function" || value.type === "function")) {
      return nameNode?.text ?? null;
    }
    return null;
  }

  // Standard name field
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // Rust impl → type name
  if (lang === "rust" && node.type === "impl_item") {
    return node.childForFieldName("type")?.text ?? null;
  }

  return null;
}

// ── Import path extraction ───────────────────────────────────────────────────

function extractImportPath(node: TSNode, lang: string): string | null {
  if (lang === "typescript" || lang === "javascript") {
    const src = node.childForFieldName("source");
    return src ? src.text.replace(/['"]/g, "") : null;
  }
  if (lang === "python") {
    const mod = node.childForFieldName("module_name") ?? node.childForFieldName("name");
    return mod?.text ?? null;
  }
  if (lang === "go") {
    const found = node.descendantsOfType("interpreted_string_literal")[0];
    return found ? found.text.replace(/"/g, "") : null;
  }
  if (lang === "rust") {
    const arg = node.namedChild(0);
    return arg?.text ?? null;
  }
  if (lang === "java") {
    const children = node.namedChildren.filter(
      (c: TSNode) => c.type === "scoped_identifier" || c.type === "identifier"
    );
    return children[0]?.text ?? null;
  }
  return null;
}

// ── Method extraction ────────────────────────────────────────────────────────

function extractMethods(classNode: TSNode, chunks: ParsedChunk[], lang: string): void {
  const body = classNode.childForFieldName("body") ?? classNode;

  for (let i = 0; i < body.namedChildCount; i++) {
    if (chunks.length >= MAX_CHUNKS_PER_FILE) return;
    const child = body.namedChild(i);
    if (!child) continue;

    const isMethod =
      child.type === "method_definition" ||
      child.type === "function_definition" ||
      child.type === "method_declaration" ||
      child.type === "function_item";

    if (isMethod) {
      const name = child.childForFieldName("name")?.text;
      if (name && name !== "constructor" && name !== "__init__") {
        chunks.push(makeChunk(name, "method", child, lang));
      }
    }
  }
}

// ── Dependency extraction from AST ───────────────────────────────────────────

function extractDepsFromNode(node: TSNode): string[] {
  const calls = new Set<string>();

  function walk(n: TSNode) {
    if (calls.size >= MAX_DEPS_PER_CHUNK) return;

    if (n.type === "call_expression" || n.type === "call") {
      const fn = n.childForFieldName("function") ?? n.namedChild(0);
      if (fn) {
        const text =
          fn.type === "member_expression" || fn.type === "attribute"
            ? fn.childForFieldName("property")?.text ?? fn.text
            : fn.text;
        if (text && text.length < 100 && !BUILTINS.has(text)) calls.add(text);
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) walk(child);
    }
  }

  walk(node);
  return Array.from(calls);
}

const BUILTINS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
  "instanceof", "await", "async", "function", "class", "import", "export",
  "require", "console", "JSON", "Object", "Array", "Promise", "Error",
  "parseInt", "parseFloat", "String", "Number", "Boolean", "RegExp",
  "Map", "Set", "Date", "Math", "setTimeout", "setInterval", "fetch", "Buffer",
  "print", "len", "range", "type", "super", "self", "this",
]);
