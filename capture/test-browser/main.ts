// ─── Event log intercept — must run before SDK import ─────────────────────────

interface CapturedEvent {
  ts: number
  level: "log" | "warn" | "error"
  text: string
  isAwake: boolean
}

const events: CapturedEvent[] = []
const listeners: Array<() => void> = []

function notify() { listeners.forEach(fn => fn()) }

function intercept(level: "log" | "warn" | "error", original: (...a: unknown[]) => void) {
  return (...args: unknown[]) => {
    original(...args)
    const text = args.map(a => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ")
    // ANSI strip
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "")
    if (!clean.trim()) return
    const isAwake = clean.includes("[@inariwatch") || isKnownKind(clean)
    events.push({ ts: Date.now(), level, text: clean, isAwake })
    notify()
  }
}

function isKnownKind(t: string): boolean {
  return [
    "vitals.", "loaf:", "long_task:", "broken_", "slow_", "third_party",
    "spa_route", "rage_click", "dead_click", "dom_size", "storage_quota",
    "hydration_mismatch", "image_optimization", "memory_leak",
  ].some(k => t.includes(k))
}

console.log = intercept("log", console.log.bind(console))
console.warn = intercept("warn", console.warn.bind(console))
console.error = intercept("error", console.error.bind(console))

// ─── SDK init ─────────────────────────────────────────────────────────────────

// Configure before the side-effect import runs
;(window as Record<string, unknown>)["__INARIWATCH__"] = { debug: true }

// Side-effect: init() + installAwake() run immediately
await import("@inariwatch/capture/browser")

// ─── UI ───────────────────────────────────────────────────────────────────────

const root = document.getElementById("root")!
root.innerHTML = `
<div id="app">
  <header>
    <h1>🦊 Capture Awake — Manual Test</h1>
    <p>Each button triggers a detector scenario. Events appear in the log panel below.</p>
    <span id="badge">0 events</span>
  </header>
  <div id="layout">
    <div id="triggers">
      <section>
        <h2>Auto-firing (no action needed)</h2>
        <div class="btn-row">
          <button class="auto" onclick="noop()">⚡ Web Vitals<br><small>LCP / FCP / TTFB fire on load</small></button>
          <button class="auto" onclick="noop()">📏 DOM Size<br><small>Checked after load</small></button>
        </div>
      </section>
      <section>
        <h2>Click to trigger</h2>
        <div class="btn-row">
          <button id="btn-loaf">🐌 LoAF<br><small>Block main thread 300ms</small></button>
          <button id="btn-broken-img">🖼️ Broken Image<br><small>Load 404 image</small></button>
          <button id="btn-broken-script">📜 Broken Script<br><small>Load 404 script</small></button>
          <button id="btn-spa">🗺️ SPA Route<br><small>pushState + slow render</small></button>
          <button id="btn-slow-img">🐢 Slow Image<br><small>Load large unsized image</small></button>
          <button id="btn-dom">🌳 DOM Size<br><small>Add 1600 nodes</small></button>
          <button id="btn-hydration">💥 Hydration<br><small>console.error mismatch</small></button>
          <button id="btn-storage">💾 Storage Quota<br><small>Read estimate</small></button>
          <button id="btn-img-opt">🔍 Image Optimizer<br><small>Add unoptimized imgs</small></button>
          <button id="btn-memory">🧠 Memory Leak<br><small>10x navigate to simulate</small></button>
        </div>
      </section>
      <section>
        <h2>Interaction (do yourself)</h2>
        <div class="btn-row">
          <button id="btn-rage" style="background:#7c3aed">
            😤 Rage Click Target<br><small>Click this 3× fast</small>
          </button>
          <button id="btn-dead" style="background:#374151">
            💀 Dead Click Target<br><small>Click — nothing will happen</small>
          </button>
        </div>
      </section>
    </div>
    <div id="log-panel">
      <div id="log-header">
        <span>Event Log</span>
        <label><input type="checkbox" id="all-toggle"> Show all console output</label>
        <button id="clear-btn">Clear</button>
      </div>
      <div id="log-entries"></div>
    </div>
  </div>
  <div id="sandbox"></div>
</div>
`

// ─── Trigger implementations ───────────────────────────────────────────────────

document.getElementById("btn-loaf")!.onclick = () => {
  // Block the main thread for ~300ms → triggers LoAF (Chrome) or longtask (others)
  const start = performance.now()
  let x = 0
  while (performance.now() - start < 310) x++
  console.log(`[test] Blocked main thread ${Math.round(performance.now() - start)}ms (x=${x})`)
}

document.getElementById("btn-broken-img")!.onclick = () => {
  const img = document.createElement("img")
  img.src = "https://capture-awake-test-404.invalid/broken-hero.jpg"
  img.alt = "broken"
  document.getElementById("sandbox")!.appendChild(img)
}

document.getElementById("btn-broken-script")!.onclick = () => {
  const s = document.createElement("script")
  s.src = "https://capture-awake-test-404.invalid/missing-analytics.js"
  document.head.appendChild(s)
}

document.getElementById("btn-spa")!.onclick = async () => {
  history.pushState(null, "", `/test-route-${Date.now()}`)
  // Simulate slow render: block for 1200ms after navigation
  const start = performance.now()
  while (performance.now() - start < 1200) { /* spin */ }
  console.log("[test] SPA route settled")
}

document.getElementById("btn-slow-img")!.onclick = () => {
  const sb = document.getElementById("sandbox")!
  // A real large image from a public CDN (no lazy, no dimensions → also image-optimizer issue)
  const img = document.createElement("img")
  // Use a large Wikimedia image (public domain)
  img.src = "https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Culinary_fruits_front_view.jpg/2000px-Culinary_fruits_front_view.jpg"
  img.style.maxWidth = "200px"
  // No width/height attrs, no loading=lazy → triggers both slow_image + image_optimization
  sb.appendChild(img)
}

document.getElementById("btn-dom")!.onclick = () => {
  const sb = document.getElementById("sandbox")!
  const frag = document.createDocumentFragment()
  for (let i = 0; i < 1600; i++) {
    const d = document.createElement("div")
    d.textContent = `node-${i}`
    d.className = "test-node"
    frag.appendChild(d)
  }
  sb.appendChild(frag)
  console.log(`[test] Added 1600 nodes. Total: ${document.querySelectorAll("*").length}`)
  // Manually trigger dom-size check
  import("../src/awake/dom-size.js").then(m => m.checkDomSize({}))
}

document.getElementById("btn-hydration")!.onclick = () => {
  console.error("Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client. This can happen if a SSR-rendered component uses window or document.")
}

document.getElementById("btn-storage")!.onclick = async () => {
  if (!navigator.storage?.estimate) {
    console.warn("[test] navigator.storage.estimate not available")
    return
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  console.log(`[test] Storage: ${Math.round(usage/1024/1024)}MB used / ${Math.round(quota/1024/1024)}MB quota (${Math.round(usage/quota*100)}%)`)
  import("../src/awake/storage-quota.js").then(m => m.checkStorageQuota())
}

document.getElementById("btn-img-opt")!.onclick = () => {
  const sb = document.getElementById("sandbox")!
  // Add images that trigger all 4 optimization issues
  const imgs = [
    // missing lazy (below fold is tricky to fake — just add w/o lazy)
    `<img src="https://picsum.photos/800/600?v=1" alt="no lazy" style="margin:4px">`,
    // missing dimensions
    `<img src="https://picsum.photos/400/300?v=2" alt="no dims" style="margin:4px">`,
    // JPEG (non-modern format)
    `<img src="https://picsum.photos/seed/awake/300/200.jpg" width="300" height="200" loading="lazy" style="margin:4px">`,
  ]
  sb.insertAdjacentHTML("beforeend", imgs.join(""))
  // Wait for images to load then scan
  setTimeout(() => {
    import("../src/awake/image-optimizer.js").then(m => m.scanImages({}))
  }, 2000)
}

document.getElementById("btn-memory")!.onclick = async () => {
  console.log("[test] Simulating 10 SPA navigations for memory leak heuristic...")
  for (let i = 0; i < 10; i++) {
    history.pushState(null, "", `/mem-test-${i}`)
    // Add some objects to simulate heap growth
    const leak: unknown[] = []
    for (let j = 0; j < 5000; j++) leak.push({ idx: j, data: "x".repeat(100) })
    ;(window as Record<string, unknown>)[`__leak_${i}`] = leak
    await new Promise(r => setTimeout(r, 600))
  }
  console.log("[test] Done — check memory_leak event above")
}

// Rage/dead click targets do nothing themselves — the awake module detects them
function noop() {}
;(window as Record<string, unknown>)["noop"] = noop

// ─── Log panel renderer ────────────────────────────────────────────────────────

const logEntries = document.getElementById("log-entries")!
const badge = document.getElementById("badge")!
const allToggle = document.getElementById("all-toggle") as HTMLInputElement
const clearBtn = document.getElementById("clear-btn")!

clearBtn.onclick = () => { events.length = 0; render() }

function render() {
  const showAll = allToggle.checked
  const filtered = showAll ? events : events.filter(e => e.isAwake)
  badge.textContent = `${events.length} events`
  badge.style.background = events.length > 0 ? "#059669" : "#6b7280"

  logEntries.innerHTML = filtered.length === 0
    ? `<div class="empty">No Capture Awake events yet. Trigger a scenario above or wait for auto-firing detectors.</div>`
    : filtered.map(e => `
      <div class="entry ${e.level} ${e.isAwake ? "awake" : ""}">
        <span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>
        <span class="lvl ${e.level}">${e.level.toUpperCase()}</span>
        <pre>${escHtml(e.text)}</pre>
      </div>
    `).join("")
  logEntries.scrollTop = logEntries.scrollHeight
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

listeners.push(render)
allToggle.onchange = render
render()
