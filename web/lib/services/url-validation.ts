/**
 * Shared URL validation — SSRF protection.
 * Used by: run-check, create-uptime-monitor, and any future URL-fetching tools.
 */

export function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    if (host.startsWith("10.")) return false;
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1]);
      if (second >= 16 && second <= 31) return false;
    }
    if (host.startsWith("192.168.")) return false;
    if (host.startsWith("169.254.")) return false;
    if (host.endsWith(".internal") || host.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}
