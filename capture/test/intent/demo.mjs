// Demo script — prints sample shape outputs per source. Not a test.
// Run from `capture/`: `node test/intent/demo.mjs`
import { extractIntentForFrame, __resetCacheForTesting } from "../../dist/intent/index.js"
import { join } from "node:path"

const FX = (...p) => join(process.cwd(), "test", "intent", "fixtures", ...p)

const samples = [
  { label: "OpenAPI · POST /users (operationId=createUser)", frame: { file: FX("openapi-project", "app", "api", "users", "route.ts"), line: 4, function: "createUser" } },
  { label: "OpenAPI · GET /users/{id} (path-inferred)", frame: { file: FX("openapi-project", "app", "api", "users", "[id]", "route.ts"), line: 4, function: "GET" } },
  { label: "Drizzle · users table", frame: { file: FX("drizzle-schema.ts"), line: 1, function: "users" } },
  { label: "Drizzle · createUser → users via db.insert", frame: { file: FX("drizzle-schema.ts"), line: 28, function: "createUser" } },
  { label: "Prisma · User model", frame: { file: FX("prisma-project", "app", "api", "users", "route.ts"), line: 5, function: "User" } },
  { label: "Prisma · getUser → User via verb-strip", frame: { file: FX("prisma-project", "app", "api", "users", "route.ts"), line: 9, function: "getUser" } },
]

for (const s of samples) {
  __resetCacheForTesting()
  const contracts = extractIntentForFrame(s.frame)
  const interesting = contracts.filter((c) => ["openapi", "drizzle", "prisma"].includes(c.source))
  console.log("---", s.label)
  for (const c of interesting) {
    console.log(`[${c.source}]`)
    console.log(JSON.stringify(c.shape, null, 2))
  }
}
