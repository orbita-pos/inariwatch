export interface ExtensionAlert {
  id: string
  title: string
  body: string
  severity: "critical" | "warning" | "info"
  aiReasoning: string | null
  postmortem: string | null
  fingerprint: string | null
  isRead: boolean
  isResolved: boolean
  sourceIntegrations: string[]
  projectName: string
  createdAt: string
  /** Mapped workspace file locations (computed client-side from stack trace) */
  locations?: AlertLocation[]
  /** Source: cloud API or local capture */
  source: "cloud" | "local"
}

export interface AlertLocation {
  filePath: string
  line: number
  column: number
  frame: string
}

export interface ApiConfig {
  baseUrl: string
  token: string
}
