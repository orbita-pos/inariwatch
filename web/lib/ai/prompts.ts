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

export function buildDiagnosePrompt(
  alert: {
    title: string;
    body: string;
    sourceIntegrations: string[];
    aiReasoning?: string | null;
  },
  repoFiles: string[],
  buildLogs?: string | null
): string {
  // Show a subset of the file tree to avoid token explosion
  const fileTree = repoFiles
    .filter((f) => !f.includes("node_modules/") && !f.includes(".lock") && !f.startsWith(".git/"))
    .slice(0, 500)
    .join("\n");

  const buildLogSection = buildLogs
    ? `\n\nBUILD / RUNTIME LOGS (actual compiler or runtime output):\n${buildLogs.slice(0, 2500)}`
    : "";

  return `Analyze this error and identify the files that need to be fixed.

ERROR:
Title: ${alert.title}
Details: ${alert.body.slice(0, 1500)}
Source: ${alert.sourceIntegrations.join(", ")}
${alert.aiReasoning ? `\nPrevious AI analysis:\n${alert.aiReasoning.slice(0, 800)}` : ""}
${buildLogSection}

REPOSITORY FILE TREE:
${fileTree}

Respond in JSON:
{
  "diagnosis": "What exactly went wrong (1-2 sentences)",
  "filesToRead": ["path/to/file1.ts", "path/to/file2.ts"],
  "confidence": "high" | "medium" | "low"
}

Only request files that exist in the tree above. Request 1-5 files maximum.
Focus on source files (.ts, .tsx, .js, .jsx, .py, .go, .rs, etc.), not config files, unless the error is clearly config-related.

CRITICAL RULES:
- If build/runtime logs are provided above, base your diagnosis ONLY on what the logs say. Do not guess.
- Do NOT invent errors like "missing React import" or "missing dependency" unless the logs specifically mention them.
- If the error details are too vague to determine the root cause with certainty, set confidence to "low" and explain what info is missing in the diagnosis.
- A generic message like "Build failed" without build logs is NOT enough to diagnose — set confidence to "low".`;
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
