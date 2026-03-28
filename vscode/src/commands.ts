import * as vscode from "vscode"
import type { AlertStore } from "./store.js"
import type { AlertsTreeProvider } from "./tree-provider.js"
import type { DiagnosticsManager } from "./diagnostics.js"
import type { ApiConfig } from "./types.js"
import { promptForToken, deleteToken, getToken } from "./auth.js"
import { fetchAlerts, markAlertRead, resolveAlert } from "./api.js"

export function registerCommands(
  context: vscode.ExtensionContext,
  store: AlertStore,
  tree: AlertsTreeProvider,
  diagnostics: DiagnosticsManager,
  getApiConfig: () => Promise<ApiConfig | null>,
): void {
  // Sign In
  context.subscriptions.push(
    vscode.commands.registerCommand("inariwatch.authenticate", async () => {
      const token = await promptForToken()
      if (token) {
        vscode.window.showInformationMessage("InariWatch: Signed in successfully")
        await refreshAlerts(store, diagnostics, getApiConfig)
      }
    })
  )

  // Sign Out
  context.subscriptions.push(
    vscode.commands.registerCommand("inariwatch.signOut", async () => {
      await deleteToken()
      store.clear()
      await diagnostics.refresh()
      vscode.window.showInformationMessage("InariWatch: Signed out")
    })
  )

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand("inariwatch.refresh", async () => {
      await refreshAlerts(store, diagnostics, getApiConfig)
    })
  )

  // Mark Read (from tree item context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand("inariwatch.markRead", async (node: unknown) => {
      const alert = tree.getAlert(node as Parameters<typeof tree.getAlert>[0])
      if (!alert) return

      store.markRead(alert.id)

      if (alert.source === "cloud") {
        const config = await getApiConfig()
        if (config) {
          markAlertRead(config, alert.id).catch(() => {})
        }
      }

      await diagnostics.refresh()
    })
  )

  // Resolve
  context.subscriptions.push(
    vscode.commands.registerCommand("inariwatch.resolve", async (node: unknown) => {
      const alert = tree.getAlert(node as Parameters<typeof tree.getAlert>[0])
      if (!alert) return

      store.resolve(alert.id)

      if (alert.source === "cloud") {
        const config = await getApiConfig()
        if (config) {
          resolveAlert(config, alert.id).catch(() => {})
        }
      }

      await diagnostics.refresh()
    })
  )

  // Open in Dashboard
  context.subscriptions.push(
    vscode.commands.registerCommand("inariwatch.openInDashboard", async (node: unknown) => {
      const alert = tree.getAlert(node as Parameters<typeof tree.getAlert>[0])
      if (!alert || alert.source === "local") return

      const config = vscode.workspace.getConfiguration("inariwatch")
      const baseUrl = config.get<string>("apiUrl", "https://app.inariwatch.com")
      vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/alerts/${alert.id}`))
    })
  )
}

export async function refreshAlerts(
  store: AlertStore,
  diagnostics: DiagnosticsManager,
  getApiConfig: () => Promise<ApiConfig | null>,
): Promise<void> {
  const config = await getApiConfig()
  if (!config) return

  try {
    const alerts = await fetchAlerts(config)
    store.upsert(alerts)
    await diagnostics.refresh()
  } catch (err) {
    if (err instanceof Error && err.message.includes("401")) {
      vscode.window.showWarningMessage("InariWatch: Token expired. Run 'InariWatch: Sign In' to reconnect.")
    }
  }
}
