import * as vscode from "vscode"
import type { AlertStore } from "./store.js"

export class StatusBar {
  private item: vscode.StatusBarItem

  constructor(private store: AlertStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.command = "inariwatch.alerts.focus"
    this.update()
    store.on("change", () => this.update())
  }

  private update(): void {
    const count = this.store.getUnreadCount()
    if (count === 0) {
      this.item.text = "$(check) InariWatch"
      this.item.tooltip = "No unread alerts"
      this.item.backgroundColor = undefined
    } else {
      this.item.text = `$(bell) InariWatch: ${count}`
      this.item.tooltip = `${count} unread alert${count > 1 ? "s" : ""}`
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
    }
    this.item.show()
  }

  dispose(): void {
    this.item.dispose()
  }
}
