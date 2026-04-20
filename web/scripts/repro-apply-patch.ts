/**
 * Local repro for the apply_patch failures seen in the E2E test.
 * Feeds plausible patches (mimicking what gpt-4o-mini/gpt-5.4 would emit
 * against ping-broken/route.ts) through parseAndApply and prints what
 * fails + what succeeds.
 */
import { parseAndApply } from "../lib/ai/apply-patch";

const FILE_CONTENT = `import { NextResponse } from "next/server"

/**
 * Test fixture for InariWatch remediation e2e tests.
 *
 * BUG: when ?name=X is not provided in the query string, \`name\` is
 * undefined, and calling \`.toUpperCase()\` on it throws TypeError.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const name = url.searchParams.get("name")
  return NextResponse.json({
    greeting: \`Hello, \${name.toUpperCase()}!\`,
  })
}
`;

const readFile = async (p: string) =>
  p === "app/api/ping-broken/route.ts" ? FILE_CONTENT : null;

const patches = [
  {
    label: "Variant A: unified-diff exact file indentation",
    patch: `*** Begin Patch
*** Update File: app/api/ping-broken/route.ts
@@ -6,6 +6,8 @@
 export async function GET(req: Request) {
   const url = new URL(req.url)
   const name = url.searchParams.get("name")
+  if (!name) {
+    return NextResponse.json({ error: "name required" }, { status: 400 })
+  }
   return NextResponse.json({
     greeting: \`Hello, \${name.toUpperCase()}!\`,
   })
*** End Patch
`,
  },
  {
    label: "Variant B: leading space in @@ header",
    patch: `*** Begin Patch
*** Update File: app/api/ping-broken/route.ts
 @@ -6,6 +6,8 @@
 export async function GET(req: Request) {
   const url = new URL(req.url)
   const name = url.searchParams.get("name")
+  if (!name) {
+    return NextResponse.json({ error: "name required" }, { status: 400 })
+  }
   return NextResponse.json({
*** End Patch
`,
  },
  {
    label: "Variant C: over-indented context (model inflated 4sp instead of 2sp)",
    patch: `*** Begin Patch
*** Update File: app/api/ping-broken/route.ts
@@ -6,6 +6,8 @@
 export async function GET(req: Request) {
    const url = new URL(req.url)
    const name = url.searchParams.get("name")
+   if (!name) {
+     return NextResponse.json({ error: "name required" }, { status: 400 })
+   }
    return NextResponse.json({
     greeting: \`Hello, \${name.toUpperCase()}!\`,
*** End Patch
`,
  },
  {
    label: "Variant D: remove + replace the toUpperCase line",
    patch: `*** Begin Patch
*** Update File: app/api/ping-broken/route.ts
@@ -11,3 +11,3 @@
   const name = url.searchParams.get("name")
   return NextResponse.json({
-    greeting: \`Hello, \${name.toUpperCase()}!\`,
+    greeting: \`Hello, \${(name ?? "world").toUpperCase()}!\`,
   })
 }
*** End Patch
`,
  },
];

async function main() {
  for (const { label, patch } of patches) {
    console.log(`\n===== ${label} =====`);
    try {
      const result = await parseAndApply(patch, readFile);
      console.log(`✅ OK (${result.changed.length} file(s) patched)`);
      for (const f of result.changed) {
        console.log(`--- ${f.path} (${f.op}) ---`);
        console.log(f.content);
      }
    } catch (err) {
      console.log(`❌ ${(err as Error).message}`);
    }
  }
}
main();
