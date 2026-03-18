import type { NewAlert } from "@/lib/db";

export interface SentryAlertConfig {
  new_issues?:          { enabled: boolean };
  regressions?:         { enabled: boolean };
  sentryProjectFilter?: string[];
}

interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  isNew: boolean;
  isRegression: boolean;
  count: string;
  userCount: number;
  project: { slug: string };
}

export async function pollSentry(
  token: string,
  org: string,
  config: SentryAlertConfig = {}
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  if (!org) return results;

  const checkNew         = config.new_issues?.enabled  !== false;
  const checkRegressions = config.regressions?.enabled !== false;

  // Query issues seen in the last 10 minutes
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const res = await fetch(
    `https://sentry.io/api/0/organizations/${org}/issues/?query=firstSeen%3A%3E${encodeURIComponent(since)}&limit=25`,
    {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 0 },
    }
  );
  if (!res.ok) return results;

  const issues: SentryIssue[] = await res.json();

  const sentryProjectFilter = config.sentryProjectFilter;

  for (const issue of issues) {
    if (sentryProjectFilter && sentryProjectFilter.length > 0 && !sentryProjectFilter.includes(issue.project.slug)) continue;
    if (issue.isNew && !checkNew)               continue;
    if (issue.isRegression && !checkRegressions) continue;
    if (!issue.isNew && !issue.isRegression)     continue;

    results.push({
      severity: issue.isRegression ? "critical" : "warning",
      title: `${issue.isRegression ? "[Regression]" : "[New Issue]"} ${issue.title}`,
      body: `${issue.culprit} · ${issue.count} events · ${issue.userCount} user(s) affected`,
      sourceIntegrations: ["sentry"],
      isRead: false,
      isResolved: false,
    });
  }

  return results;
}
