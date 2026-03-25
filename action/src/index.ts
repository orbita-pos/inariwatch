import * as core from "@actions/core";
import * as github from "@actions/github";
import { callAI } from "./ai";
import { SYSTEM_RISK, buildPrompt } from "./prompt";

const COMMENT_MARKER = "<!-- inariwatch-risk -->";

async function run(): Promise<void> {
  try {
    const aiKey = core.getInput("ai-key", { required: true });
    const model = core.getInput("model") || undefined;
    const minLines = parseInt(core.getInput("min-lines") || "5", 10);

    const { context } = github;
    if (!context.payload.pull_request) {
      core.info("Not a pull request event — skipping.");
      return;
    }

    const pr = context.payload.pull_request;
    const prNumber = pr.number;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    const token = core.getInput("github-token") || process.env.GITHUB_TOKEN || "";
    const octokit = github.getOctokit(token);

    core.info(`Analyzing PR #${prNumber}: ${pr.title}`);

    // Fetch PR files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const totalChanges = files.reduce((s, f) => s + f.additions + f.deletions, 0);
    if (totalChanges < minLines) {
      core.info(`Only ${totalChanges} lines changed (< ${minLines}) — skipping.`);
      return;
    }

    // Fetch diff
    const { data: diff } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });

    // Build prompt
    const prFiles = files.map((f) => ({
      filename: f.filename,
      status: f.status ?? "modified",
      additions: f.additions,
      deletions: f.deletions,
    }));

    const prompt = buildPrompt(
      pr.title,
      pr.body || "",
      prFiles,
      typeof diff === "string" ? diff : String(diff)
    );

    // Call AI
    core.info("Calling AI for risk assessment...");
    const assessment = await callAI(aiKey, SYSTEM_RISK, prompt, {
      model,
      maxTokens: 1024,
    });

    if (!assessment.trim()) {
      core.warning("AI returned empty response — skipping comment.");
      return;
    }

    // Extract risk level for output
    const riskMatch = assessment.match(/Risk Level:\*?\*?\s*(.*?)$/m);
    let riskLevel = "unknown";
    if (riskMatch) {
      const raw = riskMatch[1].toLowerCase();
      if (raw.includes("low")) riskLevel = "low";
      else if (raw.includes("medium")) riskLevel = "medium";
      else if (raw.includes("high")) riskLevel = "high";
    }

    core.setOutput("risk-level", riskLevel);
    core.info(`Risk level: ${riskLevel}`);

    // Build comment body
    const commentBody = `${COMMENT_MARKER}\n${assessment}`;

    // Find existing comment
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const existing = comments.find(
      (c) => c.body?.includes(COMMENT_MARKER)
    );

    if (existing) {
      // Update existing comment
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body: commentBody,
      });
      core.info(`Updated existing comment #${existing.id}`);
    } else {
      // Create new comment
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: commentBody,
      });
      core.info("Posted risk assessment comment.");
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
