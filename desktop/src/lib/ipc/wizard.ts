/**
 * Typed wrappers around the Tauri IPC commands the Add-Project wizard
 * exposes. Mirrors `desktop/src-tauri/src/ipc/wizard.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WizardPayload {
  projectId:    string;
  projectSlug:  string;
  repoFullName: string;
  framework:    string | null;
  host:         string | null;
  createdAt:    string;
}

export interface DetectionResult {
  path:      string | null;
  framework: string | null;
  host:      string | null;
}

export interface InstallArgs {
  projectId: string;
  repoPath:  string;
  framework: string;
  host:      string | null;
}

export interface InstallResult {
  adopted:        boolean;
  mint_id:        string;
  fingerprint:    string;
  dsn_masked:     string;
  vercel_synced:  boolean;
  vercel_warning: string | null;
}

export interface RunDevArgs {
  projectId: string;
  repoPath:  string;
  script?:   string | null;
}

export interface RunDevResult {
  pid:      number | null;
  injected: boolean;
  note:     string | null;
}

/**
 * Per-step progress event delivered through Tauri's `wizard:progress`
 * channel. Each emit carries a stage tag (matches the step ordering
 * in install.rs / dev.rs), a human-readable message, and an optional
 * fraction the UI uses to drive the progress bar.
 */
export interface WizardProgress {
  projectId: string;
  /**
   * `install.npm`, `install.patch_config`, `install.env_local`,
   * `install.mint_token`, `install.sync_vercel`, `install.adopt`,
   * `install.done`, `dev.spawn`, `dev.stdout`, `dev.stderr`,
   * `dev.ready`, `dev.test_event`, `dev.test_event_acked`,
   * `dev.test_event_failed`, or `error`.
   */
  stage:    string;
  message:  string;
  fraction: number | null;
}

export const EVT_WIZARD_OPENED = "wizard:opened";
export const EVT_WIZARD_PROGRESS = "wizard:progress";

// ── Commands ────────────────────────────────────────────────────────────────

export async function wizardGetPending(): Promise<WizardPayload | null> {
  return invoke<WizardPayload | null>("wizard_get_pending");
}

export async function wizardDismiss(): Promise<void> {
  await invoke("wizard_dismiss");
}

export async function wizardDetectClone(repoFullName: string): Promise<DetectionResult> {
  return invoke<DetectionResult>("wizard_detect_clone", { repoFullName });
}

export async function wizardRunInstall(args: InstallArgs): Promise<InstallResult> {
  return invoke<InstallResult>("wizard_run_install", { args });
}

export async function wizardRunDev(args: RunDevArgs): Promise<RunDevResult> {
  return invoke<RunDevResult>("wizard_run_dev", { args });
}

export async function wizardInjectTestEvent(projectId: string): Promise<void> {
  await invoke("wizard_inject_test_event", { projectId });
}

// ── Session 4 — Tier 2 deeplink + clipboard helpers ─────────────────────────

/**
 * Pushes the freshly-minted DSN/token onto the OS clipboard. The wizard
 * uses this for Tier 2 hosts (Netlify / Railway / Fly / …) so the user
 * can paste straight into the host's env-vars page.
 *
 * Server-side guard caps the payload at 4 KiB and rejects empty input;
 * surfaces a string error otherwise.
 */
export async function wizardCopyToClipboard(text: string): Promise<void> {
  await invoke("wizard_copy_to_clipboard", { text });
}

/**
 * Opens an HTTPS URL in the user's default browser. Used to deeplink
 * the host's env-vars dashboard for Tier 2 hosts. Non-http(s) schemes
 * are rejected server-side.
 */
export async function wizardOpenHostDashboard(url: string): Promise<void> {
  await invoke("wizard_open_host_dashboard", { url });
}

/**
 * Reads the project's freshly-minted DSN from the OS keyring backup
 * and pushes it onto the clipboard, all server-side. The plaintext
 * never crosses the IPC boundary; the React caller only gets back the
 * masked fingerprint to render in the confirmation copy.
 *
 * Throws when the install pipeline hasn't run yet (no keyring backup).
 */
export async function wizardCopyProjectTokenToClipboard(projectId: string): Promise<string> {
  return invoke<string>("wizard_copy_project_token_to_clipboard", { projectId });
}

// ── Event listeners ─────────────────────────────────────────────────────────

export async function onWizardOpened(handler: (payload: WizardPayload) => void): Promise<UnlistenFn> {
  return listen<WizardPayload>(EVT_WIZARD_OPENED, (e) => handler(e.payload));
}

export async function onWizardProgress(handler: (payload: WizardProgress) => void): Promise<UnlistenFn> {
  return listen<WizardProgress>(EVT_WIZARD_PROGRESS, (e) => handler(e.payload));
}
