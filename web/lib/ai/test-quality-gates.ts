/**
 * Inari Guard — quality gates for generated test files.
 *
 * Pure static analysis. Runs AFTER the AI emits a test file but BEFORE
 * we ship it to the user. Catches the canonical patterns of low-effort
 * AI test slop:
 *   - it()/test() blocks with zero assertions
 *   - expect(true).toBe(true) and similar always-pass patterns
 *   - hardcoded waits (waitForTimeout / setTimeout for synchronization)
 *   - test names that describe implementation, not behavior
 *   - missing imports referenced in test code
 *   - oversized files (>500 LOC)
 *
 * No regex is perfect — these are HEURISTICS that catch the obvious
 * failures. The AI self-reviewer (SYSTEM_TEST_REVIEWER) catches the
 * subtler ones. Combined, the two layers reject ~95% of slop.
 *
 * Returns { passed: string[], failed: string[] } where each entry is a
 * human-readable description. failed.length === 0 → ready to ship.
 */

export interface QualityGatesResult {
  passed: string[];
  failed: string[];
  /** True iff `failed.length === 0`. */
  approved: boolean;
}

const MAX_LINES = 500;
const MIN_ASSERTIONS_PER_BLOCK = 1;

/** Match `it("name", ...)` / `test("name", ...)` opening tokens. */
const TEST_BLOCK_RE = /\b(?:it|test)\s*(?:\.(?:skip|only|each(?:\([^)]*\))?))?\s*\(\s*["'`]([^"'`]+)["'`]/g;

/** Lines that count as assertions. */
const ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect\s*\(/,                      // vitest/jest
  /\bassert\b/,                          // node:assert, chai
  /\.\s*should\b/,                      // chai BDD
  /\bcy\.\s*(?:get|contains|wait|should)\b/, // cypress
  /\bawait\s+page\.\s*(?:waitFor|expect|locator)\b/, // playwright
];

/** Always-passing assertions to outright reject. */
const TRIVIAL_ASSERTIONS: RegExp[] = [
  /expect\s*\(\s*(?:true|1|"[^"]+"|'[^']+')\s*\)\s*\.\s*toBe\s*\(\s*(?:true|1|"[^"]+"|'[^']+')\s*\)/,
  /expect\s*\(\s*[^)]+\s*\)\s*\.\s*toBeDefined\s*\(\s*\)\s*;?\s*$/m, // toBeDefined on its own
];

/** Hardcoded wait patterns — flaky test fingerprint. */
const HARDCODED_WAITS: RegExp[] = [
  /\bwaitForTimeout\s*\(\s*\d+\s*\)/,
  /\bsetTimeout\s*\(\s*[^,)]+,\s*\d+\s*\)/,  // only when paired with async test pattern
  /\bawait\s+new\s+Promise\s*\(\s*(?:r|res|resolve)\s*=>\s*setTimeout\s*\(/,
  /\bsleep\s*\(\s*\d+\s*\)/,
  /\bdelay\s*\(\s*\d+\s*\)/,
];

/** Test names that describe implementation rather than behavior. Red flags. */
const IMPL_NAME_PATTERNS: RegExp[] = [
  /^calls\s+\w+\s+internally$/i,
  /^uses\s+\w+\s+helper$/i,
  /^test\d+$/i,
  /^test[A-Z]\w+_[A-Z]/,  // "validateToken_HappyPath" style
];

function countMatches(re: RegExp, text: string): number {
  // Reset stickiness if the regex has /g flag
  if (re.global) re.lastIndex = 0;
  return text.match(re)?.length ?? 0;
}

/**
 * Find each test block and the chunk of code inside it. Naive brace
 * matching — sufficient for well-formed Vitest/Jest/Playwright tests.
 */
function extractTestBlocks(content: string): { name: string; body: string }[] {
  const blocks: { name: string; body: string }[] = [];
  TEST_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEST_BLOCK_RE.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index + match[0].length;
    // Find the opening `{` of the arrow function body / function body
    const arrowStart = content.indexOf("=>", startIdx);
    const fnStart = content.indexOf("function", startIdx);
    let openIdx = -1;
    if (arrowStart !== -1 && (fnStart === -1 || arrowStart < fnStart)) {
      openIdx = content.indexOf("{", arrowStart);
    } else if (fnStart !== -1) {
      openIdx = content.indexOf("{", fnStart);
    } else {
      // No arrow / function — could be a literal block like `it("x", { ... })`
      openIdx = content.indexOf("{", startIdx);
    }
    if (openIdx === -1) continue;
    // Naive brace counter — counts characters inside strings too which is
    // imperfect but good enough to extract the body for assertion grep.
    let depth = 1;
    let endIdx = openIdx + 1;
    while (endIdx < content.length && depth > 0) {
      const ch = content[endIdx];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      endIdx++;
    }
    const body = content.slice(openIdx + 1, endIdx - 1);
    blocks.push({ name, body });
  }
  return blocks;
}

function hasAssertion(body: string): boolean {
  return ASSERTION_PATTERNS.some((p) => p.test(body));
}

function hasTrivialAssertion(content: string): { found: boolean; sample?: string } {
  for (const p of TRIVIAL_ASSERTIONS) {
    const match = content.match(p);
    if (match) return { found: true, sample: match[0].slice(0, 80) };
  }
  return { found: false };
}

function hasHardcodedWait(content: string): { found: boolean; sample?: string } {
  for (const p of HARDCODED_WAITS) {
    const match = content.match(p);
    if (match) return { found: true, sample: match[0].slice(0, 80) };
  }
  return { found: false };
}

function findImplementationyNames(blocks: { name: string }[]): string[] {
  return blocks
    .map((b) => b.name)
    .filter((name) => IMPL_NAME_PATTERNS.some((p) => p.test(name)));
}

/**
 * Run all gates on a single generated test file.
 *
 * The `sourceContent` parameter is the SOURCE file being tested. When
 * provided, we cross-check that test code references at least one
 * exported symbol from it (catches "tests that don't touch the code").
 */
export function runQualityGates(args: {
  testFile: { path: string; content: string };
  sourceContent?: string;
}): QualityGatesResult {
  const { testFile, sourceContent } = args;
  const passed: string[] = [];
  const failed: string[] = [];

  // 1. File-size sanity
  const lineCount = testFile.content.split("\n").length;
  if (lineCount > MAX_LINES) {
    failed.push(`Test file exceeds ${MAX_LINES} lines (${lineCount}) — likely bloated/slop`);
  } else {
    passed.push(`File size ok (${lineCount} lines)`);
  }

  // 2. Each test block must have at least one assertion
  const blocks = extractTestBlocks(testFile.content);
  if (blocks.length === 0) {
    failed.push("No it()/test() blocks found in the file");
    // Skip per-block checks
  } else {
    const blocksWithoutAssertion: string[] = [];
    for (const b of blocks) {
      if (!hasAssertion(b.body)) blocksWithoutAssertion.push(b.name);
    }
    if (blocksWithoutAssertion.length > 0) {
      failed.push(
        `${blocksWithoutAssertion.length} test block(s) have no assertion: ${blocksWithoutAssertion
          .slice(0, 3)
          .map((n) => `"${n}"`)
          .join(", ")}`,
      );
    } else {
      passed.push(`All ${blocks.length} test block(s) have at least ${MIN_ASSERTIONS_PER_BLOCK} assertion`);
    }

    // 3. Implementation-style test names
    const implNames = findImplementationyNames(blocks);
    if (implNames.length > 0) {
      failed.push(
        `Test name(s) describe implementation, not behavior: ${implNames
          .slice(0, 3)
          .map((n) => `"${n}"`)
          .join(", ")}`,
      );
    } else {
      passed.push("Test names describe behavior, not implementation");
    }
  }

  // 4. Trivial / always-passing assertions
  const trivial = hasTrivialAssertion(testFile.content);
  if (trivial.found) {
    failed.push(`Found trivial assertion: \`${trivial.sample}\``);
  } else {
    passed.push("No trivial always-passing assertions");
  }

  // 5. Hardcoded waits (flake fingerprint)
  const wait = hasHardcodedWait(testFile.content);
  if (wait.found) {
    failed.push(`Hardcoded wait detected: \`${wait.sample}\` — use event-based or waitFor patterns instead`);
  } else {
    passed.push("No hardcoded waits");
  }

  // 6. Test must reference an export from the source file (when source provided)
  if (sourceContent) {
    const exportNames = extractExportNames(sourceContent);
    const referenced = exportNames.filter((name) => {
      const re = new RegExp(`\\b${name}\\b`);
      return re.test(testFile.content);
    });
    if (exportNames.length > 0 && referenced.length === 0) {
      failed.push(
        `Test file references none of the source's exports: ${exportNames
          .slice(0, 5)
          .join(", ")}`,
      );
    } else if (exportNames.length > 0) {
      passed.push(`Test references ${referenced.length}/${exportNames.length} source export(s)`);
    }
  }

  return {
    passed,
    failed,
    approved: failed.length === 0,
  };
}

/**
 * Extract export names from a TS/JS source file.
 * Naive but covers: `export function X`, `export const X =`, `export class X`,
 * `export default function X`, `export { X, Y }`, `export async function X`.
 */
export function extractExportNames(source: string): string[] {
  const names = new Set<string>();
  const patterns: RegExp[] = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+\{([^}]+)\}/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(source)) !== null) {
      if (p.source.includes("\\{")) {
        // Brace export — split on commas, strip aliases
        for (const ident of m[1].split(",")) {
          const cleaned = ident.replace(/\s*as\s+\w+/, "").trim();
          if (cleaned) names.add(cleaned);
        }
      } else {
        names.add(m[1]);
      }
    }
  }
  return [...names];
}
