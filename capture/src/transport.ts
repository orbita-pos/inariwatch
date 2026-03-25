import type { CaptureConfig, ErrorEvent, ParsedDSN } from "./types.js"

const MAX_RETRY_BUFFER = 30

export function parseDSN(dsn: string): ParsedDSN {
  // Local mode: "http://localhost:9111/ingest"
  if (dsn.startsWith("http://localhost") || dsn.startsWith("http://127.0.0.1")) {
    return { endpoint: dsn, secretKey: "", isLocal: true }
  }

  // Cloud mode: "https://secret@app.inariwatch.com/capture/integration-id"
  const url = new URL(dsn)
  const secretKey = url.username || url.password || ""
  url.username = ""
  url.password = ""

  // Convert path /capture/xxx → /api/webhooks/capture/xxx
  const path = url.pathname
  if (path.startsWith("/capture/")) {
    url.pathname = `/api/webhooks${path}`
  }

  return { endpoint: url.toString(), secretKey, isLocal: false }
}

async function signPayload(body: string, secret: string): Promise<string> {
  try {
    const nodeCrypto = await import("crypto")
    if (nodeCrypto.createHmac) {
      return `sha256=${nodeCrypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`
    }
  } catch {
    // Fallback: Web Crypto API
  }

  const encoder = new TextEncoder()
  const keyData = encoder.encode(secret)
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `sha256=${hex}`
}

export interface Transport {
  send(event: ErrorEvent): void
}

export function createTransport(config: CaptureConfig, parsed: ParsedDSN): Transport {
  const retryBuffer: ErrorEvent[] = []

  function log(msg: string) {
    if (config.silent) return
    if (config.debug) console.warn(`[@inariwatch/capture] ${msg}`)
  }

  async function sendOne(event: ErrorEvent): Promise<boolean> {
    const body = JSON.stringify(event)
    const headers: Record<string, string> = { "Content-Type": "application/json" }

    if (!parsed.isLocal && parsed.secretKey) {
      headers["x-capture-signature"] = await signPayload(body, parsed.secretKey)
    }

    try {
      const res = await fetch(parsed.endpoint, { method: "POST", headers, body })
      if (res.ok) return true
      log(`HTTP ${res.status} from ${parsed.endpoint}`)
      return false
    } catch (err) {
      log(`Transport error: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  async function flushRetries() {
    if (retryBuffer.length === 0) return
    const batch = retryBuffer.splice(0, retryBuffer.length)
    for (const event of batch) {
      const ok = await sendOne(event)
      if (!ok) {
        // Re-buffer failed events (up to limit)
        if (retryBuffer.length < MAX_RETRY_BUFFER) {
          retryBuffer.push(event)
        }
        break // Stop retrying on first failure
      }
    }
  }

  return {
    send(event: ErrorEvent) {
      sendOne(event).then((ok) => {
        if (ok) {
          flushRetries()
        } else if (retryBuffer.length < MAX_RETRY_BUFFER) {
          // Deduplicate by fingerprint
          if (!retryBuffer.some((e) => e.fingerprint === event.fingerprint)) {
            retryBuffer.push(event)
          }
        }
      })
    },
  }
}
