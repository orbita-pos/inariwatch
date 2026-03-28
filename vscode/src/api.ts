import type { ExtensionAlert, ApiConfig } from "./types.js"

export async function fetchAlerts(config: ApiConfig): Promise<ExtensionAlert[]> {
  const res = await fetch(`${config.baseUrl}/api/extension/alerts`, {
    headers: { Authorization: `Bearer ${config.token}` },
  })

  if (res.status === 401) throw new Error("Invalid or expired token")
  if (!res.ok) throw new Error(`API error: ${res.status}`)

  const data = await res.json()
  return (data as ExtensionAlert[]).map((a) => ({ ...a, source: "cloud" as const }))
}

export async function markAlertRead(config: ApiConfig, alertId: string): Promise<void> {
  const res = await fetch(`${config.baseUrl}/api/extension/alerts/${alertId}/read`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
  })
  if (!res.ok) throw new Error(`Failed to mark read: ${res.status}`)
}

export async function resolveAlert(config: ApiConfig, alertId: string): Promise<void> {
  const res = await fetch(`${config.baseUrl}/api/extension/alerts/${alertId}/resolve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
  })
  if (!res.ok) throw new Error(`Failed to resolve: ${res.status}`)
}

export function createSSEStream(
  config: ApiConfig,
  onAlert: (alert: ExtensionAlert) => void,
  onError: (err: Error) => void,
): AbortController {
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(`${config.baseUrl}/api/extension/alerts/stream`, {
        headers: { Authorization: `Bearer ${config.token}` },
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        onError(new Error(`SSE failed: ${res.status}`))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const alert = JSON.parse(line.slice(6)) as ExtensionAlert
              onAlert({ ...alert, source: "cloud" })
            } catch {
              // skip malformed events
            }
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return controller
}
