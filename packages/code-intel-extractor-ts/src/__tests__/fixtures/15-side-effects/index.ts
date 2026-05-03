// Heuristic side-effect detection.

declare const db: {
  insert: (t: string, row: object) => Promise<void>;
  select: <T>(q: string) => Promise<T[]>;
};

export async function createUser(name: string): Promise<void> {
  await db.insert("users", { name });
  await fetch("https://example.com/audit", { method: "POST" });
}

export async function listUsers(): Promise<unknown[]> {
  return db.select("users");
}

export function pure(x: number): number {
  return x * 2;
}
