import { authenticateMcp } from "../auth";
import { getSubscriptions } from "../subscriptions";
import { readResource } from "../resources";
import { createHash } from "crypto";

function computeHash(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * GET /api/mcp/events — SSE endpoint for resource subscription notifications.
 * Polls subscribed resources every 10s and emits notifications/resources/updated
 * when a resource changes.
 */
export async function GET(request: Request) {
  const user = await authenticateMcp(request);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  const hashMap = new Map<string, string>();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connected event
      controller.enqueue(
        encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/connected", params: {} })}\n\n`)
      );

      const interval = setInterval(async () => {
        try {
          const subs = getSubscriptions(user.tokenId);
          for (const uri of subs) {
            const result = await readResource(uri, user);
            const hash = computeHash(JSON.stringify(result));
            const prev = hashMap.get(uri);

            if (prev && prev !== hash) {
              const msg = JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/resources/updated",
                params: { uri },
              });
              controller.enqueue(encoder.encode(`event: message\ndata: ${msg}\n\n`));
            }

            hashMap.set(uri, hash);
          }

          // Heartbeat
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Don't crash the stream on transient DB errors
        }
      }, 10_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
