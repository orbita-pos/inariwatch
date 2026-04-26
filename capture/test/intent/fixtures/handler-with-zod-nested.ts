// Fixture: nested Zod schemas + cross-reference inside the same file.
// @ts-nocheck
const z = /** @type {any} */ (globalThis.z)

const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
})

const orderSchema = z.object({
  id: z.string(),
  shipTo: addressSchema,
  status: z.union([z.literal("pending"), z.literal("shipped")]),
})

export function processOrder(req) {
  const body = orderSchema.parse(req.body)
  return body
}
