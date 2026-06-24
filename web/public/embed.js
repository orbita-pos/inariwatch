(function () {
  "use strict";

  var API_BASE = "https://app.inariwatch.com";

  var STATUS_COLORS = {
    operational:  { bg: "#f0fdf4", border: "#bbf7d0", dot: "#22c55e", text: "#166534" },
    degraded:     { bg: "#fffbeb", border: "#fde68a", dot: "#f59e0b", text: "#92400e" },
    major_outage: { bg: "#fff1f2", border: "#fecdd3", dot: "#ef4444", text: "#991b1b" },
  };

  var DEFAULT_COLOR = { bg: "#f4f4f5", border: "#e4e4e7", dot: "#a1a1aa", text: "#3f3f46" };

  function render(el, data) {
    var c = STATUS_COLORS[data.status] || DEFAULT_COLOR;
    var uptime = data.uptimePct !== null && data.uptimePct !== undefined
      ? '<span style="margin-left:10px;font-size:11px;color:' + c.text + ';opacity:0.7;">' + data.uptimePct + "% uptime</span>"
      : "";
    var link = data.pageUrl
      ? 'href="' + data.pageUrl + '" target="_blank" rel="noopener noreferrer"'
      : "";

    el.innerHTML =
      '<a ' + link + ' style="display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 10px;' +
      'border-radius:999px;border:1px solid ' + c.border + ';background:' + c.bg + ';' +
      'text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;' +
      'font-size:13px;font-weight:500;color:' + c.text + ';cursor:pointer;line-height:1;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + c.dot + ';flex-shrink:0;' +
        (data.status !== "operational" ? "animation:iw-pulse 1.5s ease-in-out infinite;" : "") + '"></span>' +
        '<span>' + escHtml(data.label) + '</span>' +
        uptime +
      "</a>" +
      '<style>@keyframes iw-pulse{0%,100%{opacity:1}50%{opacity:0.45}}</style>';
  }

  function renderError(el) {
    var c = DEFAULT_COLOR;
    el.innerHTML =
      '<span style="display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 10px;' +
      'border-radius:999px;border:1px solid ' + c.border + ';background:' + c.bg + ';' +
      'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:13px;color:' + c.text + ';">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + c.dot + ';flex-shrink:0;"></span>' +
        "Status unavailable" +
      "</span>";
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fetchAndRender(el, slug) {
    fetch(API_BASE + "/api/status/" + encodeURIComponent(slug) + "/widget")
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) { render(el, data); })
      .catch(function () { renderError(el); });
  }

  function init() {
    // Auto-discover: <div data-inariwatch-slug="my-project"></div>
    var autoEls = document.querySelectorAll("[data-inariwatch-slug]");
    for (var i = 0; i < autoEls.length; i++) {
      (function (el) {
        var slug = el.getAttribute("data-inariwatch-slug");
        if (!slug) return;
        fetchAndRender(el, slug);
        setInterval(function () { fetchAndRender(el, slug); }, 60000);
      })(autoEls[i]);
    }

    // Manual config: window.__INARIWATCH__ = { slug, container, apiBase? }
    var cfg = window.__INARIWATCH__;
    if (cfg && cfg.slug) {
      if (cfg.apiBase) API_BASE = cfg.apiBase;
      var target = cfg.container
        ? (typeof cfg.container === "string" ? document.querySelector(cfg.container) : cfg.container)
        : null;
      if (target) {
        fetchAndRender(target, cfg.slug);
        setInterval(function () { fetchAndRender(target, cfg.slug); }, 60000);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
