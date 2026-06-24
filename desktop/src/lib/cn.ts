/**
 * Lightweight className composer. Intentional: no `clsx` / `classnames` dep —
 * the surface area is tiny and we don't want a transitive dep on a perma-pinned
 * library when 25 lines of TS solve it.
 *
 * Accepts strings, `undefined`, `false`, or arrays/records. Records pick up
 * keys whose value is truthy. Arrays are flattened recursively so callers can
 * write `cn("base", isActive && "active", ["a", "b"])`.
 */
export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | { [key: string]: unknown };

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (val: ClassValue) => {
    if (!val) return;
    if (typeof val === "string" || typeof val === "number") {
      out.push(String(val));
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(walk);
      return;
    }
    if (typeof val === "object") {
      for (const [k, v] of Object.entries(val)) if (v) out.push(k);
    }
  };
  inputs.forEach(walk);
  return out.join(" ");
}
