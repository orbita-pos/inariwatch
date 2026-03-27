/**
 * Prompt templates for AI analysis tasks.
 */

export const SYSTEM_ANALYZER = `You are an expert DevOps and software reliability engineer.
You analyze monitoring alerts and provide clear, actionable insights.
Be concise, technical, and practical.
Format your response in plain text — no markdown headers, no bullet symbols.
Use short paragraphs separated by blank lines.`;

export const SYSTEM_CORRELATOR = `You are an expert DevOps engineer specializing in incident correlation.
You analyze groups of alerts to identify common root causes and incident patterns.
Be concise and actionable. Format responses as plain text.`;

export function buildAnalyzePrompt(alert: {
  title: string;
  severity: string;
  body: string;
  sourceIntegrations: string[];
}): string {
  return `Analyze this monitoring alert and provide:

1. Root cause — what most likely caused this (2-3 sentences)
2. Impact — what is affected and who (1-2 sentences)
3. Remediation — 2-4 concrete steps to fix or investigate

Alert details:
Title: ${alert.title}
Severity: ${alert.severity}
Source: ${alert.sourceIntegrations.join(", ")}
Details: ${alert.body.slice(0, 1000)}

Keep the total response under 200 words. Be specific and actionable.`;
}

export function buildCorrelatePrompt(alerts: {
  title: string;
  severity: string;
  source: string[];
  createdAt: string;
}[]): string {
  const list = alerts
    .map(
      (a, i) =>
        `[${i + 1}] ${a.severity.toUpperCase()} — ${a.title} (${a.source.join("/")} at ${a.createdAt})`
    )
    .join("\n");

  return `${alerts.length} alerts fired together for the same project:

${list}

Determine:
1. Are these related to the same incident? (yes/no + confidence)
2. Most likely root cause (1-2 sentences)
3. Which alert to investigate first
4. Suggested immediate action (1 sentence)

Keep response under 150 words.`;
}

// ── AI Remediation prompts ──────────────────────────────────────────────────

export const SYSTEM_REMEDIATOR = `You are an expert software engineer performing automated code fixes.
You analyze production errors and CI failures to generate precise, minimal code fixes.

CRITICAL RULES:
1. Make the MINIMUM change necessary to fix the issue. Never refactor unrelated code.
2. Return COMPLETE file contents for each changed file — never partial snippets.
3. File paths must match the repository structure EXACTLY.
4. If you are not confident about the fix, say so in the explanation.
5. Never change formatting, add comments like "// fixed", or modify code unrelated to the bug.
6. Ensure the code compiles and types are correct.

You respond ONLY in valid JSON. No markdown, no explanation outside the JSON.`;

export type RemediationContext = {
  sentryStackTrace: string | null;
  sentryIssueDetails: string | null;
  vercelBuildLogs: string | null;
  githubCILogs: string | null;
  datadogMetrics: string | null;
  substrateContext: string | null;
  eapReceipt: EapReceiptContext | null;
  /** Files changed in the most recent deploy — likely cause of the error. */
  deployContext: string | null;
};

export type EapReceiptContext = {
  receiptId: string;
  eventCount: number;
  surfaces: {
    httpEndpoints: string[];
    dbTables: string[];
    llmCalls: { provider: string; model: string; inputTokens?: number; outputTokens?: number }[];
    toolUses: { toolName: string; provider: string }[];
  };
  chainDepth: number;
  signed: boolean;
  verified: boolean;
};

export type MemoryHint = {
  alertTitle: string;
  rootCause: string;
  fixSummary: string;
  filesFixed: string[];
  confidence: number;
};

export function buildDiagnosePrompt(
  alert: {
    title: string;
    body: string;
    sourceIntegrations: string[];
    aiReasoning?: string | null;
  },
  repoFiles: string[],
  context?: RemediationContext | null,
  pastIncidents?: MemoryHint[],
  hotFiles?: Map<string, number>,
  deployedFiles?: string[],
): string {
  const deployedSet = new Set(deployedFiles ?? []);

  // Build annotated file tree — mark hot files and recently deployed files
  const fileTree = repoFiles
    .filter((f) => !f.includes("node_modules/") && !f.includes(".lock") && !f.startsWith(".git/"))
    .slice(0, 500)
    .map((f) => {
      const tags: string[] = [];
      const hotCount = hotFiles?.get(f);
      if (hotCount && hotCount >= 2) tags.push(`HOT:${hotCount} fixes`);
      if (deployedSet.has(f)) tags.push("DEPLOYED");
      return tags.length > 0 ? `${f}  [${tags.join("] [")}]` : f;
    })
    .join("\n");

  const contextSections: string[] = [];
  if (context?.sentryStackTrace) contextSections.push(`SENTRY STACK TRACE:\n${context.sentryStackTrace.slice(0, 2500)}`);
  if (context?.sentryIssueDetails) contextSections.push(`SENTRY ISSUE DETAILS:\n${context.sentryIssueDetails.slice(0, 1500)}`);
  if (context?.vercelBuildLogs) contextSections.push(`VERCEL BUILD LOGS:\n${context.vercelBuildLogs.slice(0, 2500)}`);
  if (context?.githubCILogs) contextSections.push(`GITHUB CI LOGS:\n${context.githubCILogs.slice(0, 2500)}`);
  if (context?.datadogMetrics) contextSections.push(`DATADOG METRICS:\n${context.datadogMetrics.slice(0, 1500)}`);
  if (context?.substrateContext) contextSections.push(`SUBSTRATE RECORDING (full I/O trace):\n${context.substrateContext.slice(0, 4000)}`);
  if (context?.deployContext) contextSections.push(`RECENT DEPLOY (likely cause of the error):\n${context.deployContext.slice(0, 1500)}`);
  const buildLogSection = contextSections.length > 0 ? `\n\n${contextSections.join("\n\n")}` : "";

  let memorySection = "";
  if (pastIncidents && pastIncidents.length > 0) {
    const entries = pastIncidents
      .map(
        (m) =>
          `  Alert: "${m.alertTitle}"\n  Root cause: ${m.rootCause}\n  Fix: ${m.fixSummary}\n  Files: ${m.filesFixed.join(", ")}  (confidence ${m.confidence})`
      )
      .join("\n---\n");
    memorySection = `\n\nSIMILAR PAST INCIDENTS (already resolved — use as hints):\n${entries}\nIf this matches a past incident, bias toward the same root cause and files.`;
  }

  return `Analyze this error and identify the files that need to be fixed.

ERROR:
Title: ${alert.title}
Details: ${alert.body.slice(0, 1500)}
Source: ${alert.sourceIntegrations.join(", ")}
${alert.aiReasoning ? `\nPrevious AI analysis:\n${alert.aiReasoning.slice(0, 800)}` : ""}
${buildLogSection}${memorySection}

REPOSITORY FILE TREE:
${fileTree}

Respond in JSON:
{
  "diagnosis": "What exactly went wrong (1-2 sentences)",
  "filesToRead": ["path/to/file1.ts", "path/to/file2.ts"],
  "confidence": <number 0-100>
}

Confidence scoring guide:
  90-100: Very clear error with obvious root cause from logs/stack traces
  60-89: Likely cause but some ambiguity remains
  30-59: Educated guess based on limited information
  0-29: Too vague to diagnose reliably

Only request files that exist in the tree above. Request 1-5 files maximum.
Focus on source files (.ts, .tsx, .js, .jsx, .py, .go, .rs, etc.), not config files, unless the error is clearly config-related.
PRIORITIZE files marked [DEPLOYED] (changed in the deploy that caused this error) and [HOT] (frequently fixed in this project).

CRITICAL RULES:
- If build/runtime logs are provided above, base your diagnosis ONLY on what the logs say. Do not guess.
- Do NOT invent errors like "missing React import" or "missing dependency" unless the logs specifically mention them.
- If the error details are too vague to determine the root cause with certainty, set confidence to "low" and explain what info is missing in the diagnosis.
- A generic message like "Build failed" without build logs is NOT enough to diagnose — set confidence to 20 or lower.`;
}

export function buildFixPrompt(
  diagnosis: string,
  files: { path: string; content: string }[],
  errorDetails: string,
  previousAttempt?: { files: { path: string; content: string }[]; ciError: string }
): string {
  const fileContents = files
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 10000)}`)
    .join("\n\n");

  let retryContext = "";
  if (previousAttempt) {
    retryContext = `

IMPORTANT — PREVIOUS FIX ATTEMPT FAILED.
CI output after my last fix:
${previousAttempt.ciError.slice(0, 2000)}

Files I changed: ${previousAttempt.files.map((f) => f.path).join(", ")}

The previous approach did NOT work. You MUST try a DIFFERENT approach.
Analyze the CI error carefully to understand why the previous fix failed.`;
  }

  return `Fix the following error by modifying the source code.

DIAGNOSIS: ${diagnosis}

ERROR DETAILS:
${errorDetails.slice(0, 2000)}
${retryContext}

SOURCE FILES:
${fileContents}

Respond in JSON:
{
  "explanation": "What I changed and why (2-3 sentences, for the PR description)",
  "files": [
    { "path": "exact/path/to/file.ts", "content": "complete new file content here" }
  ]
}

RULES:
- Return the COMPLETE file content for each changed file.
- Change ONLY what is necessary to fix the error.
- Make sure the code compiles and types are correct.
- If you need to change multiple files, include all of them.`;
}

// ── Self-review prompt ────────────────────────────────────────────────────────

export const SYSTEM_REVIEWER = `You are a senior code reviewer performing an automated review of an AI-generated fix.
You review diffs for correctness, safety, style, and potential regressions.
You are strict — only approve changes that are clearly correct and minimal.
You respond ONLY in valid JSON. No markdown, no explanation outside the JSON.`;

export function buildSelfReviewPrompt(
  diagnosis: string,
  originalFiles: { path: string; content: string }[],
  fixedFiles: { path: string; content: string }[],
  errorDetails: string
): string {
  const diffs = fixedFiles.map((fixed) => {
    const original = originalFiles.find((o) => o.path === fixed.path);
    return `--- ${fixed.path} (original) ---\n${original?.content.slice(0, 5000) ?? "(new file)"}\n\n+++ ${fixed.path} (fixed) ---\n${fixed.content.slice(0, 5000)}`;
  }).join("\n\n========\n\n");

  return `Review this AI-generated code fix.

ERROR BEING FIXED:
${errorDetails.slice(0, 1000)}

DIAGNOSIS:
${diagnosis}

CODE CHANGES:
${diffs}

Review the changes and respond in JSON:
{
  "score": <number 0-100>,
  "concerns": ["list of specific concerns, if any"],
  "recommendation": "approve" | "flag" | "reject"
}

Scoring guide:
  90-100: Fix is clearly correct, minimal, and safe. Approve.
  60-89: Fix looks reasonable but has minor concerns. Flag for human review.
  0-59: Fix has significant issues, may introduce bugs. Reject.

Specifically check for:
- Does the fix actually address the diagnosed error?
- Could it introduce new bugs or regressions?
- Are there any type errors, missing imports, or syntax issues?
- Is the change minimal, or does it modify unrelated code?
- Could it break any existing tests?`;
}
