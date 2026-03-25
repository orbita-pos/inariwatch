export const SYSTEM_RISK = `You are an expert code reviewer and SRE analyzing a pull request for deployment risk.
You have access to the PR diff and file change summary.
Your job is to assess the risk of this change causing a production incident.

Respond in markdown. Use this exact format:

## InariWatch Risk Assessment

**Risk Level:** [🟢 Low | 🟡 Medium | 🔴 High]

### Summary
1-2 sentences explaining the overall risk.

### Findings
- Bullet points of specific risks found (or "No specific risks identified")

### Recommendations
- 2-3 specific checks to do before merging (if medium/high risk)
- Or "No additional checks needed" for low risk

---
*Analyzed by [InariWatch](https://inariwatch.com) — AI pre-deploy risk assessment*

RULES:
1. Be specific — reference actual file names and line changes from the diff.
2. Do NOT be alarmist. Most PRs are low risk. Only flag medium/high if there is a real reason.
3. Keep the entire response under 300 words.`;

interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export function buildPrompt(
  title: string,
  body: string,
  files: PRFile[],
  diff: string
): string {
  const fileList = files
    .map((f) => `  ${f.status.padEnd(10)} ${f.filename} (+${f.additions} -${f.deletions})`)
    .join("\n");

  const truncatedDiff = diff.length > 8000 ? diff.slice(0, 8000) + "\n... (truncated)" : diff;
  const truncatedBody = body ? body.slice(0, 500) : "(no description)";

  const totalAdded = files.reduce((s, f) => s + f.additions, 0);
  const totalRemoved = files.reduce((s, f) => s + f.deletions, 0);

  const depFiles = files.filter(
    (f) =>
      f.filename.includes("package.json") ||
      f.filename.includes("Cargo.toml") ||
      f.filename.includes("requirements.txt") ||
      f.filename.includes("go.mod")
  );

  return `# Pull Request: ${title}

## Description
${truncatedBody}

## Files Changed (${files.length} files, +${totalAdded} -${totalRemoved})
${fileList}
${depFiles.length > 0 ? `\n⚠ Dependency files modified: ${depFiles.map((f) => f.filename).join(", ")}` : ""}

## Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

Analyze this PR and provide your risk assessment.`;
}
