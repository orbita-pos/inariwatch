// Fixture: handler with a TypeScript-typed parameter.
// Used by capture/test/intent/typescript.test.mjs.

interface User {
  id: string
  email: string
  age: number
  tags: string[]
  role?: "admin" | "member"
}

export function handler(user: User) {
  if (!user.id) throw new Error("missing id")
  return user
}
