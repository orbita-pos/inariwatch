/**
 * In-memory subscription store for MCP resource subscriptions.
 * Ephemeral per serverless instance — the SSE connection and subscription
 * live in the same process, so this works for Vercel.
 */

const store = new Map<string, Set<string>>();

export function subscribe(tokenId: string, uri: string): void {
  if (!store.has(tokenId)) store.set(tokenId, new Set());
  store.get(tokenId)!.add(uri);
}

export function unsubscribe(tokenId: string, uri: string): void {
  store.get(tokenId)?.delete(uri);
}

export function getSubscriptions(tokenId: string): Set<string> {
  return store.get(tokenId) ?? new Set();
}
