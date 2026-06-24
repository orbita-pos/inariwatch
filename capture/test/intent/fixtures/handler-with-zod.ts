// Fixture: handler validating with a Zod schema.
// Used by capture/test/intent/zod.test.mjs.
//
// The `z` symbol is intentionally not imported — we never RUN this file,
// only parse its AST. Adding the import would force the test runner to
// install zod just to keep tsc happy on the fixture, which defeats the
// "AST-only, no runtime peer" design.
//
// @ts-nocheck
const z = /** @type {any} */ (globalThis.z)

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  age: z.number().int(),
  isActive: z.boolean(),
  tags: z.array(z.string()),
  role: z.enum(["admin", "member"]),
  nickname: z.string().optional(),
})

export function handler(req) {
  const body = userSchema.parse(req.body)
  if (!body.id) throw new Error("missing id")
  return body
}
