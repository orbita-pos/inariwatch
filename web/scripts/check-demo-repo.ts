import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { db } = await import("../lib/db");
  const { projectIntegrations } = await import("../lib/db");
  const { eq, and } = await import("drizzle-orm");
  const { decryptConfig } = await import("../lib/crypto");

  const integs = await db
    .select()
    .from(projectIntegrations)
    .where(and(eq(projectIntegrations.service, "github"), eq(projectIntegrations.isActive, true)));
  const ghInteg = integs.find((i) => {
    const cfg = decryptConfig(i.configEncrypted);
    return cfg.owner === "orbita-pos";
  });
  if (!ghInteg) { console.error("no integration"); process.exit(1); }
  const cfg = decryptConfig(ghInteg.configEncrypted);
  const token = cfg.token as string;

  const repos = ["inariwatch-demo-store", "orbita-pos", "sentinel"];
  for (const r of repos) {
    const res = await fetch(`https://api.github.com/repos/orbita-pos/${r}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.log(`${r}: ${res.status} ${res.statusText}`);
      continue;
    }
    const data = (await res.json()) as {
      default_branch: string;
      size: number;
      created_at: string;
      private: boolean;
    };
    console.log(`${r}: default_branch=${data.default_branch} size=${data.size} private=${data.private}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
