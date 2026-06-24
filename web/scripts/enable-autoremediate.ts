/**
 * Lists projects with an active GitHub integration + their current
 * autoRemediate / default_repo state, and optionally enables
 * autoRemediate on a target project.
 *
 * Usage:
 *   cd web && npx tsx scripts/enable-autoremediate.ts                      # list only
 *   cd web && npx tsx scripts/enable-autoremediate.ts --project=<slug>     # dry-run enable
 *   cd web && npx tsx scripts/enable-autoremediate.ts --project=<slug> --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const args = process.argv.slice(2);
  const projectFlag = args.find((a) => a.startsWith("--project="))?.split("=")[1] ?? null;
  const apply = args.includes("--apply");
  const repoFlag = args.find((a) => a.startsWith("--default-repo="))?.split("=")[1] ?? null;

  const { db } = await import("../lib/db");
  const { projects, projectIntegrations, DEFAULT_AUTO_MERGE_CONFIG } = await import("../lib/db");
  const { decryptConfig } = await import("../lib/crypto");
  const gh = await import("../lib/services/github-api");
  const { eq, and } = await import("drizzle-orm");

  const allProjects = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      autoMergeConfig: projects.autoMergeConfig,
      defaultRepo: projects.defaultRepo,
    })
    .from(projects);

  const ghIntegs = await db
    .select()
    .from(projectIntegrations)
    .where(and(eq(projectIntegrations.service, "github"), eq(projectIntegrations.isActive, true)));

  const ghByProject = new Map<string, { owner: string; token: string }>();
  for (const row of ghIntegs) {
    try {
      const cfg = decryptConfig(row.configEncrypted);
      const owner = cfg.owner as string | undefined;
      const token = cfg.token as string | undefined;
      if (owner && token) ghByProject.set(row.projectId, { owner, token });
    } catch {/* skip */}
  }

  console.log(`\n=== Projects ===\n`);
  console.log(`  slug                      autoRem  defaultRepo                      githubOwner`);
  for (const p of allProjects) {
    const cfg = (p.autoMergeConfig as { autoRemediate?: boolean } | null) ?? {};
    const gh = ghByProject.get(p.id);
    console.log(
      `  ${(p.slug ?? "").padEnd(25)} ${cfg.autoRemediate ? "YES    " : "no     "} ` +
      `${(p.defaultRepo ?? "(none)").padEnd(33)} ${gh?.owner ?? "(no github)"}`
    );
  }

  if (!projectFlag) {
    console.log(`\nPass --project=<slug> to enable autoRemediate on a specific project.`);
    process.exit(0);
  }

  const target = allProjects.find((p) => p.slug === projectFlag);
  if (!target) {
    console.error(`\nProject '${projectFlag}' not found`);
    process.exit(1);
  }

  const ghInfo = ghByProject.get(target.id);
  if (!ghInfo) {
    console.error(`\nProject '${projectFlag}' has no active GitHub integration. Connect one first.`);
    process.exit(1);
  }

  console.log(`\n── Target: ${target.slug} (${target.id}) ──`);
  console.log(`   GitHub owner: ${ghInfo.owner}`);
  console.log(`   Current defaultRepo: ${target.defaultRepo ?? "(none)"}`);
  const cfgNow = (target.autoMergeConfig as Record<string, unknown> | null) ?? {};
  console.log(`   Current autoRemediate: ${cfgNow.autoRemediate ? "YES" : "no"}`);

  // List available repos
  let repos: string[] = [];
  try {
    repos = await gh.listOwnerRepos(ghInfo.token, ghInfo.owner);
  } catch (e) {
    console.error(`\nCould not list repos from GitHub:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  console.log(`\n   Available repos (${repos.length}):`);
  for (const r of repos.slice(0, 20)) console.log(`     - ${ghInfo.owner}/${r}`);

  // Pick default repo
  let chosenRepo: string | null = target.defaultRepo;
  if (!chosenRepo) {
    if (repoFlag) {
      const normalized = repoFlag.includes("/") ? repoFlag : `${ghInfo.owner}/${repoFlag}`;
      const [o, r] = normalized.split("/");
      if (o !== ghInfo.owner || !repos.includes(r)) {
        console.error(`\n--default-repo='${repoFlag}' is not in the owner's repo list`);
        process.exit(1);
      }
      chosenRepo = normalized;
    } else if (repos.length === 1) {
      chosenRepo = `${ghInfo.owner}/${repos[0]}`;
      console.log(`\n   Only one repo available — will set defaultRepo = ${chosenRepo}`);
    } else {
      // Heuristic: prefer a repo whose name matches the project slug
      const slugMatch = repos.find((r) => r === target.slug);
      if (slugMatch) {
        chosenRepo = `${ghInfo.owner}/${slugMatch}`;
        console.log(`\n   Slug match: will set defaultRepo = ${chosenRepo}`);
      } else {
        console.error(`\n   Multiple repos available and none matches the slug. Pass --default-repo=<name>.`);
        process.exit(1);
      }
    }
  }

  const newConfig = { ...DEFAULT_AUTO_MERGE_CONFIG, ...cfgNow, autoRemediate: true };

  console.log(`\n${apply ? "APPLYING" : "DRY RUN — would apply"}:`);
  console.log(`   SET projects.default_repo = '${chosenRepo}'`);
  console.log(`   SET projects.auto_merge_config.autoRemediate = true`);

  if (!apply) {
    console.log(`\nRe-run with --apply to persist.`);
    process.exit(0);
  }

  await db
    .update(projects)
    .set({
      defaultRepo: chosenRepo,
      autoMergeConfig: newConfig,
    })
    .where(eq(projects.id, target.id));

  console.log(`\n✓ autoRemediate enabled on ${target.slug} with defaultRepo=${chosenRepo}`);
  console.log(`  Critical alerts from capture/sentry/vercel/github/datadog will now auto-trigger remediation.`);
  console.log(`  You can revert with:`);
  console.log(`    UPDATE projects SET auto_merge_config = auto_merge_config || '{"autoRemediate":false}' WHERE id='${target.id}';`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
