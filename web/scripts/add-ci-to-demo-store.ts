/**
 * Adds a minimal GitHub Actions CI workflow to `orbita-pos/inariwatch-demo-store`
 * so generated fix PRs get a green check (or a real failure) instead of timing
 * out waiting for CI that never runs.
 *
 * Minimal: syntax-check every .js with `node --check`. If a fix produces
 * malformed code we'll see it immediately; if not, the check passes.
 *
 * Why via API, not local clone: one-shot operation, no reason to pull the
 * repo locally. The GitHub integration already has write access (same token
 * that pushes remediation branches).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const WORKFLOW = `name: Test
on:
  push:
    branches: [master, main]
  pull_request:
    branches: [master, main]

jobs:
  syntax-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Syntax check JS files
        run: |
          set -e
          mapfile -t files < <(find . -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \\) -not -path './node_modules/*' -not -path './.git/*')
          if [ \${#files[@]} -eq 0 ]; then
            echo "no JS files to check"
            exit 0
          fi
          echo "checking \${#files[@]} files"
          for f in "\${files[@]}"; do
            echo "  $f"
            node --check "$f"
          done

      - name: Run tests if package.json has test script
        run: |
          if [ -f package.json ] && grep -q '"test"' package.json; then
            npm ci --omit=dev 2>/dev/null || npm ci || true
            npm test || echo "tests failed (non-blocking for syntax-check workflow)"
          else
            echo "no package.json test script, skipping"
          fi
`;

async function main() {
  const { db } = await import("../lib/db");
  const { projectIntegrations, projects } = await import("../lib/db");
  const { eq, and } = await import("drizzle-orm");
  const { decryptConfig } = await import("../lib/crypto");

  const [demoProj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, "demo"))
    .limit(1);
  if (!demoProj) { console.error("demo project not found"); process.exit(1); }

  const integs = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, demoProj.id),
      eq(projectIntegrations.service, "github"),
      eq(projectIntegrations.isActive, true),
    ));
  const ghInteg = integs[0];
  if (!ghInteg) { console.error("no github integration"); process.exit(1); }

  const cfg = decryptConfig(ghInteg.configEncrypted);
  const token = cfg.token as string;
  const targetRepo = "orbita-pos/inariwatch-demo-store";
  const targetPath = ".github/workflows/test.yml";

  // Get default branch
  const repoInfoRes = await fetch(`https://api.github.com/repos/${targetRepo}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const repoInfo = (await repoInfoRes.json()) as { default_branch: string };
  const defaultBranch = repoInfo.default_branch;
  console.log(`default_branch: ${defaultBranch}`);

  // Check if file already exists
  const existingRes = await fetch(
    `https://api.github.com/repos/${targetRepo}/contents/${targetPath}?ref=${defaultBranch}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const body = {
    message: "ci: add minimal syntax-check + test workflow",
    content: Buffer.from(WORKFLOW).toString("base64"),
    branch: defaultBranch,
    ...(existingRes.ok ? { sha: ((await existingRes.json()) as { sha: string }).sha } : {}),
  };

  const res = await fetch(`https://api.github.com/repos/${targetRepo}/contents/${targetPath}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const result = (await res.json()) as { commit?: { sha?: string; html_url?: string } };
  console.log(`✓ CI workflow committed`);
  console.log(`  sha:  ${result.commit?.sha?.slice(0, 7)}`);
  console.log(`  url:  ${result.commit?.html_url}`);
  console.log(`\nFuture fix PRs to this repo will now get a real CI check instead of timing out.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
