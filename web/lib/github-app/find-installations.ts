/**
 * GitHub App installation lookup — App-JWT-only path (no user OAuth).
 *
 * GitHub exposes two App-level endpoints that take a JWT and return the
 * single installation belonging to a given login (404 if no install):
 *
 *   GET /users/{username}/installation
 *   GET /orgs/{org}/installation
 *
 * We try both, in that order, and return the first hit. This lets the
 * `/integrations` modal show "Connect to existing installation" without
 * forcing the user back through the github.com install flow when the App
 * is already installed.
 *
 * Security note: this function alone proves an installation EXISTS — it
 * does NOT prove the caller is the account owner. Connect endpoints must
 * verify ownership through a separate signal (project ownership ± paired
 * NextAuth GitHub session) before persisting installation_id.
 */

import { ghFetchApp } from "./octokit";

export type FoundInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  accountId: number;
  /** Repository selection mode — "all" or "selected". UI uses this to hint when access is partial. */
  repositorySelection: "all" | "selected";
};

type RawInstallation = {
  id: number;
  account: { login: string; type: string; id: number };
  repository_selection: "all" | "selected";
  suspended_at: string | null;
};

async function tryEndpoint(path: string): Promise<FoundInstallation | null> {
  let res: Response;
  try {
    res = await ghFetchApp(path);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as RawInstallation | null;
  if (!json || json.suspended_at) return null;
  const accountType = json.account.type === "Organization" ? "Organization" : "User";
  return {
    installationId: json.id,
    accountLogin: json.account.login,
    accountType,
    accountId: json.account.id,
    repositorySelection: json.repository_selection,
  };
}

/**
 * Look up an installation by login. Tries user endpoint first, falls back
 * to org endpoint. Returns null if the App isn't installed on either.
 */
export async function findInstallationByLogin(
  login: string,
): Promise<FoundInstallation | null> {
  if (!login || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) {
    // GitHub login rules: 1-39 chars, alphanumeric + single dashes, no
    // leading/trailing dash. Reject early to avoid burning App rate-limit
    // on obviously-invalid input from a typo'd field.
    return null;
  }
  const userHit = await tryEndpoint(`/users/${encodeURIComponent(login)}/installation`);
  if (userHit) return userHit;
  return tryEndpoint(`/orgs/${encodeURIComponent(login)}/installation`);
}
