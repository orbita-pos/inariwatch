/**
 * Repro: run the actual patch from call 4 against the file via GitHub API.
 */
import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

import * as gh from "@/lib/services/github-api";
import { parseAndApply } from "../lib/ai/apply-patch";

async function main() {
  const token = process.env.OPS_GITHUB_TOKEN!;
  const owner = "orbita-pos";
  const repo = "inariwatch-demo-store";
  const file = "lib/pricing/discount.ts";
  const content = await gh.getFileContent(token, owner, repo, file, "master");
  if (!content) throw new Error("file not found");

  console.log("FILE content (first 25 lines, with $ for line endings):");
  const lines = content.split("\n");
  for (let i = 0; i < Math.min(25, lines.length); i++) {
    console.log(`L${(i + 1).toString().padStart(2)}: ${JSON.stringify(lines[i])}`);
  }

  const readFile = async (p: string) => (p === file ? content : null);

  // Patch from session 88389322 call 3 — space-prefixed marker mode
  // (gpt-4o-mini mistake: every body line starts with a space, even
  // the "-" and "+" marker lines).
  const patch = `*** Begin Patch
*** Update File: lib/pricing/discount.ts
 @@ -15,6 +15,12 @@
 export async function applyDiscount(cart: Cart, couponCode: string): Promise<DiscountResult> {
 -  const validation = (await validateCoupon(couponCode))!
 +  const validation = await validateCoupon(couponCode);
 +  if (!validation) {
 +    throw new Error('Invalid coupon code');
 +  }
 +
   const discountAmount = cart.subtotal * validation.discount
   return {
     subtotal: cart.subtotal,
     discountApplied: discountAmount,
     total: cart.subtotal - discountAmount,
     couponCode: validation.code,
   }
*** End Patch
`;

  console.log("\n=== APPLYING PATCH ===");
  try {
    const result = await parseAndApply(patch, readFile);
    console.log(`✅ OK — ${result.changed.length} file(s) changed`);
    console.log(result.changed[0].content.split("\n").slice(14, 30).join("\n"));
  } catch (err) {
    console.log(`❌ ${(err as Error).message}`);
  }
}
main().catch(console.error);
