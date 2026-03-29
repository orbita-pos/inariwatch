import * as vscode from "vscode"
import { AlertStore } from "./store.js"
import { DiagnosticsManager } from "./diagnostics.js"
import { AlertsTreeProvider } from "./tree-provider.js"
import { InariWatchHoverProvider } from "./hover.js"
import { StatusBar } from "./status-bar.js"
import { LocalServer } from "./local.js"
import { initAuth, getToken } from "./auth.js"
import { registerCommands, refreshAlerts } from "./commands.js"
import { createSSEStream } from "./api.js"
import { registerPredictionProvider } from "./prediction.js"
import type { ApiConfig } from "./types.js"

let pollInterval: ReturnType<typeof setInterval> | undefined
let sseController: AbortController | undefined

export function activate(context: vscode.ExtensionContext) {
  // Init auth
  initAuth(context)

  // Core state
  const store = new AlertStore()

  // UI components
  const diagnostics = new DiagnosticsManager(store)
  const treeProvider = new AlertsTreeProvider(store)
  const statusBar = new StatusBar(store)
  const localServer = new LocalServer(store)

  // Register tree view
  const treeView = vscode.window.createTreeView("inariwatch.alerts", {
    treeDataProvider: treeProvider,
  })

  // Register hover provider for all languages
  const hoverProvider = vscode.languages.registerHoverProvider(
    { scheme: "file" },
    new InariWatchHoverProvider(store),
  )

  // Helper to get API config
  async function getApiConfig(): Promise<ApiConfig | null> {
    const token = await getToken()
    if (!token) return null
    const config = vscode.workspace.getConfiguration("inariwatch")
    return {
      baseUrl: config.get<string>("apiUrl", "https://app.inariwatch.com"),
      token,
    }
  }

  // Register commands
  registerCommands(context, store, treeProvider, diagnostics, getApiConfig)

  // Register prediction provider (warns on file save)
  registerPredictionProvider(context, getApiConfig)

  // Read settings
  const config = vscode.workspace.getConfiguration("inariwatch")
  const mode = config.get<string>("mode", "cloud")
  const interval = config.get<number>("pollInterval", 30) * 1000
  const localPort = config.get<number>("localPort", 9222)

  // Start local server if mode is local or both
  if (mode === "local" || mode === "both") {
    localServer.start(localPort)
    // Refresh diagnostics when local alerts arrive
    store.on("change", () => diagnostics.refresh())
  }

  // Start cloud polling if mode is cloud or both
  if (mode === "cloud" || mode === "both") {
    // Initial fetch
    refreshAlerts(store, diagnostics, getApiConfig)

    // Try SSE first, fallback to polling
    startCloudConnection(store, diagnostics, getApiConfig, interval)
  }

  // Watch for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("inariwatch")) {
        vscode.window.showInformationMessage("InariWatch: Settings changed. Reload window to apply.")
      }
    })
  )

  // Cleanup
  context.subscriptions.push(
    treeView,
    hoverProvider,
    { dispose: () => diagnostics.dispose() },
    { dispose: () => statusBar.dispose() },
    { dispose: () => localServer.stop() },
    {
      dispose: () => {
        if (pollInterval) clearInterval(pollInterval)
        if (sseController) sseController.abort()
      },
    },
  )
}

async function startCloudConnection(
  store: AlertStore,
  diagnostics: DiagnosticsManager,
  getApiConfig: () => Promise<ApiConfig | null>,
  intervalMs: number,
): Promise<void> {
  const config = await getApiConfig()
  if (!config) {
    // No token — fall back to polling (will be no-op until user signs in)
    startPolling(store, diagnostics, getApiConfig, intervalMs)
    return
  }

  // Try SSE
  try {
    sseController = createSSEStream(
      config,
      (alert) => {
        store.add(alert)
        diagnostics.refresh()
      },
      () => {
        // SSE failed — fall back to polling
        startPolling(store, diagnostics, getApiConfig, intervalMs)
      },
    )
  } catch {
    startPolling(store, diagnostics, getApiConfig, intervalMs)
  }
}

function startPolling(
  store: AlertStore,
  diagnostics: DiagnosticsManager,
  getApiConfig: () => Promise<ApiConfig | null>,
  intervalMs: number,
): void {
  if (pollInterval) return // already polling
  pollInterval = setInterval(() => {
    refreshAlerts(store, diagnostics, getApiConfig)
  }, intervalMs)
}

export function deactivate() {
  // Cleanup handled by disposables
}
