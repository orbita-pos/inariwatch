/**
 * Expo EAS Build poller — monitors build failures, deploy errors, update failures.
 * Follows the same pattern as github.ts and sentry.ts.
 */

import type { NewAlert } from "@/lib/db/schema";

export interface ExpoAlertConfig {
  build_failure?: { enabled: boolean };
  deploy_failure?: { enabled: boolean };
  update_failure?: { enabled: boolean };
}

const EAS_API = "https://api.expo.dev/v2";

async function expoFetch(token: string, path: string) {
  return fetch(`${EAS_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "InariWatch-Monitor/1.0",
      Accept: "application/json",
    },
    next: { revalidate: 0 },
  });
}

export async function pollExpo(
  token: string,
  config: ExpoAlertConfig
): Promise<Omit<NewAlert, "projectId">[]> {
  const alerts: Omit<NewAlert, "projectId">[] = [];

  // Get user's apps
  const appsResp = await expoFetch(token, "/users/me/projects");
  if (!appsResp.ok) return alerts;
  const appsData = await appsResp.json();
  const apps = (appsData.data ?? []) as { id: string; fullName: string; slug: string }[];

  for (const app of apps.slice(0, 10)) {
    // Check build failures
    if (config.build_failure?.enabled !== false) {
      try {
        const buildsResp = await expoFetch(token, `/projects/${app.id}/builds?limit=5`);
        if (buildsResp.ok) {
          const buildsData = await buildsResp.json();
          const builds = (buildsData.data ?? []) as {
            id: string;
            status: string;
            platform: string;
            error?: { message?: string };
            createdAt: string;
            completedAt?: string;
          }[];

          for (const build of builds) {
            if (build.status === "errored" || build.status === "canceled") {
              const age = Date.now() - new Date(build.createdAt).getTime();
              if (age > 24 * 60 * 60 * 1000) continue; // Skip builds older than 24h

              alerts.push({
                severity: "critical",
                title: `EAS Build failed: ${app.slug} (${build.platform})`,
                body: [
                  `Build ${build.id} for ${app.fullName} failed.`,
                  `Platform: ${build.platform}`,
                  `Status: ${build.status}`,
                  build.error?.message ? `Error: ${build.error.message}` : "",
                  `Created: ${build.createdAt}`,
                ].filter(Boolean).join("\n"),
                sourceIntegrations: ["expo"],
                isRead: false,
                isResolved: false,
              });
            }
          }
        }
      } catch {}
    }

    // Check EAS Update failures
    if (config.update_failure?.enabled !== false) {
      try {
        const updatesResp = await expoFetch(token, `/projects/${app.id}/updates?limit=5`);
        if (updatesResp.ok) {
          const updatesData = await updatesResp.json();
          const updates = (updatesData.data ?? []) as {
            id: string;
            group: string;
            runtimeVersion: string;
            platform: string;
            createdAt: string;
            isRollBackToEmbedded?: boolean;
          }[];

          for (const update of updates) {
            if (update.isRollBackToEmbedded) {
              const age = Date.now() - new Date(update.createdAt).getTime();
              if (age > 24 * 60 * 60 * 1000) continue;

              alerts.push({
                severity: "warning",
                title: `EAS Update rolled back: ${app.slug} (${update.platform})`,
                body: [
                  `Update ${update.id} for ${app.fullName} was rolled back to embedded.`,
                  `Runtime: ${update.runtimeVersion}`,
                  `Platform: ${update.platform}`,
                  `Created: ${update.createdAt}`,
                ].filter(Boolean).join("\n"),
                sourceIntegrations: ["expo"],
                isRead: false,
                isResolved: false,
              });
            }
          }
        }
      } catch {}
    }
  }

  return alerts;
}
