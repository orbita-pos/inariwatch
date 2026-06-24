/**
 * Normalise an unknown thrown value to a human-readable string.
 *
 * Tauri's `invoke` rejects with whatever shape the Rust side returns —
 * strings come through as strings, but `Result<T, IpcError>` (a struct)
 * lands as a plain object on the JS side. `String(obj)` on that gives
 * the dreaded "[object Object]" which has shipped to users more than
 * once. This helper handles the four shapes we actually see in
 * practice:
 *
 *   - string  → returned as-is
 *   - Error   → `.message`
 *   - object with `.message` (string) → that
 *   - everything else → `JSON.stringify` (or "[unknown error]" if circular)
 */
export function errorToString(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.kind === "string") {
      const detail = typeof obj.message === "string" ? `: ${obj.message}` : "";
      return `${obj.kind}${detail}`;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return "[unknown error]";
    }
  }
  return String(e);
}
