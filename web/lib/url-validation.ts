/**
 * Validates a URL to prevent SSRF attacks.
 * Only allows http/https and blocks private/local network addresses.
 */
export function validatePublicUrl(urlString: string): {
  valid: boolean;
  error?: string;
} {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { valid: false, error: "Only HTTP and HTTPS URLs are allowed." };
  }

  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) {
    return { valid: false, error: "Local addresses are not allowed." };
  }

  // Block internal/local TLDs (DNS rebinding protection)
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    return { valid: false, error: "Internal hostnames are not allowed." };
  }

  // Block private IP ranges
  const ipMatch = hostname.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );
  if (ipMatch) {
    const [a, b] = [Number(ipMatch[1]), Number(ipMatch[2])];
    if (
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
      a === 0 // 0.0.0.0/8
    ) {
      return {
        valid: false,
        error: "Private network addresses are not allowed.",
      };
    }
  }

  return { valid: true };
}
