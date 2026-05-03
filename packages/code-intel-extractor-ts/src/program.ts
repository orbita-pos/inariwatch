// Build a `ts.Program` from a repo path. Honors the repo's tsconfig.json
// when present; falls back to a sensible default for repos that don't
// have one (script collections, raw fixtures, etc.).
//
// We do NOT use the LanguageService here even though the handoff mentions
// it — for batch full-repo extraction, `ts.createProgram` + `getTypeChecker`
// is faster and uses less memory than spinning up a LanguageServiceHost.
// References-resolution, which is the main reason to use LanguageService,
// can be approximated cheaply for our use cases via type-checker symbol
// identity (see references.ts) without paying LanguageService overhead.

import * as path from "node:path";
import * as fs from "node:fs";
import * as ts from "typescript";

import { normalizePath } from "./fqn.js";

export interface ProgramHandle {
  program: ts.Program;
  checker: ts.TypeChecker;
  rootDir: string;
  sourceFiles: readonly ts.SourceFile[];
  // Map from absolute path → relative-to-repo, forward-slashed.
  toRelative: (absPath: string) => string;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  noEmit: true,
  skipLibCheck: true,
  strict: false,
};

export function createProgram(
  repoPath: string,
  tsconfigPath?: string,
): ProgramHandle {
  const rootDir = path.resolve(repoPath);
  const config = loadTsconfig(rootDir, tsconfigPath);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
  });
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !isVendor(sf, rootDir));

  return {
    program,
    checker,
    rootDir,
    sourceFiles,
    toRelative: (absPath: string) =>
      normalizePath(path.relative(rootDir, absPath)),
  };
}

interface LoadedConfig {
  fileNames: string[];
  options: ts.CompilerOptions;
}

function loadTsconfig(rootDir: string, override?: string): LoadedConfig {
  // Honor an explicit tsconfig override OR a tsconfig.json at the repo root.
  // We deliberately do NOT walk up — a fixture inside another workspace
  // mustn't accidentally pick up the parent's tsconfig (which may exclude
  // the very files we want to extract).
  const tsconfigPath = override
    ? path.resolve(rootDir, override)
    : path.join(rootDir, "tsconfig.json");

  if (tsconfigPath && fs.existsSync(tsconfigPath)) {
    const raw = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (raw.error) {
      throw new Error(diagnosticToString(raw.error));
    }
    const parsed = ts.parseJsonConfigFileContent(
      raw.config,
      ts.sys,
      path.dirname(tsconfigPath),
    );
    if (parsed.errors.length > 0) {
      const fatal = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (fatal.length > 0) {
        throw new Error(fatal.map(diagnosticToString).join("\n"));
      }
    }
    return {
      fileNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true, skipLibCheck: true },
    };
  }

  // No tsconfig — gather every .ts/.tsx file under the repo, excluding
  // node_modules and dist/build folders. This matches what `tsc` does in
  // a directory with no config but with files passed explicitly.
  const fileNames: string[] = [];
  walk(rootDir, fileNames, rootDir);
  return { fileNames, options: { ...DEFAULT_OPTIONS } };
}

function walk(dir: string, out: string[], rootDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "out"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, rootDir);
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function isVendor(sf: ts.SourceFile, rootDir: string): boolean {
  const rel = path.relative(rootDir, sf.fileName);
  if (!rel || rel.startsWith("..")) return true;
  return rel.split(path.sep).includes("node_modules");
}

function diagnosticToString(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, "\n");
}
