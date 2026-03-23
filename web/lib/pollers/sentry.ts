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
  level: string;
  permalink?: string;
  shortId?: string;
  firstSeen?: string;
  project: { slug: string };
  assignedTo?: { name?: string; email?: string } | null;
}

export async function pollSentry(
  token: string,
  org: string,
  config: SentryAlertConfig = {},
  lookbackMinutes = 10
): Promise<Omit<NewAlert, "projectId">[]> {
  const results: Omit<NewAlert, "projectId">[] = [];

  if (!org) return results;

  const checkNew         = config.new_issues?.enabled  !== false;
  const checkRegressions = config.regressions?.enabled !== false;

  // Query issues seen in the last lookbackMinutes
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

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

    const level = issue.level ?? "error";
    const severity = issue.isRegression ? "critical" : (level === "fatal" ? "critical" : "warning");
    const firstSeen = issue.firstSeen
      ? new Date(issue.firstSeen).toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "";
    const assignedName = issue.assignedTo ? (issue.assignedTo.name ?? issue.assignedTo.email ?? "") : "";

    const bodyParts = [
      issue.culprit ? `In: ${issue.culprit}` : "",
      issue.shortId ? `ID: ${issue.shortId}` : "",
      `${issue.count} events · ${issue.userCount} user(s) affected`,
      `Project: ${issue.project.slug}`,
      firstSeen ? `First seen: ${firstSeen}` : "",
      assignedName ? `Assigned to: ${assignedName}` : "",
      issue.permalink ? `View in Sentry: ${issue.permalink}` : "",
    ].filter(Boolean).join("\n");

    results.push({
      severity,
      title: `${issue.isRegression ? "[Regression]" : "[New Issue]"} ${issue.title}`,
      body: bodyParts,
      sourceIntegrations: ["sentry"],
      isRead: false,
      isResolved: false,
    });
  }

  return results;
}
