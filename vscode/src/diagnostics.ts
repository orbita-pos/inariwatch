import * as vscode from "vscode"
import type { AlertStore } from "./store.js"
import type { ExtensionAlert } from "./types.js"
import { mapStackToWorkspace } from "./stack-mapper.js"

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
}

export class DiagnosticsManager {
  private collection: vscode.DiagnosticCollection

  constructor(private store: AlertStore) {
    this.collection = vscode.languages.createDiagnosticCollection("inariwatch")
  }

  async refresh(): Promise<void> {
    this.collection.clear()
    const alerts = this.store.getUnresolved()

    // Map all alerts to workspace locations
    const fileMap = new Map<string, vscode.Diagnostic[]>()

    for (const alert of alerts) {
      // Compute locations if not cached
      if (!alert.locations) {
        alert.locations = await mapStackToWorkspace(alert.body)
      }

      for (const loc of alert.locations) {
        const line = Math.max(0, loc.line - 1) // VS Code lines are 0-indexed
        const col = Math.max(0, loc.column - 1)

        const range = new vscode.Range(line, col, line, col + 20)
        const diagnostic = new vscode.Diagnostic(
          range,
          alert.title,
          SEVERITY_MAP[alert.severity] ?? vscode.DiagnosticSeverity.Error,
        )
        diagnostic.source = "InariWatch"
        diagnostic.code = alert.id

        if (!fileMap.has(loc.filePath)) {
          fileMap.set(loc.filePath, [])
        }
        fileMap.get(loc.filePath)!.push(diagnostic)
      }
    }

    for (const [filePath, diagnostics] of fileMap) {
      this.collection.set(vscode.Uri.file(filePath), diagnostics)
    }
  }

  dispose(): void {
    this.collection.dispose()
  }
}
