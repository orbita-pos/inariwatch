import type { NewAlert } from "@/lib/db";

export interface GithubAlertConfig {
  stale_pr?:      { enabled: boolean; days: number };
  failed_ci?:     { enabled: boolean };
  unreviewed_pr?: { enabled: boolean; hours: number };
  repoFilter?:    string[];
}

interface Repo {
  full_name: string;
  name: string;
  default_branch: string;
}

interface PullRequest {
  number: number;
  title: string;
  draft: boolean;
  html_url?: string;
  updated_at: string;
  created_at: string;
  user?: { login?: string };
  requested_reviewers: { login?: string }[];
}

interface CheckRun {
  name: string;
  conclusion: string | null;
  html_url?: string;
  details_url?: string;
  started_at?: string;
  completed_at?: string;
  output?: { summary?: string | null };
}

function gh(token: string, path: string) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "InariWatch-Monitor/1.0",
      Accept: "application/vnd.github+json",
    },
    next: { revalidate: 0 },
  });
}

export async function pollGitHub(
  token: string,
  owner: string,
  config: GithubAlertConfig = {}
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  const staleDays    = config.stale_pr?.days    ?? 3;
  const reviewHours  = config.unreviewed_pr?.hours ?? 24;
  const checkCi      = config.failed_ci?.enabled      !== false;
  const checkStale   = config.stale_pr?.enabled        !== false;
  const checkReview  = config.unreviewed_pr?.enabled   !== false;

  // Fetch repos (most recently pushed, up to 20)
  const reposRes = await gh(token, `/user/repos?affiliation=owner,collaborator&per_page=20&sort=pushed`);
  if (!reposRes.ok) return results;
  const repos: Repo[] = await reposRes.json();

  const repoFilter = config.repoFilter;
  const filteredRepos = repoFilter && repoFilter.length > 0
    ? repos.filter((r) => repoFilter.includes(r.full_name))
    : repos.slice(0, 15);

  for (const repo of filteredRepos) {
    // ── Failed CI ──────────────────────────────────────────────────────────────
    if (checkCi) {
      const ciRes = await gh(token, `/repos/${repo.full_name}/commits/${repo.default_branch}/check-runs?per_page=20`);
      if (ciRes.ok) {
        const { check_runs }: { check_runs: CheckRun[] } = await ciRes.json();
        const failed = check_runs.filter(
          (r) => r.conclusion === "failure" || r.conclusion === "timed_out"
        );
        if (failed.length > 0) {
          const failDetails = failed.slice(0, 5).map((r) => {
            const url = r.html_url ?? r.details_url ?? "";
            const durationSec =
              r.started_at && r.completed_at
                ? Math.round((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000)
                : null;
            const duration = durationSec
              ? ` (${durationSec >= 60 ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : `${durationSec}s`})`
              : "";
            const summary = r.output?.summary ? `\n  ${r.output.summary.slice(0, 100)}` : "";
            return `• ${r.name}: ${r.conclusion}${duration}${url ? `\n  ${url}` : ""}${summary}`;
          }).join("\n");

          results.push({
            severity: "critical",
            title: `CI failing on ${repo.name}/${repo.default_branch}`,
            body: `${failed.length} check(s) failed:\n\n${failDetails}`,
            sourceIntegrations: ["github"],
            isRead: false,
            isResolved: false,
          });
        }
      }
    }

    // ── Open PRs (stale + unreviewed) ──────────────────────────────────────────
    if (checkStale || checkReview) {
      const prsRes = await gh(token, `/repos/${repo.full_name}/pulls?state=open&per_page=30`);
      if (prsRes.ok) {
        const prs: PullRequest[] = await prsRes.json();
        const openPrs = prs.filter((pr) => !pr.draft);

        if (checkStale) {
          const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
          const stale = openPrs.filter((pr) => new Date(pr.updated_at).getTime() < cutoff);
          if (stale.length > 0) {
            const prList = stale.slice(0, 5).map((pr) => {
              const author = pr.user?.login ? ` by @${pr.user.login}` : "";
              const days = Math.floor((Date.now() - new Date(pr.updated_at).getTime()) / 86400000);
              return `• #${pr.number}: ${pr.title}${author} (no activity for ${days}d)${pr.html_url ? `\n  ${pr.html_url}` : ""}`;
            }).join("\n");
            results.push({
              severity: "warning",
              title: `${stale.length} stale PR(s) in ${repo.name}`,
              body: `PRs with no activity for ${staleDays}+ days:\n\n${prList}`,
              sourceIntegrations: ["github"],
              isRead: false,
              isResolved: false,
            });
          }
        }

        if (checkReview) {
          const cutoff = Date.now() - reviewHours * 60 * 60 * 1000;
          const unreviewed = openPrs.filter(
            (pr) =>
              pr.requested_reviewers.length > 0 &&
              new Date(pr.created_at).getTime() < cutoff
          );
          if (unreviewed.length > 0) {
            const prList = unreviewed.slice(0, 5).map((pr) => {
              const author = pr.user?.login ? ` by @${pr.user.login}` : "";
              const reviewers = pr.requested_reviewers.map((r) => `@${r.login}`).join(", ");
              const hours = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / 3600000);
              return `• #${pr.number}: ${pr.title}${author} (${hours}h old)\n  Waiting on: ${reviewers}${pr.html_url ? `\n  ${pr.html_url}` : ""}`;
            }).join("\n");
            results.push({
              severity: "warning",
              title: `${unreviewed.length} PR(s) awaiting review in ${repo.name}`,
              body: `PRs waiting for review for ${reviewHours}+ hours:\n\n${prList}`,
              sourceIntegrations: ["github"],
              isRead: false,
              isResolved: false,
            });
          }
        }
      }
    }
  }

  return results;
}
