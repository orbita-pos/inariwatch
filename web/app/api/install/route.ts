/**
 * GET /api/install
 *
 * Serves the InariWatch eBPF agent installer script from the public
 * distribution repo. Accessible via install.inariwatch.com (middleware
 * rewrites the host to this route).
 *
 * Usage from a user's server:
 *   curl -sf https://install.inariwatch.com | sh -s -- \
 *     --integration-id <uuid> \
 *     --secret <secret>
 *
 * The script content is fetched from GitHub and cached at the edge for
 * 5 minutes. Users always get the latest version from main branch.
 */

const SCRIPT_URL =
  "https://raw.githubusercontent.com/orbita-pos/inariwatch-agent-releases/main/install.sh";

// Revalidate the edge cache every 5 minutes — enough for rapid iteration
// during releases, while still protecting against GitHub rate limits.
export const revalidate = 300;

export async function GET() {
  try {
    const response = await fetch(SCRIPT_URL, {
      next: { revalidate },
      headers: {
        // Identify ourselves to GitHub for rate-limit tracking.
        "User-Agent": "inariwatch-installer-proxy/1.0",
      },
    });

    if (!response.ok) {
      return new Response(
        `# InariWatch installer unavailable (HTTP ${response.status})\n` +
          `# Try again in a few seconds, or download manually:\n` +
          `# ${SCRIPT_URL}\n` +
          `exit 1\n`,
        {
          status: 502,
          headers: {
            "Content-Type": "text/x-shellscript; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        }
      );
    }

    const script = await response.text();

    return new Response(script, {
      status: 200,
      headers: {
        "Content-Type": "text/x-shellscript; charset=utf-8",
        // Edge caches for 5 min, browsers for 1 min. GitHub raw has its own
        // 5-min cache so actual propagation delay is bounded to ~10 min worst case.
        "Cache-Control": "public, max-age=60, s-maxage=300",
        // Security: let the client know this is a shell script, not HTML.
        "X-Content-Type-Options": "nosniff",
        // Version marker for debugging.
        "X-InariWatch-Proxy": "install-v1",
      },
    });
  } catch (err) {
    return new Response(
      `# InariWatch installer proxy error: ${err instanceof Error ? err.message : "unknown"}\n` +
        `# Download manually from:\n` +
        `# ${SCRIPT_URL}\n` +
        `exit 1\n`,
      {
        status: 502,
        headers: {
          "Content-Type": "text/x-shellscript; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      }
    );
  }
}
