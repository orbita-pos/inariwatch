/**
 * Regex-based code parser — fallback when tree-sitter WASM fails to load.
 * Covers TypeScript/JavaScript, Python, Go, Rust, Java.
 */

import type { ChunkType, ParsedChunk, ParseResult } from "./parser";
import { detectLanguage } from "./parser";

// ── Regex fallback parser ────────────────────────────────────────────────────

const MAX_LINES = 20_000;
const MAX_CHUNKS_PER_FILE = 500;
const MAX_DEPS_PER_CHUNK = 200;

export function parseFileRegex(filePath: string, content: string): ParseResult | null {
  const language = detectLanguage(filePath);
  if (!language) return null;

  // Guard: reject files that are too large to parse safely
  if (content.length > 500_000) return null;

  const lines = content.split("\n");
  if (lines.length > MAX_LINES) return null;

  let result: ParseResult | null;
  switch (language) {
    case "typescript":
    case "javascript":
      result = parseTSJS(lines, language);
      break;
    case "python":
      result = parsePython(lines, language);
      break;
    case "go":
      result = parseGo(lines, language);
      break;
    case "rust":
      result = parseRust(lines, language);
      break;
    case "java":
      result = parseJava(lines, language);
      break;
    default:
      return null;
  }

  // Cap chunks per file to prevent memory abuse
  if (result && result.chunks.length > MAX_CHUNKS_PER_FILE) {
    result.chunks = result.chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }
  return result;
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────────

const TS_FUNCTION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const TS_CONST_FN = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/;
const TS_CLASS = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
const TS_METHOD = /^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/;
const TS_TYPE = /^(?:export\s+)?(?:type|interface)\s+(\w+)/;
const TS_IMPORT = /(?:from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/;

function parseTSJS(lines: string[], language: string): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Collect imports
    const importMatch = line.match(TS_IMPORT);
    if (importMatch) {
      imports.push(importMatch[1] ?? importMatch[2]);
      i++;
      continue;
    }

    // Class
    const classMatch = line.match(TS_CLASS);
    if (classMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      const code = lines.slice(start, end + 1).join("\n");
      chunks.push({
        name: classMatch[1],
        chunkType: "class",
        startLine: start + 1,
        endLine: end + 1,
        code,
        dependencies: extractDeps(code),
      });
      // Also extract methods inside the class
      const methods = extractMethodsFromClass(lines, start, end);
      chunks.push(...methods);
      i = end + 1;
      continue;
    }

    // Type/Interface
    const typeMatch = line.match(TS_TYPE);
    if (typeMatch) {
      const start = i;
      const end = line.includes("{") ? findBlockEnd(lines, i) : findStatementEnd(lines, i);
      chunks.push({
        name: typeMatch[1],
        chunkType: "type",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    // Function declaration
    const funcMatch = line.match(TS_FUNCTION);
    if (funcMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      const code = lines.slice(start, end + 1).join("\n");
      chunks.push({
        name: funcMatch[1],
        chunkType: "function",
        startLine: start + 1,
        endLine: end + 1,
        code,
        dependencies: extractDeps(code),
      });
      i = end + 1;
      continue;
    }

    // Const arrow function
    const constMatch = line.match(TS_CONST_FN);
    if (constMatch && !line.match(/^\s*\/\//)) {
      const start = i;
      const end = findBlockEnd(lines, i);
      // Only count if it's substantial (not just a simple assignment)
      if (end - start >= 2) {
        const code = lines.slice(start, end + 1).join("\n");
        chunks.push({
          name: constMatch[1],
          chunkType: "function",
          startLine: start + 1,
          endLine: end + 1,
          code,
          dependencies: extractDeps(code),
        });
      }
      i = end + 1;
      continue;
    }

    i++;
  }

  return { chunks, imports, language };
}

function extractMethodsFromClass(lines: string[], classStart: number, classEnd: number): ParsedChunk[] {
  const methods: ParsedChunk[] = [];
  let i = classStart + 1;

  while (i < classEnd) {
    const line = lines[i];
    const methodMatch = line.match(TS_METHOD);
    if (methodMatch && methodMatch[1] !== "constructor") {
      const start = i;
      const end = findBlockEnd(lines, i);
      methods.push({
        name: methodMatch[1],
        chunkType: "method",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }
    i++;
  }
  return methods;
}

// ── Python ───────────────────────────────────────────────────────────────────

const PY_FUNCTION = /^(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_CLASS = /^class\s+(\w+)/;
const PY_METHOD = /^\s{4}(?:async\s+)?def\s+(\w+)\s*\(/;
const PY_IMPORT = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/;

function parsePython(lines: string[], language: string): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const importMatch = line.match(PY_IMPORT);
    if (importMatch) {
      imports.push(importMatch[1] ?? importMatch[2]);
      i++;
      continue;
    }

    const classMatch = line.match(PY_CLASS);
    if (classMatch) {
      const start = i;
      const end = findIndentEnd(lines, i, 0);
      chunks.push({
        name: classMatch[1],
        chunkType: "class",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    const funcMatch = line.match(PY_FUNCTION);
    if (funcMatch && !line.startsWith("    ")) {
      const start = i;
      const end = findIndentEnd(lines, i, 0);
      chunks.push({
        name: funcMatch[1],
        chunkType: "function",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    i++;
  }

  return { chunks, imports, language };
}

// ── Go ───────────────────────────────────────────────────────────────────────

const GO_FUNCTION = /^func\s+(\w+)\s*\(/;
const GO_METHOD = /^func\s+\(\w+\s+\*?(\w+)\)\s+(\w+)\s*\(/;
const GO_TYPE = /^type\s+(\w+)\s+(?:struct|interface)/;
const GO_IMPORT = /^\s+"([^"]+)"/;

function parseGo(lines: string[], language: string): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: string[] = [];
  let inImportBlock = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.match(/^import\s*\(/)) { inImportBlock = true; i++; continue; }
    if (inImportBlock) {
      if (line.trim() === ")") { inImportBlock = false; i++; continue; }
      const m = line.match(GO_IMPORT);
      if (m) imports.push(m[1]);
      i++;
      continue;
    }

    const methodMatch = line.match(GO_METHOD);
    if (methodMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      chunks.push({
        name: `${methodMatch[1]}.${methodMatch[2]}`,
        chunkType: "method",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    const funcMatch = line.match(GO_FUNCTION);
    if (funcMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      chunks.push({
        name: funcMatch[1],
        chunkType: "function",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    const typeMatch = line.match(GO_TYPE);
    if (typeMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      chunks.push({
        name: typeMatch[1],
        chunkType: "type",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    i++;
  }

  return { chunks, imports, language };
}

// ── Rust ─────────────────────────────────────────────────────────────────────

const RS_FUNCTION = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/;
const RS_STRUCT = /^(?:pub\s+)?struct\s+(\w+)/;
const RS_IMPL = /^impl(?:<[^>]*>)?\s+(\w+)/;
const RS_USE = /^use\s+([^;]+)/;

function parseRust(lines: string[], language: string): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const useMatch = line.match(RS_USE);
    if (useMatch) { imports.push(useMatch[1].trim()); i++; continue; }

    const implMatch = line.match(RS_IMPL);
    if (implMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      chunks.push({
        name: implMatch[1],
        chunkType: "class",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    const structMatch = line.match(RS_STRUCT);
    if (structMatch) {
      const start = i;
      const end = line.includes("{") ? findBlockEnd(lines, i) : findStatementEnd(lines, i);
      chunks.push({
        name: structMatch[1],
        chunkType: "type",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    const funcMatch = line.match(RS_FUNCTION);
    if (funcMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      chunks.push({
        name: funcMatch[1],
        chunkType: "function",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    i++;
  }

  return { chunks, imports, language };
}

// ── Java ─────────────────────────────────────────────────────────────────────

const JAVA_CLASS = /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/;
const JAVA_METHOD = /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/;
const JAVA_IMPORT = /^import\s+([^;]+)/;

function parseJava(lines: string[], language: string): ParseResult {
  const chunks: ParsedChunk[] = [];
  const imports: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const importMatch = line.match(JAVA_IMPORT);
    if (importMatch) { imports.push(importMatch[1].trim()); i++; continue; }

    const classMatch = line.match(JAVA_CLASS);
    if (classMatch) {
      const start = i;
      const end = findBlockEnd(lines, i);
      chunks.push({
        name: classMatch[1],
        chunkType: "class",
        startLine: start + 1,
        endLine: end + 1,
        code: lines.slice(start, end + 1).join("\n"),
        dependencies: [],
      });
      i = end + 1;
      continue;
    }

    i++;
  }

  return { chunks, imports, language };
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Find the closing brace for a block that starts at `startLine`. */
function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") depth--;
      if (foundOpen && depth === 0) return i;
    }
  }

  // Fallback: if no braces found, scan for next blank line or EOF
  if (!foundOpen) {
    for (let i = startLine + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") return i - 1;
    }
  }

  return Math.min(startLine + 100, lines.length - 1);
}

/** Find end of a statement (for single-line types, etc.) */
function findStatementEnd(lines: string[], startLine: number): number {
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].includes(";") || (i > startLine && lines[i].trim() === "")) return i;
  }
  return startLine;
}

/** Find end of an indentation block (Python). */
function findIndentEnd(lines: string[], startLine: number, baseIndent: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // skip blank lines
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}

/** Extract function calls from code (simple heuristic). */
function extractDeps(code: string): string[] {
  const calls = new Set<string>();
  const re = /(?<!\w)([a-zA-Z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (!SKIP_NAMES.has(name)) calls.add(name);
    if (calls.size >= MAX_DEPS_PER_CHUNK) break;
  }
  return Array.from(calls);
}

const SKIP_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "typeof",
  "instanceof", "await", "async", "function", "class", "import", "export",
  "require", "console", "JSON", "Object", "Array", "Promise", "Error",
  "parseInt", "parseFloat", "String", "Number", "Boolean", "RegExp",
  "Map", "Set", "Date", "Math", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "fetch", "Buffer",
]);
