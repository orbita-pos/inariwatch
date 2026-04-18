/**
 * Opaque error responses for API route catch blocks.
 *
 * The pre-existing pattern across many routes echoed `err.message`
 * to the client, which leaks drizzle/postgres error text (table names,
 * column types, SQL fragments). `serverError` logs the original message
 * server-side and returns a generic body the caller can safely render.
 *
 * Usage:
 *   } catch (err) {
 *     return NextResponse.json(serverError(err, "rollout-post"), { status: 500 });
 *   }
 */

export function serverError(
  err: unknown,
  context?: string,
): { error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[api-error${context ? ` ${context}` : ""}]`, msg);
  return { error: "Internal server error" };
}
