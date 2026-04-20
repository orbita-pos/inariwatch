/**
 * Deterministic fix templates (PR #9).
 *
 * The agentic loop + verifier stack is excellent at correcting most
 * real bugs, but it costs one LLM roundtrip per turn. For the MOST
 * common class of production bug — a null-reference on a value that
 * came from an async call and was force-unwrapped with `!` — we can
 * generate the fix with 0 LLM cost + 0 latency by pattern-matching
 * the file and inserting an idiomatic null check.
 *
 * The template-generated fix still flows through the existing
 * verifier gates (syntax / mechanical / sanity) before being
 * pushed, so a bad template never ships undetected.
 *
 * Scope (v1):
 *   - ONE pattern only: `const x = (await f(...))!` where `x` is
 *     dereferenced on a subsequent line. The fix rewrites to
 *     `const x = await f(...); if (!x) throw new Error(...)`.
 *   - ONE language: TypeScript / JavaScript.
 *
 * Callers: remediate.ts. Runs after diagnose but BEFORE the agentic
 * loop. If the template applies cleanly AND a downstream verifier
 * check passes, remediate skips the loop entirely. Otherwise it
 * falls through to the normal flow (no state to roll back).
 */

import ts from "typescript";

export interface TemplateMatch {
  path: string;
  /** Line (1-indexed) of the `const X = (await Y)!` declaration. */
  line: number;
  /** The identifier being asserted non-null. */
  varName: string;
  /** The original source of the declaration (`const x = (await f())!;`). */
  originalDecl: string;
  /** The await expression without the `!` assertion. */
  awaitExpr: string;
}

export interface TemplateFix {
  path: string;
  /** New full file content after applying the template. */
  content: string;
  /** Short human-readable description of what changed. */
  explanation: string;
}

const JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/**
 * Scan a set of files for the `const x = (await …)!` pattern where
 * `x` is later dereferenced. Returns the FIRST match, or null if
 * none found. We intentionally don't match every occurrence — PR #9
 * is about the common case; callers can re-invoke after applying.
 */
export function findNonNullAwaitPattern(
  files: { path: string; content: string }[],
  diagnosis: string,
): TemplateMatch | null {
  // Only fire when the diagnosis text indicates a null / undefined
  // / TypeError — otherwise the `!` may be intentional.
  if (!/\b(null|undefined|nullish|TypeError)\b/i.test(diagnosis)) return null;

  for (const f of files) {
    if (!JS_TS_EXT.test(f.path)) continue;
    const match = scanFile(f);
    if (match) return match;
  }
  return null;
}

function scanFile(f: { path: string; content: string }): TemplateMatch | null {
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

  let match: TemplateMatch | null = null;

  const visit = (node: ts.Node) => {
    if (match) return;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (!ts.isIdentifier(decl.name)) continue;
        // The initializer must be a NonNullExpression wrapping an
        // AwaitExpression (possibly inside a ParenthesizedExpression).
        let init = decl.initializer;
        if (!ts.isNonNullExpression(init)) continue;
        let inner: ts.Node = init.expression;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        if (!ts.isAwaitExpression(inner)) continue;

        const name = decl.name.text;
        const start = node.getStart(source);
        const { line } = source.getLineAndCharacterOfPosition(start);
        const originalDecl = f.content.slice(node.getStart(source), node.getEnd());
        const awaitText = inner.getText(source);

        // Verify the variable is dereferenced AFTER this declaration —
        // a leftover `x!` that's never read isn't actually a crash
        // source; we don't want to rewrite harmlessly typed code.
        if (!isDereferencedLater(source, decl, name)) continue;

        match = {
          path: f.path,
          line: line + 1,
          varName: name,
          originalDecl,
          awaitExpr: awaitText,
        };
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return match;
}

function isDereferencedLater(
  source: ts.SourceFile,
  decl: ts.VariableDeclaration,
  name: string,
): boolean {
  const declEnd = decl.getEnd();
  let found = false;
  const walk = (node: ts.Node) => {
    if (found) return;
    if (node.getStart(source) < declEnd) {
      ts.forEachChild(node, walk);
      return;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/**
 * Build the patched file content for a template match.
 *
 * Transformation:
 *   const validation = (await validateCoupon(code))!;
 *                       ↓
 *   const validation = await validateCoupon(code);
 *   if (!validation) throw new Error("<varname> missing or invalid");
 *
 * The error message references the variable name so the runtime
 * feedback is slightly better than the generic "TypeError" the
 * original code produced.
 */
export function applyNonNullAwaitTemplate(
  file: { path: string; content: string },
  match: TemplateMatch,
): TemplateFix {
  const lines = file.content.split("\n");
  const declLine = lines[match.line - 1];
  const leadingWS = declLine.match(/^(\s*)/)?.[1] ?? "";

  // Rewrite the declaration: drop the surrounding parens + `!`.
  // We reuse the awaitExpr text verbatim so operator precedence
  // and formatting stay intact.
  const newDeclLine = `${leadingWS}const ${match.varName} = ${match.awaitExpr};`;
  const guardLine = `${leadingWS}if (!${match.varName}) throw new Error("${match.varName} missing or invalid");`;

  const newLines = [
    ...lines.slice(0, match.line - 1),
    newDeclLine,
    guardLine,
    ...lines.slice(match.line),
  ];

  const explanation = `Removed non-null assertion on \`${match.varName}\` and added an explicit guard (throws "${match.varName} missing or invalid" instead of dereferencing null).`;

  return {
    path: file.path,
    content: newLines.join("\n"),
    explanation,
  };
}

/**
 * Convenience: run find + apply in one step. Returns null if no
 * match. The returned fix is ready to push to the remediation
 * pipeline as a pseudo-agentic-result — callers must still run
 * the verifier before shipping.
 */
export function tryDeterministicFix(
  files: { path: string; content: string }[],
  diagnosis: string,
): { match: TemplateMatch; fix: TemplateFix } | null {
  const match = findNonNullAwaitPattern(files, diagnosis);
  if (!match) return null;
  const file = files.find((f) => f.path === match.path);
  if (!file) return null;
  const fix = applyNonNullAwaitTemplate(file, match);
  return { match, fix };
}
