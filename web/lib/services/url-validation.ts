/**
 * Shared URL validation — SSRF protection.
 * Blocks private IPs, localhost, cloud metadata, IPv6 private ranges.
 */

export function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();

    // Block localhost variants
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;

    // Block IPv4 private ranges
    if (host.startsWith("10.")) return false;
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1]);
      if (second >= 16 && second <= 31) return false;
    }
    if (host.startsWith("192.168.")) return false;
    if (host.startsWith("169.254.")) return false; // link-local / cloud metadata
    if (host.startsWith("0.")) return false; // 0.x.x.x

    // Block octal/hex IP notation (0x7f, 0177, etc.)
    if (/^0[xo0-7]/.test(host)) return false;
    if (/^\d+$/.test(host)) return false; // decimal IP like 2130706433

    // Block IPv6 private/loopback/link-local
    if (host.startsWith("[")) {
      const ipv6 = host.slice(1, -1).toLowerCase();
      if (ipv6 === "::1") return false;
      if (ipv6.startsWith("::ffff:")) return false; // IPv4-mapped
      if (ipv6.startsWith("fe80:")) return false; // link-local
      if (ipv6.startsWith("fd")) return false; // unique local
      if (ipv6.startsWith("fc")) return false; // unique local
    }

    // Block internal/local TLDs + Kubernetes in-cluster DNS. The `.svc`
    // endsWith catches the short form (`kubernetes.default.svc`); `.local`
    // catches the long form (`kubernetes.default.svc.cluster.local`).
    if (
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host.endsWith(".svc") ||
      host === "metadata.google.internal"
    ) return false;

    return true;
  } catch {
    return false;
  }
}
