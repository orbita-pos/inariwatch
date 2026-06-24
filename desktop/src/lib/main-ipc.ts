/**
 * IPC wrappers for the Sesión-17 main window + onboarding surface.
 *
 * Mirrors `dock-ipc.ts`'s pattern: each helper calls `invoke()` and
 * degrades gracefully if the Tauri command isn't registered (e.g. when
 * running under vitest/jsdom). Tests mock at this boundary by passing
 * `vi.mock("@/lib/main-ipc", …)` rather than at `@tauri-apps/api/core`.
 */

import { invoke } from "@tauri-apps/api/core";

// ── DTOs ─────────────────────────────────────────────────────────────
//
// Hand-written shapes (matching `web/src-tauri/src/ipc/{settings,onboarding,
// sensors,window}.rs`). When `cargo test --lib` regenerates ts-rs bindings
// these can be re-exported from `@/lib/types/` directly.

export interface GeneralSettings {
  theme: "auto" | "light" | "dark";
  language: string;
  sound_on_critical: boolean;
}

export interface NotificationsSettings {
  notification_level: "silent" | "important" | "all";
  sound_volume: number;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_tz: string;
  respect_focus_mode: boolean;
}

export interface AiSettings {
  byok_present: boolean;
  byok_preview: string;
  model_routing: "auto" | "always_mini" | "always_full";
  spend_today_usd: number;
  spend_cap_usd: number;
  /** Whether the local LLM (SmolLM2 Q4) is used instead of the cloud API. */
  local_chat_enabled: boolean;
}

export interface LocalAiStatusDto {
  /** "idle" | "loading" | "ready" | "failed" */
  status: string;
  model: string;
  ram_mb: number;
  error: string;
}

export interface PrivacySettings {
  telemetry_optout: boolean;
  local_only_mode: boolean;
}

export interface AboutInfo {
  version: string;
  commit: string | null;
  channel: "stable" | "beta";
  last_update_check_ms: number;
}

export interface UpdateCheckResult {
  status: "idle" | "pending" | "ready";
  message: string;
  checked_at_ms: number;
}

export interface SensorsState {
  fs_enabled: boolean;
  mcp_always_on: boolean;
  shell_installed: string[];
  git_hooks_count: number;
  http_proxy_enabled: boolean;
  http_proxy_port: number;
  substrate_any_repo: boolean;
}

export interface ShellHooksStatus {
  installed_for: string[];
  daemon_listening: boolean;
}

export interface OnboardingProgress {
  stage: "scanning" | "indexing" | "done";
  percent: number;
  symbol_count: number;
}

export interface OnboardingRepo {
  id: string;
  path: string;
  name: string;
  already_registered: boolean;
}

export interface PowerUpResult {
  success: boolean;
  message: string;
}

export interface OnboardingState {
  onboarded: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────

async function invokeOrFallback<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
  context: string,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    console.info(`[main-ipc] ${command} unavailable: ${context}`, e);
    return fallback;
  }
}

// ── Settings — General ───────────────────────────────────────────────

export const DEFAULT_GENERAL: GeneralSettings = {
  theme: "auto",
  language: "en",
  sound_on_critical: true,
};

export async function getGeneralSettings(): Promise<GeneralSettings> {
  return invokeOrFallback("get_general_settings", undefined, DEFAULT_GENERAL, "default returned");
}

export async function setGeneralSettings(
  patch: Partial<GeneralSettings>,
): Promise<GeneralSettings> {
  return invokeOrFallback(
    "set_general_settings",
    { patch },
    { ...DEFAULT_GENERAL, ...patch } as GeneralSettings,
    "applying optimistically without persistence",
  );
}

// ── Settings — Notifications ─────────────────────────────────────────

export const DEFAULT_NOTIFICATIONS: NotificationsSettings = {
  notification_level: "important",
  sound_volume: 70,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  respect_focus_mode: true,
};

export async function getNotificationsSettings(): Promise<NotificationsSettings> {
  return invokeOrFallback("get_notifications_settings", undefined, DEFAULT_NOTIFICATIONS, "default");
}

export async function setNotificationsSettings(
  patch: Partial<NotificationsSettings>,
): Promise<NotificationsSettings> {
  return invokeOrFallback(
    "set_notifications_settings",
    { patch },
    { ...DEFAULT_NOTIFICATIONS, ...patch },
    "applying optimistically",
  );
}

// ── Settings — AI ────────────────────────────────────────────────────

export const DEFAULT_AI: AiSettings = {
  byok_present: false,
  byok_preview: "",
  model_routing: "auto",
  spend_today_usd: 0,
  spend_cap_usd: 300,
  local_chat_enabled: false,
};

export async function getAiSettings(): Promise<AiSettings> {
  return invokeOrFallback("get_ai_settings", undefined, DEFAULT_AI, "default");
}

export async function setAiSettings(patch: {
  openai_key?: string;
  model_routing?: AiSettings["model_routing"];
  local_chat_enabled?: boolean;
}): Promise<AiSettings> {
  return invokeOrFallback("set_ai_settings", { patch }, DEFAULT_AI, "no persistence");
}

// ── Local AI ─────────────────────────────────────────────────────────────────

const FALLBACK_LOCAL_AI_STATUS: LocalAiStatusDto = {
  status: "idle",
  model: "SmolLM2-1.7B-Instruct Q4_K_M",
  ram_mb: 1100,
  error: "",
};

/** Trigger background model download + load. Idempotent. */
export async function localAiLoad(): Promise<LocalAiStatusDto> {
  return invokeOrFallback("local_ai_load", undefined, FALLBACK_LOCAL_AI_STATUS, "stub");
}

/** Return the current load phase without blocking. */
export async function localAiStatus(): Promise<LocalAiStatusDto> {
  return invokeOrFallback("local_ai_status", undefined, FALLBACK_LOCAL_AI_STATUS, "stub");
}

// ── Settings — Privacy ───────────────────────────────────────────────

export const DEFAULT_PRIVACY: PrivacySettings = {
  telemetry_optout: false,
  local_only_mode: false,
};

export async function getPrivacySettings(): Promise<PrivacySettings> {
  return invokeOrFallback("get_privacy_settings", undefined, DEFAULT_PRIVACY, "default");
}

export async function setPrivacySettings(
  patch: Partial<PrivacySettings>,
): Promise<PrivacySettings> {
  return invokeOrFallback(
    "set_privacy_settings",
    { patch },
    { ...DEFAULT_PRIVACY, ...patch },
    "applying optimistically",
  );
}

// ── Settings — About ─────────────────────────────────────────────────

const FALLBACK_ABOUT: AboutInfo = {
  version: "0.1.0",
  commit: null,
  channel: "stable",
  last_update_check_ms: 0,
};

export async function getAboutInfo(): Promise<AboutInfo> {
  return invokeOrFallback("get_about_info", undefined, FALLBACK_ABOUT, "fallback");
}

export async function setReleaseChannel(channel: "stable" | "beta"): Promise<AboutInfo> {
  return invokeOrFallback(
    "set_release_channel",
    { patch: { channel } },
    { ...FALLBACK_ABOUT, channel },
    "no persistence",
  );
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invokeOrFallback(
    "check_for_updates",
    undefined,
    { status: "idle", message: "Updater offline", checked_at_ms: Date.now() },
    "stub",
  );
}

// ── Sensors ──────────────────────────────────────────────────────────

const DEFAULT_SENSORS: SensorsState = {
  fs_enabled: true,
  mcp_always_on: true,
  shell_installed: [],
  git_hooks_count: 0,
  http_proxy_enabled: false,
  http_proxy_port: 9876,
  substrate_any_repo: false,
};

export async function getSensorsState(): Promise<SensorsState> {
  return invokeOrFallback("get_sensors_state", undefined, DEFAULT_SENSORS, "default");
}

export async function setSensorEnabled(
  sensorKind: string,
  enabled: boolean,
): Promise<SensorsState> {
  return invokeOrFallback(
    "set_sensor_enabled",
    { patch: { sensor_kind: sensorKind, enabled } },
    DEFAULT_SENSORS,
    "applying optimistically",
  );
}

export async function getShellHooksStatus(): Promise<ShellHooksStatus> {
  return invokeOrFallback(
    "shell_hooks_status",
    undefined,
    { installed_for: [], daemon_listening: false },
    "default",
  );
}

export async function installShellHooks(
  shellKind: "zsh" | "bash" | "fish",
): Promise<ShellHooksStatus> {
  return invokeOrFallback(
    "install_shell_hooks",
    { shellKind },
    { installed_for: [shellKind], daemon_listening: false },
    "stub success",
  );
}

export async function uninstallShellHooks(
  shellKind: "zsh" | "bash" | "fish",
): Promise<ShellHooksStatus> {
  return invokeOrFallback(
    "uninstall_shell_hooks",
    { shellKind },
    { installed_for: [], daemon_listening: false },
    "stub",
  );
}

export async function setReplayEnabled(repoId: string, enabled: boolean): Promise<void> {
  await invokeOrFallback(
    "set_replay_enabled",
    { repoId, enabled },
    { repo_id: repoId, enabled },
    "no persistence",
  );
}

export async function installVscodeExtension(): Promise<PowerUpResult> {
  return invokeOrFallback(
    "install_vscode_extension",
    undefined,
    { success: true, message: "Queued (Sesión 22 finishes wiring)" },
    "stub",
  );
}

export async function configureHttpProxy(port: number): Promise<PowerUpResult> {
  return invokeOrFallback(
    "configure_http_proxy",
    { port },
    { success: true, message: `Queued on ${port} (Sesión 19 finishes wiring)` },
    "stub",
  );
}

// ── Onboarding ───────────────────────────────────────────────────────

export async function onboardingOpenRepo(path: string): Promise<OnboardingRepo> {
  return invoke<OnboardingRepo>("onboarding_open_repo", { path });
}

export async function onboardingProgress(repoId: string): Promise<OnboardingProgress> {
  return invokeOrFallback(
    "onboarding_progress",
    { repoId },
    { stage: "scanning", percent: 0, symbol_count: 0 },
    "no progress",
  );
}

export async function completeOnboarding(): Promise<OnboardingState> {
  return invokeOrFallback("complete_onboarding", undefined, { onboarded: true }, "stub");
}

export async function isOnboarded(): Promise<OnboardingState> {
  return invokeOrFallback("is_onboarded", undefined, { onboarded: false }, "default unboarded");
}

// ── Window ───────────────────────────────────────────────────────────

export async function navigateTo(target: "dock" | "main" | "onboarding", route: string): Promise<void> {
  await invokeOrFallback("navigate", { target, route }, undefined, "no-op");
}

// Re-exports `dock-ipc.ts` already owns — the dock side keeps that file
// as the source of truth; here we just expose the main-window pair.
export { openMainWindow, hideDock } from "@/lib/dock-ipc";

// ── Pairing (S8) ─────────────────────────────────────────────────────

export type PairingKind = "phone" | "device";

export interface PendingPairingDto {
  id: string;
  code: string;
  /** Display form `XXXX-XXXX`. */
  code_chunked: string;
  kind: PairingKind;
  created_at_ms: number;
  expires_at_ms: number;
}

export interface PairedEntityDto {
  id: string;
  kind: PairingKind;
  display_name: string;
  /** Already redacted by the backend (last 4 of phone, etc.). */
  redacted_identifier: string;
  paired_at_ms: number;
  last_seen_at_ms: number;
}

export async function pairingGenerate(kind: PairingKind): Promise<PendingPairingDto> {
  return invoke<PendingPairingDto>("desktop_pairing_generate", { kind });
}

export async function pairingList(): Promise<PairedEntityDto[]> {
  return invokeOrFallback("desktop_pairing_list", undefined, [] as PairedEntityDto[], "no list");
}

export async function pairingRevoke(entityId: string): Promise<void> {
  await invoke("desktop_pairing_revoke", { entityId });
}

export async function pairingConfirm(
  challengeId: string,
  approve: boolean,
): Promise<PairedEntityDto | null> {
  return invoke<PairedEntityDto | null>("desktop_pairing_confirm", { challengeId, approve });
}

export async function pairingCleanup(): Promise<number> {
  return invokeOrFallback("desktop_pairing_cleanup", undefined, 0, "no cleanup");
}

// ── Mobile pairing (S12) ─────────────────────────────────────────────

export interface MobilePairingStartDto {
  challenge_id:  string;
  code:          string;
  code_chunked:  string;
  created_at_ms: number;
  expires_at_ms: number;
}

export interface MobilePairingConfirmDto {
  resolved:  boolean;
  approved:  boolean;
  device_id: string | null;
}

/** Mint a Crockford code locally + announce it to web. */
export async function mobilePairingGenerate(): Promise<MobilePairingStartDto> {
  return invoke<MobilePairingStartDto>("desktop_mobile_pairing_generate");
}

/** Forward the user's Yes/No on the SAS modal to web's `_confirm` webhook. */
export async function mobilePairingConfirm(
  challengeId: string,
  approve: boolean,
): Promise<MobilePairingConfirmDto> {
  return invoke<MobilePairingConfirmDto>("desktop_mobile_pairing_confirm", {
    challengeId,
    approve,
  });
}
