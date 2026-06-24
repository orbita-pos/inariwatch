export type IntentKind =
  | "list_alerts"
  | "status_summary"
  | "uptime_monitors"
  | "recent_deploys"
  | "oncall_status"
  | "help"
  | "open_player"
  | "error_trends"
  | "root_cause"
  | "set_project"
  | "ack_alert"
  | "silence_alert"
  | "greeting";

export interface L0Match {
  intent: IntentKind;
  confidence: number;
  /** Extracted params — `hash` for open_player, empty for the rest in L0. */
  params: Record<string, string | number>;
}
