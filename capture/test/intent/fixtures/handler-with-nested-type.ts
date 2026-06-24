// Fixture: nested + transitive type resolution within a single file.

interface Address {
  street: string
  city: string
  zip: string
}

type OrderStatus = "pending" | "shipped" | "delivered"

interface Order {
  id: string
  status: OrderStatus
  shipTo: Address
  lineItems: Array<{ sku: string; qty: number }>
}

export function processOrder(order: Order) {
  if (!order.id) throw new Error("missing id")
  return order
}
