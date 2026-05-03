#!/usr/bin/env node
// CLI entry. Phase 1.3 indexer spawns this as a child process and consumes
// stdout — same contract as `code-intel-extractor-ts/src/cli.ts`.
//
// Flags (mirror the TS extractor where applicable):
//   --repo-path <abs>          (required)
//   --changed-files <list...>  (optional, space-separated relative paths)
//   --skip-references          (optional)
//   --skip-type-facts          (optional)
//   --skip-imports             (optional)
//   --pretty                   (optional, pretty-print JSON)
//
// Exit codes:
//   0 — success (output on stdout)
//   1 — bad args
//   2 — runtime failure (error message on stderr)

import { runExtractor } from "./extractor.js";
import type { ExtractorOptions } from "./types.js";

interface ParsedArgs {
  repoPath: string;
  changedFiles: string[];
  skipReferences: boolean;
  skipTypeFacts: boolean;
  skipImports: boolean;
  pretty: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    repoPath: "",
    changedFiles: [],
    skipReferences: false,
    skipTypeFacts: false,
    skipImports: false,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    switch (tok) {
      case "--repo-path":
        args.repoPath = argv[++i] ?? "";
        break;
      case "--changed-files": {
        const list: string[] = [];
        while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
          list.push(argv[++i]!);
        }
        args.changedFiles = list;
        break;
      }
      case "--skip-references":
        args.skipReferences = true;
        break;
      case "--skip-type-facts":
        args.skipTypeFacts = true;
        break;
      case "--skip-imports":
        args.skipImports = true;
        break;
      case "--pretty":
        args.pretty = true;
        break;
      default:
        // Ignore unknown flags rather than crashing — the indexer may pass
        // forwards-compatible ones.
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (!args.repoPath) {
    process.stderr.write("missing required flag: --repo-path\n");
    process.exit(1);
  }
  const opts: ExtractorOptions = {
    repoPath: args.repoPath,
    changedFiles: args.changedFiles.length > 0 ? args.changedFiles : undefined,
    includeReferences: !args.skipReferences,
    includeTypeFacts: !args.skipTypeFacts,
    includeImports: !args.skipImports,
  };
  try {
    const out = await runExtractor(opts);
    const json = args.pretty ? JSON.stringify(out, null, 2) : JSON.stringify(out);
    process.stdout.write(json);
    if (!json.endsWith("\n")) process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(`extractor: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

void main();
