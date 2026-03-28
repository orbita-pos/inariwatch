import * as vscode from "vscode"
import type { AlertStore } from "./store.js"
import type { ExtensionAlert } from "./types.js"

type TreeNode = FileGroupNode | AlertNode

interface FileGroupNode {
  type: "file"
  filePath: string
  alerts: ExtensionAlert[]
}

interface AlertNode {
  type: "alert"
  alert: ExtensionAlert
}

const SEVERITY_ICON: Record<string, vscode.ThemeIcon> = {
  critical: new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")),
  warning: new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground")),
  info: new vscode.ThemeIcon("info", new vscode.ThemeColor("editorInfo.foreground")),
}

export class AlertsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(private store: AlertStore) {
    store.on("change", () => this._onDidChange.fire(undefined))
  }

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.type === "file") {
      const item = new vscode.TreeItem(
        vscode.workspace.asRelativePath(node.filePath),
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.iconPath = new vscode.ThemeIcon("file")
      item.description = `${node.alerts.length} alert${node.alerts.length > 1 ? "s" : ""}`
      return item
    }

    // Alert node
    const alert = node.alert
    const item = new vscode.TreeItem(alert.title, vscode.TreeItemCollapsibleState.None)
    item.iconPath = SEVERITY_ICON[alert.severity] ?? SEVERITY_ICON.info
    item.description = timeAgo(alert.createdAt)
    item.tooltip = new vscode.MarkdownString(buildTooltip(alert))
    item.contextValue = "alert"

    // Click navigates to first location
    if (alert.locations && alert.locations.length > 0) {
      const loc = alert.locations[0]
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [
          vscode.Uri.file(loc.filePath),
          { selection: new vscode.Range(loc.line - 1, 0, loc.line - 1, 0) },
        ],
      }
    }

    if (alert.isRead) {
      item.description = `${item.description} (read)`
    }

    return item
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      // Root: group alerts by first file location, ungrouped for alerts without locations
      return this.getRootNodes()
    }

    if (node.type === "file") {
      return node.alerts.map((alert) => ({ type: "alert" as const, alert }))
    }

    return []
  }

  private getRootNodes(): TreeNode[] {
    const alerts = this.store.getUnresolved()

    // Group by first file location
    const fileGroups = new Map<string, ExtensionAlert[]>()
    const ungrouped: ExtensionAlert[] = []

    for (const alert of alerts) {
      if (alert.locations && alert.locations.length > 0) {
        const file = alert.locations[0].filePath
        if (!fileGroups.has(file)) fileGroups.set(file, [])
        fileGroups.get(file)!.push(alert)
      } else {
        ungrouped.push(alert)
      }
    }

    const nodes: TreeNode[] = []

    // File groups
    for (const [filePath, groupAlerts] of fileGroups) {
      nodes.push({ type: "file", filePath, alerts: groupAlerts })
    }

    // Ungrouped alerts at root level
    for (const alert of ungrouped) {
      nodes.push({ type: "alert", alert })
    }

    return nodes
  }

  /** Get the alert associated with a tree node (for commands) */
  getAlert(node: TreeNode): ExtensionAlert | undefined {
    if (node.type === "alert") return node.alert
    return undefined
  }
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function buildTooltip(alert: ExtensionAlert): string {
  let md = `**${alert.title}**\n\n`
  md += `Severity: ${alert.severity}\n\n`
  if (alert.projectName) md += `Project: ${alert.projectName}\n\n`
  if (alert.sourceIntegrations?.length) {
    md += `Source: ${alert.sourceIntegrations.join(", ")}\n\n`
  }
  if (alert.aiReasoning) {
    md += `---\n\n**AI Diagnosis:**\n\n${alert.aiReasoning}\n\n`
  }
  return md
}
