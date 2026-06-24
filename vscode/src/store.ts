import { EventEmitter } from "events"
import type { ExtensionAlert } from "./types.js"

export class AlertStore extends EventEmitter {
  private alerts = new Map<string, ExtensionAlert>()

  getAll(): ExtensionAlert[] {
    return [...this.alerts.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }

  getUnresolved(): ExtensionAlert[] {
    return this.getAll().filter((a) => !a.isResolved)
  }

  getUnreadCount(): number {
    return this.getUnresolved().filter((a) => !a.isRead).length
  }

  get(id: string): ExtensionAlert | undefined {
    return this.alerts.get(id)
  }

  /** Add or update alerts. Deduplicates by fingerprint for local alerts. */
  upsert(alerts: ExtensionAlert[]): void {
    let changed = false
    for (const alert of alerts) {
      const existing = this.alerts.get(alert.id)
      if (!existing || JSON.stringify(existing) !== JSON.stringify(alert)) {
        this.alerts.set(alert.id, alert)
        changed = true
      }
    }
    if (changed) this.emit("change")
  }

  /** Add a single alert (from local mode or SSE) */
  add(alert: ExtensionAlert): void {
    // Deduplicate by fingerprint
    if (alert.fingerprint) {
      for (const [id, existing] of this.alerts) {
        if (existing.fingerprint === alert.fingerprint && existing.source === alert.source) {
          this.alerts.delete(id)
          break
        }
      }
    }
    this.alerts.set(alert.id, alert)
    this.emit("change")
  }

  markRead(id: string): void {
    const alert = this.alerts.get(id)
    if (alert) {
      alert.isRead = true
      this.emit("change")
    }
  }

  resolve(id: string): void {
    const alert = this.alerts.get(id)
    if (alert) {
      alert.isRead = true
      alert.isResolved = true
      this.emit("change")
    }
  }

  clear(): void {
    this.alerts.clear()
    this.emit("change")
  }
}
