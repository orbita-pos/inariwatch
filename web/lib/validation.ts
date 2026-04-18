/**
 * Shared validation primitives.
 *
 * UUID_REGEX enforces the RFC 4122 canonical 8-4-4-4-12 hex layout.
 * The older in-tree pattern `/^[0-9a-f-]{36}$/i` accepts any 36-char
 * hex+dash string (e.g. `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` or
 * `----------------------------------aa`), which would surface as a
 * 500 from drizzle's uuid cast instead of a proper 400. Use this
 * strict regex at the ingress of new routes.
 */

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_REGEX.test(s);
}
