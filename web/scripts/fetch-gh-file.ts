/**
 * Fetch ping-broken/route.ts via GitHub API — the same way the agent
 * does. Print raw bytes so we can compare against what our parser
 * receives.
 */
import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "..", ".env.local") });

async function main() {
  const token = process.env.OPS_GITHUB_TOKEN;
  if (!token) throw new Error("no OPS_GITHUB_TOKEN");

  const url =
    "https://api.github.com/repos/orbita-pos/inariwatch-demo-store/contents/app/api/ping-broken/route.ts?ref=master";
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
  });
  const json = (await resp.json()) as { content: string; encoding: string; size: number };
  console.log(`HTTP ${resp.status}, encoding=${json.encoding}, size=${json.size}`);

  const decoded = Buffer.from(json.content, "base64").toString("utf8");
  console.log(`Decoded length: ${decoded.length}`);
  console.log(`\n----- First 500 bytes as hex -----`);
  console.log(Buffer.from(decoded.slice(0, 300), "utf8").toString("hex").match(/.{1,32}/g)?.join("\n"));
  console.log(`\n----- Lines (with repr to show trailing ws / CR) -----`);
  const lines = decoded.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const repr = JSON.stringify(raw);
    console.log(`L${String(i + 1).padStart(2, " ")} (${raw.length} chars): ${repr}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
