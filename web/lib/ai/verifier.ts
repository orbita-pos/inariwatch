/**
 * Post-apply_patch verifier (PR #6).
 *
 * After the agent emits apply_patch and our envelope parser produces
 * the final file contents, we run two gates BEFORE pushing:
 *
 *   1. Syntax gate (deterministic, ~10 ms per file). Uses the TypeScript
 *      compiler's parser in SCRIPT mode to catch "this code won't even
 *      parse" bugs — orphan braces, `catch` without `try`, unterminated
 *      strings. For non-JS/TS files we skip (we don't ship a Python or
 *      Rust parser yet).
 *
 *   2. Sanity gate (cheap LLM). One gpt-4o-mini / analysis-tier call
 *      that sees the minimal diff plus the original error context and
 *      asks: "does this actually fix the error? any obvious logic
 *      bugs?". Returns JSON. Uses ≤ 500 tokens.
 *
 * Motivation from PR #5 E2E (session 843de468): apply_patch parsed +
 * applied cleanly, the model's self_review scored 95/100 and the fix
 * to `route.ts` shipped with a `} catch (error) {` orphan — self-
 * review missed it because it was grading the DIAGNOSIS, not the
 * mechanics.
 *
 * When verification fails the agentic loop feeds the failure back as
 * a tool_result (is_error: true) so the model gets one more turn to
 * correct it in-session. If we re-fail twice we just let the fix
 * through — downstream self_review / security_scan / test_gen still
 * run, and letting the loop thrash is worse than shipping an
 * imperfect fix the reviewer might still accept.
 */

import ts from "typescript";
import type { AIMessage } from "./client";
import { callAI } from "./client";

export interface VerifyResult {
  ok: boolean;
  /** Short one-line reason — safe to surface to the model. */
  issue?: string;
  /** Where the failure came from. */
  severity?: "syntax" | "logic" | "warning";
  /** Per-file syntax diagnostics (empty on pass). */
  syntaxErrors?: { path: string; message: string; line?: number }[];
}

export interface VerifyInput {
  files: { path: string; content: string }[];
  /** Original file contents keyed by path — used to compute minimal diffs. */
  originalFiles: Map<string, string>;
  errorContext: string;
  diagnosis: string;
  /** AI credentials for the sanity gate. */
  apiKey: string;
  model: string;
  /** When set, skip the sanity gate entirely (syntax-only mode). */
  skipSanity?: boolean;
  /** Log context for InariLens. */
  log?: {
    userId: string;
    projectId?: string | null;
    alertId?: string | null;
    remediationSessionId?: string | null;
    isPlatformKey?: boolean;
  };
}

const JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Parse each JS/TS file with the TypeScript compiler API. We don't
 * typecheck — just make sure the file is syntactically valid. This is
 * what `new Function(code)` would give us for JS but with TypeScript
 * support.
 */
export function verifySyntax(
  files: { path: string; content: string }[],
): { ok: boolean; errors: { path: string; message: string; line?: number }[] } {
  const errors: { path: string; message: string; line?: number }[] = [];

  for (const f of files) {
    if (!JS_TS_EXT.test(f.path)) continue;

    const kind = f.path.endsWith(".tsx") || f.path.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : f.path.endsWith(".ts") || f.path.endsWith(".cts") || f.path.endsWith(".mts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;

    const source = ts.createSourceFile(
      f.path,
      f.content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      kind,
    );

    // ts.createSourceFile exposes parse diagnostics via the internal
    // `parseDiagnostics` field. There's no stable public accessor, but
    // the property is populated on every compiled source file.
    const parseDiagnostics = (source as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics ?? [];

    for (const d of parseDiagnostics) {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      let line: number | undefined;
      if (d.file && typeof d.start === "number") {
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        line = pos.line + 1;
      }
      errors.push({ path: f.path, message: message.slice(0, 200), line });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build a minimal textual diff suitable for feeding the sanity model.
 * We don't need full patch format — just the changed + nearby context
 * lines so the model can reason about the fix without re-reading the
 * whole file.
 */
function buildMinimalDiff(
  files: { path: string; content: string }[],
  originalFiles: Map<string, string>,
): string {
  const parts: string[] = [];
  for (const f of files) {
    const before = originalFiles.get(f.path) ?? "";
    const beforeLines = before.split("\n");
    const afterLines = f.content.split("\n");

    // Find first and last differing line so we only show the changed region.
    let firstDiff = 0;
    while (
      firstDiff < beforeLines.length &&
      firstDiff < afterLines.length &&
      beforeLines[firstDiff] === afterLines[firstDiff]
    ) {
      firstDiff++;
    }
    let lastDiffBefore = beforeLines.length - 1;
    let lastDiffAfter = afterLines.length - 1;
    while (
      lastDiffBefore > firstDiff &&
      lastDiffAfter > firstDiff &&
      beforeLines[lastDiffBefore] === afterLines[lastDiffAfter]
    ) {
      lastDiffBefore--;
      lastDiffAfter--;
    }

    const CTX = 2;
    const startCtx = Math.max(0, firstDiff - CTX);
    const endCtxBefore = Math.min(beforeLines.length - 1, lastDiffBefore + CTX);
    const endCtxAfter = Math.min(afterLines.length - 1, lastDiffAfter + CTX);

    const beforeSlice = beforeLines.slice(startCtx, endCtxBefore + 1);
    const afterSlice = afterLines.slice(startCtx, endCtxAfter + 1);

    parts.push(`--- ${f.path} (before) ---`);
    parts.push(beforeSlice.map((l, i) => `${startCtx + i + 1}| ${l}`).join("\n"));
    parts.push(`--- ${f.path} (after) ---`);
    parts.push(afterSlice.map((l, i) => `${startCtx + i + 1}| ${l}`).join("\n"));
    parts.push("");
  }
  return parts.join("\n");
}

const SANITY_SYSTEM = `You are a code-fix verifier. A proposed fix has passed syntax parsing; now decide whether it is mechanically sound AND actually addresses the reported error.

You will be shown:
  1. The production error + stack trace.
  2. The root-cause diagnosis.
  3. The exact lines that changed (before / after per file, with line numbers).

Judge ONLY these three things:
  A. Does the fix plausibly address the error (variable now null-safe, missing await added, correct function signature, etc.)?
  B. Is there an obvious mechanical defect the syntax parser missed — unreachable \`return\`, \`} catch (e) {\` with no preceding \`try {\`, a variable referenced but never declared in the changed scope, a dangling brace matched by luck, a function signature that won't compile against its callers visible in the diff?
  C. Does the fix INTRODUCE a new bug visible in the diff (off-by-one, wrong operator, flipped condition, removed error handling)?

Ignore: code style, comment wording, whether the fix is "the most elegant", whether extra tests were added, naming.

Respond with EXACTLY this JSON (no prose before or after):
{"ok": true, "issue": null, "severity": null}
OR
{"ok": false, "issue": "<one sentence naming the concrete problem and the file:line>", "severity": "syntax" | "logic"}

If you are uncertain, lean toward ok:true — we want to catch real bugs, not block on stylistic disagreement.`;

export async function verifySanity(input: VerifyInput): Promise<VerifyResult> {
  const diff = buildMinimalDiff(input.files, input.originalFiles);
  const userMessage = [
    "Production error / stack trace:",
    input.errorContext.slice(0, 1500),
    "",
    "Root-cause diagnosis:",
    input.diagnosis.slice(0, 500),
    "",
    "Proposed fix (diff):",
    diff.slice(0, 3000),
  ].join("\n");

  const messages: AIMessage[] = [{ role: "user", content: userMessage }];

  try {
    const raw = await callAI(input.apiKey, SANITY_SYSTEM, messages, {
      maxTokens: 200,
      timeout: 30_000,
      model: input.model,
      log: input.log
        ? {
            userId: input.log.userId,
            projectId: input.log.projectId,
            alertId: input.log.alertId,
            remediationSessionId: input.log.remediationSessionId,
            feature: "remediation",
            isPlatformKey: input.log.isPlatformKey ?? false,
          }
        : undefined,
    });

    // Strip any accidental code fences.
    const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(trimmed) as { ok?: boolean; issue?: string | null; severity?: string | null };
    if (parsed.ok === true) {
      return { ok: true };
    }
    return {
      ok: false,
      issue: (parsed.issue ?? "").slice(0, 300) || "sanity check failed (no reason)",
      severity: (parsed.severity === "syntax" || parsed.severity === "logic") ? parsed.severity : "logic",
    };
  } catch (err) {
    // Network / parse errors should not BLOCK the fix — verifier is
    // advisory when it can't run. Return warning so callers can log but
    // not stop the pipeline.
    return {
      ok: true,
      issue: `verifier skipped: ${err instanceof Error ? err.message.slice(0, 100) : "error"}`,
      severity: "warning",
    };
  }
}

/**
 * Combined gate: syntax → mechanical → sanity. Each stage is stricter
 * and more expensive than the last, and any rejection short-circuits
 * the rest.
 *
 *   - Syntax (PR #6): ts.createSourceFile parser. ~10 ms/file, $0.
 *   - Mechanical (PR #8): regex/AST pattern detectors for defects the
 *     LLM-free layers should own — duplicate imports, leftover `!`
 *     after a null-fix, dead code. ~2 ms/file, $0.
 *   - Sanity (PR #6): cheap LLM. ~1-2 s, ~$0.001.
 */
export async function verifyFix(input: VerifyInput): Promise<VerifyResult> {
  const syntax = verifySyntax(input.files);
  if (!syntax.ok) {
    const firstErr = syntax.errors[0];
    return {
      ok: false,
      issue: `${firstErr.path}${firstErr.line ? `:${firstErr.line}` : ""} — ${firstErr.message}`,
      severity: "syntax",
      syntaxErrors: syntax.errors,
    };
  }

  const mechanical = verifyMechanical(input.files, input.diagnosis);
  if (!mechanical.ok) {
    return mechanical;
  }

  if (input.skipSanity) return { ok: true };
  return verifySanity(input);
}

/**
 * Deterministic pattern checks for defects that slipped through syntax
 * (code parses fine) but are almost certainly wrong. These checks run
 * BEFORE the LLM sanity gate so we save the $0.001-$0.002 LLM call
 * when a cheap regex already proves the fix is defective.
 *
 * All detectors return an `issue` string pointing at file:line so the
 * model can correct surgically on retry.
 *
 * Current detectors:
 *   1. Duplicate imports — two `import …` statements with the same
 *      specifier at the top of the file. Seen shipped in PR #5 E2E
 *      session c32a… where the model emitted a fix that added an
 *      `import { validateCoupon } from "./validators"` line without
 *      noticing one already existed.
 *   2. Leftover `!` non-null assertion on an identifier the diagnosis
 *      flagged as nullable. The whole point of a null-fix is to
 *      REMOVE the `!` — if we still see `validation!.discount` after
 *      the patch applied, the fix is incomplete.
 *   3. Unreachable code after `return` / `throw` within the same
 *      block — usually a dangling `return NextResponse.json(…)` the
 *      model forgot to delete.
 */
export function verifyMechanical(
  files: { path: string; content: string }[],
  diagnosis: string,
): VerifyResult {
  for (const f of files) {
    if (!JS_TS_EXT.test(f.path)) continue;

    const lines = f.content.split("\n");

    // ── Detector 0: duplicate variable declaration in same scope ──
    // Walks the TS AST and, for each BlockLike (function body, block,
    // SourceFile), tracks names declared via `const|let|var`. A second
    // declaration of the same name in the same block is almost always
    // a merge mistake. Shipped in E2E v11 session 968733d1 — the agent
    // re-declared `const validation` after adding a null check above.
    const dupIssue = findDuplicateDeclaration(f);
    if (dupIssue) return dupIssue;

    // ── Detector 1: duplicate imports ──────────────────────────────
    const importSeen = new Map<string, number>(); // spec → line
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*import\s+(?:[^"']*?\s+from\s+)?['"]([^'"]+)['"]/.exec(lines[i]);
      if (!m) continue;
      const spec = m[1];
      const prior = importSeen.get(spec);
      if (prior !== undefined) {
        return {
          ok: false,
          severity: "logic",
          issue: `${f.path}:${i + 1} — duplicate import of "${spec}" (first seen at line ${prior + 1}). Remove one of the two statements.`,
        };
      }
      importSeen.set(spec, i);
    }

    // ── Detector 2: leftover non-null assertion on a null-fix ──────
    // Only triggers when the diagnosis explicitly mentions null /
    // undefined — otherwise `!` might be legit (sorted array access,
    // DOM queries, etc.) and we don't want false positives.
    const mentionsNull = /\b(null|undefined|nullish|TypeError)\b/i.test(diagnosis);
    if (mentionsNull) {
      for (let i = 0; i < lines.length; i++) {
        // `foo!.bar` or `foo!.bar(` — post-fix the diagnosis usually
        // names the expression that crashed. Match ANY identifier with
        // `!.`; low precision but high recall, and the issue string
        // makes it easy for the model to verify.
        const m = /(\b[A-Za-z_$][\w$]*)(\![.\[\(])/.exec(lines[i]);
        if (m) {
          return {
            ok: false,
            severity: "logic",
            issue: `${f.path}:${i + 1} — non-null assertion \`${m[1]}!\` still present after a null-fix. Replace with an explicit null check (\`if (!${m[1]}) …\`) and access the value only on the non-null branch.`,
          };
        }
      }
    }

    // ── Detector 3: dead code after return / throw ─────────────────
    // Looks for a `return …;` or `throw …;` followed immediately by
    // another statement at the SAME indentation level (not a closing
    // brace, not a blank line, not a comment) — that's almost always
    // unreachable. Walks lines and tracks indent; keeps it simple.
    for (let i = 0; i < lines.length - 1; i++) {
      const here = lines[i];
      const next = lines[i + 1];
      const hereMatch = /^(\s*)(return\b|throw\b)/.exec(here);
      if (!hereMatch) continue;
      const hereIndent = hereMatch[1];
      const hereStmt = hereMatch[2];
      const nextTrimmed = next.trimStart();
      if (nextTrimmed === "") continue;
      if (nextTrimmed.startsWith("//") || nextTrimmed.startsWith("/*")) continue;
      if (nextTrimmed.startsWith("}") || nextTrimmed.startsWith(")") || nextTrimmed.startsWith("]")) continue;
      const nextIndent = next.slice(0, next.length - nextTrimmed.length);
      if (nextIndent.length >= hereIndent.length) {
        return {
          ok: false,
          severity: "logic",
          issue: `${f.path}:${i + 2} — unreachable code after \`${hereStmt}\` on line ${i + 1}. Remove the dangling statement or move the \`${hereStmt}\` into a conditional.`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Walk a source file's AST and flag the first case of two `const` /
 * `let` / `var` declarations sharing a name inside the same block
 * scope. Uses the TS parser (same one as verifySyntax) to avoid
 * regex false positives on destructuring / template literals / strings.
 */
function findDuplicateDeclaration(
  f: { path: string; content: string },
): VerifyResult | null {
  const kind =
    f.path.endsWith(".tsx") || f.path.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : f.path.endsWith(".ts") || f.path.endsWith(".cts") || f.path.endsWith(".mts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(
    f.path,
    f.content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    kind,
  );

  let found: VerifyResult | null = null;

  const visitBlock = (block: ts.Node, seen: Map<string, number>) => {
    ts.forEachChild(block, (child) => {
      if (found) return;
      if (ts.isVariableStatement(child)) {
        for (const decl of child.declarationList.declarations) {
          const name = decl.name;
          // Only flag bare identifier bindings — destructuring patterns
          // can legitimately introduce the same name in nested patterns,
          // and our block-scope model won't match TS's for those.
          if (ts.isIdentifier(name)) {
            const id = name.text;
            const lineNum = source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1;
            const prior = seen.get(id);
            if (prior !== undefined) {
              found = {
                ok: false,
                severity: "logic",
                issue: `${f.path}:${lineNum} — duplicate \`${id}\` declared (first at line ${prior}). Remove one of the two declarations or rename.`,
              };
              return;
            }
            seen.set(id, lineNum);
          }
        }
      }
      // Recurse into nested blocks with a FRESH scope — shadowing
      // inside an inner block is allowed.
      if (
        ts.isBlock(child) ||
        ts.isSourceFile(child) ||
        ts.isFunctionDeclaration(child) ||
        ts.isFunctionExpression(child) ||
        ts.isArrowFunction(child) ||
        ts.isMethodDeclaration(child) ||
        ts.isConstructorDeclaration(child) ||
        ts.isModuleBlock(child)
      ) {
        visitBlock(child, new Map());
      } else {
        visitBlock(child, seen);
      }
    });
  };

  visitBlock(source, new Map());
  return found;
}
