// Fixture: Drizzle table definition.
// Used by capture/test/intent/drizzle.test.mjs.
//
// We never run this file — only parse the AST. The drizzle-orm import
// is real (it's an optional peer at the SDK level), and even without
// the runtime installed the file is parseable.
//
// @ts-nocheck

import { pgTable, text, integer, boolean, timestamp, uuid, varchar } from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: uuid("id").primaryKey().notNull(),
  email: text("email").notNull(),
  nickname: varchar("nickname", { length: 64 }),
  age: integer("age"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  status: text("status").notNull(),
  total: integer("total").notNull(),
  tags: text("tags").array(),
})

export async function createUser(input) {
  // Used by the symbol-based-resolution test: the resolver should
  // notice this function calls db.insert(users).
  return await db.insert(users).values(input)
}
