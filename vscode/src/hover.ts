import * as vscode from "vscode"
import type { AlertStore } from "./store.js"

export class InariWatchHoverProvider implements vscode.HoverProvider {
  constructor(private store: AlertStore) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const filePath = document.uri.fsPath
    const line = position.line + 1 // stack traces are 1-indexed

    // Find alerts that map to this file and line
    const alerts = this.store.getUnresolved()
    for (const alert of alerts) {
      if (!alert.locations) continue
      for (const loc of alert.locations) {
        if (loc.filePath === filePath && loc.line === line) {
          return new vscode.Hover(this.buildHoverContent(alert))
        }
      }
    }

    return null
  }

  private buildHoverContent(alert: { title: string; severity: string; aiReasoning: string | null; body: string }): vscode.MarkdownString {
    const md = new vscode.MarkdownString()
    md.isTrusted = true

    const icon = alert.severity === "critical" ? "$(error)" : alert.severity === "warning" ? "$(warning)" : "$(info)"
    md.appendMarkdown(`### ${icon} InariWatch: ${alert.title}\n\n`)

    if (alert.aiReasoning) {
      md.appendMarkdown(`**AI Diagnosis:**\n\n${alert.aiReasoning}\n\n`)
    } else {
      // Show first few lines of stack trace
      const lines = alert.body.split("\n").slice(0, 5)
      md.appendCodeblock(lines.join("\n"), "text")
    }

    return md
  }
}
