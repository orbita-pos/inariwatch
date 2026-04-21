/**
 * Bug injection for golden dataset generation.
 *
 * Commits N curated buggy files to `orbita-pos/inariwatch-demo-store`
 * under the `__inari_bugs_fixtures__/` folder (so the normal src/ is
 * untouched), then POSTs a simulated capture webhook pointing at each
 * buggy file. autoRemediate on the `demo` project picks it up and runs
 * the full pipeline.
 *
 * The pair (bug, expectedFixPattern) becomes a golden dataset entry:
 * a known input with a known acceptable output shape. We can later
 * check the generated PR against the pattern and score the system.
 *
 * Usage:
 *   cd web && npx tsx scripts/inject-bugs-to-demo.ts --limit=3              # dry-run
 *   cd web && npx tsx scripts/inject-bugs-to-demo.ts --limit=3 --apply      # execute
 *   cd web && npx tsx scripts/inject-bugs-to-demo.ts --limit=10 --apply     # full batch
 */
import { config } from "dotenv";
config({ path: ".env.local" });

interface Bug {
  id: string;
  path: string;
  buggyContent: string;
  alert: { title: string; body: string; fingerprint: string };
  expectedFixPattern: RegExp;
  description: string;
}

const FIXTURES_DIR = "__inari_bugs_fixtures__";

const BUGS: Bug[] = [
  {
    id: "null-deref-user-profile",
    path: `${FIXTURES_DIR}/bug-01-null-deref.js`,
    buggyContent: `// Bug: user.profile can be undefined
module.exports = function getUserName(user) {
  return user.profile.name.toUpperCase();
};
`,
    alert: {
      title: "TypeError: Cannot read property 'name' of undefined",
      body: `TypeError: Cannot read property 'name' of undefined
    at getUserName (__inari_bugs_fixtures__/bug-01-null-deref.js:3:28)
    at handler (src/api.js:14:10)
Called with user={id: 1}; profile was undefined.`,
      fingerprint: "bug-null-deref-user-profile-v1",
    },
    expectedFixPattern: /\?\.|user\?.profile|typeof.*profile|profile\s*&&|if\s*\(.*profile/,
    description: "Null deref — should use optional chaining or guard",
  },
  {
    id: "undefined-foreach",
    path: `${FIXTURES_DIR}/bug-02-foreach-undefined.js`,
    buggyContent: `// Bug: data may be undefined when API returns empty
module.exports = function sumItems(data) {
  let total = 0;
  data.forEach(item => { total += item.value; });
  return total;
};
`,
    alert: {
      title: "TypeError: Cannot read properties of undefined (reading 'forEach')",
      body: `TypeError: Cannot read properties of undefined (reading 'forEach')
    at sumItems (__inari_bugs_fixtures__/bug-02-foreach-undefined.js:4:8)
Called with data=undefined when API returned empty body.`,
      fingerprint: "bug-undefined-foreach-v1",
    },
    expectedFixPattern: /data\s*\?\s*\.|data\s*&&|\|\|\s*\[\]|Array\.isArray|if\s*\(.*data/,
    description: "forEach on undefined — should guard or default to []",
  },
  {
    id: "missing-await",
    path: `${FIXTURES_DIR}/bug-03-missing-await.js`,
    buggyContent: `// Bug: forgot await, promise leaks, error unhandled
module.exports = async function saveUser(db, user) {
  db.insert('users', user);
  return { ok: true };
};
`,
    alert: {
      title: "UnhandledPromiseRejection: database connection closed",
      body: `UnhandledPromiseRejection: database connection closed
    at saveUser (__inari_bugs_fixtures__/bug-03-missing-await.js:3:5)
Insert completed after response was sent. Possible data loss.`,
      fingerprint: "bug-missing-await-v1",
    },
    expectedFixPattern: /await\s+db\.insert/,
    description: "Missing await on async DB call — should add await",
  },
  {
    id: "division-by-zero",
    path: `${FIXTURES_DIR}/bug-04-div-zero.js`,
    buggyContent: `// Bug: no check for count=0 results in Infinity
module.exports = function average(values) {
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  return sum / count;
};
`,
    alert: {
      title: "RangeError: average returned Infinity on empty input",
      body: `RangeError: average returned Infinity on empty input
    at average (__inari_bugs_fixtures__/bug-04-div-zero.js:5:14)
values.length was 0. Downstream display shows "Infinity".`,
      fingerprint: "bug-division-by-zero-v1",
    },
    expectedFixPattern: /count\s*===?\s*0|count\s*>\s*0|if\s*\(.*length|\?\s*.*:.*0|\|\|\s*0/,
    description: "Division by zero — should guard count > 0",
  },
  {
    id: "off-by-one-loop",
    path: `${FIXTURES_DIR}/bug-05-off-by-one.js`,
    buggyContent: `// Bug: i <= length reads past end
module.exports = function sumArray(arr) {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i];
  }
  return total;
};
`,
    alert: {
      title: "TypeError: NaN returned from sumArray",
      body: `TypeError: NaN returned from sumArray
    at sumArray (__inari_bugs_fixtures__/bug-05-off-by-one.js:5:14)
Loop condition i <= arr.length reads arr[arr.length] which is undefined.
undefined + number = NaN, corrupting the sum.`,
      fingerprint: "bug-off-by-one-v1",
    },
    expectedFixPattern: /i\s*<\s*arr\.length/,
    description: "Off-by-one — should use i < arr.length",
  },
  {
    id: "json-parse-unhandled",
    path: `${FIXTURES_DIR}/bug-06-json-parse.js`,
    buggyContent: `// Bug: JSON.parse can throw on malformed input
module.exports = function parseConfig(raw) {
  const config = JSON.parse(raw);
  return config.settings;
};
`,
    alert: {
      title: "SyntaxError: Unexpected token '<' in JSON at position 0",
      body: `SyntaxError: Unexpected token '<' in JSON at position 0
    at JSON.parse (<anonymous>)
    at parseConfig (__inari_bugs_fixtures__/bug-06-json-parse.js:3:23)
Called with raw="<html>..." — server returned HTML error page instead of JSON.`,
      fingerprint: "bug-json-parse-v1",
    },
    expectedFixPattern: /try\s*\{|catch\s*\(|\.catch\s*\(/,
    description: "Unhandled JSON.parse — should wrap in try/catch",
  },
  {
    id: "sql-injection-concat",
    path: `${FIXTURES_DIR}/bug-07-sql-injection.js`,
    buggyContent: `// Bug: SQL built via string concat — injection vector
module.exports = function findUser(db, userId) {
  return db.query("SELECT * FROM users WHERE id = '" + userId + "'");
};
`,
    alert: {
      title: "SQL injection detected: unescaped user input in query",
      body: `SQL injection detected: unescaped user input in query
    at findUser (__inari_bugs_fixtures__/bug-07-sql-injection.js:3:22)
Input userId="1'; DROP TABLE users; --" concatenated into query string.`,
      fingerprint: "bug-sql-injection-v1",
    },
    expectedFixPattern: /\$\d|\?\s*$|parameterize|prepared|db\.query\s*\([^,]+,\s*\[/,
    description: "SQL injection — should use parameterized query",
  },
  {
    id: "missing-error-handler",
    path: `${FIXTURES_DIR}/bug-08-unhandled-fetch.js`,
    buggyContent: `// Bug: fetch without error handling, returns undefined silently
module.exports = async function loadUser(id) {
  const res = await fetch(\`/api/users/\${id}\`);
  const user = await res.json();
  return user.name;
};
`,
    alert: {
      title: "TypeError: Cannot read properties of undefined (reading 'name')",
      body: `TypeError: Cannot read properties of undefined (reading 'name')
    at loadUser (__inari_bugs_fixtures__/bug-08-unhandled-fetch.js:5:15)
Fetch returned 500 status, res.json() returned {}. user.name undefined.`,
      fingerprint: "bug-unhandled-fetch-v1",
    },
    expectedFixPattern: /res\.ok|res\.status|if\s*\(.*res|throw|catch/,
    description: "Unhandled fetch failure — should check res.ok",
  },
  {
    id: "type-coercion",
    path: `${FIXTURES_DIR}/bug-09-loose-equality.js`,
    buggyContent: `// Bug: == with "0" string vs 0 number creates subtle branch
module.exports = function isPositive(n) {
  if (n == 0) return false;
  return n > 0;
};
// isPositive("") returns false (empty string == 0), caller expected true/throw
`,
    alert: {
      title: "Invariant violation: isPositive(\"\") returned false",
      body: `Invariant violation: isPositive("") returned false instead of throwing
    at isPositive (__inari_bugs_fixtures__/bug-09-loose-equality.js:3:9)
Loose equality "" == 0 is true in JS; caller expected a thrown TypeError.`,
      fingerprint: "bug-loose-equality-v1",
    },
    expectedFixPattern: /===\s*0|typeof.*number|Number\.isFinite|!Number\.isNaN/,
    description: "Loose equality — should use === or validate type",
  },
  {
    id: "race-condition-counter",
    path: `${FIXTURES_DIR}/bug-10-race-condition.js`,
    buggyContent: `// Bug: read-then-write without lock races under concurrency
let counter = 0;
module.exports = function increment() {
  const current = counter;
  counter = current + 1;
  return counter;
};
`,
    alert: {
      title: "Counter inconsistency: expected 1000, got 847 under concurrent load",
      body: `Counter inconsistency: expected 1000, got 847 under concurrent load
    at increment (__inari_bugs_fixtures__/bug-10-race-condition.js:4:17)
Concurrent callers read the same value before the write landed. Classic race.`,
      fingerprint: "bug-race-condition-v1",
    },
    expectedFixPattern: /\+\+counter|counter\s*\+=|atomic|lock|mutex|Atomics/,
    description: "Race condition — should use atomic ++ or lock",
  },
];

async function main() {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "3", 10);
  const apply = args.includes("--apply");
  const targetRepo = args.find((a) => a.startsWith("--repo="))?.split("=")[1] ?? "orbita-pos/inariwatch-demo-store";
  const delaySec = parseInt(args.find((a) => a.startsWith("--delay="))?.split("=")[1] ?? "45", 10);

  const { db } = await import("../lib/db");
  const { projects, projectIntegrations } = await import("../lib/db");
  const { eq, and } = await import("drizzle-orm");
  const { decryptConfig } = await import("../lib/crypto");

  console.log(`\n=== Bug Injection ===`);
  console.log(`Repo:         ${targetRepo}`);
  console.log(`Limit:        ${limit} bugs`);
  console.log(`Delay:        ${delaySec}s between bugs (to avoid storm detection)`);
  console.log(`Mode:         ${apply ? "APPLY" : "DRY-RUN"}`);

  const bugs = BUGS.slice(0, limit);

  if (!apply) {
    console.log(`\nBugs to inject:`);
    for (const b of bugs) {
      console.log(`  ${b.id.padEnd(30)} ${b.path}`);
      console.log(`    ${b.description}`);
      console.log(`    alert: "${b.alert.title.slice(0, 70)}"`);
      console.log(`    expected: ${b.expectedFixPattern}`);
      console.log(``);
    }
    console.log(`Re-run with --apply to execute.`);
    process.exit(0);
  }

  // Resolve the demo project's capture integration for webhook POST
  const [demoProj] = await db
    .select({ id: projects.id, slug: projects.slug, defaultRepo: projects.defaultRepo })
    .from(projects)
    .where(eq(projects.slug, "demo"))
    .limit(1);
  if (!demoProj) { console.error("Project 'demo' not found"); process.exit(1); }

  const integs = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      eq(projectIntegrations.projectId, demoProj.id),
      eq(projectIntegrations.isActive, true),
    ));
  const captureInteg = integs.find((i) => i.service === "capture");
  const ghInteg = integs.find((i) => i.service === "github");
  if (!captureInteg) { console.error("'demo' project has no capture integration"); process.exit(1); }
  if (!ghInteg) { console.error("'demo' project has no github integration"); process.exit(1); }

  const captureCfg = decryptConfig(captureInteg.configEncrypted);
  const ghCfg = decryptConfig(ghInteg.configEncrypted);
  const webhookSecret = captureInteg.webhookSecret
    ? (await import("../lib/crypto")).decrypt(captureInteg.webhookSecret)
    : null;

  const [targetOwner, targetRepoName] = targetRepo.split("/");
  if (targetOwner !== (ghCfg.owner as string)) {
    console.error(`Target repo owner '${targetOwner}' != github integration owner '${ghCfg.owner}'`);
    process.exit(1);
  }

  const ghToken = ghCfg.token as string;

  // Auto-detect default branch — repos vary (main, master, trunk, …)
  const repoInfoRes = await fetch(`https://api.github.com/repos/${targetRepo}`, {
    headers: { Authorization: `Bearer ${ghToken}` },
  });
  if (!repoInfoRes.ok) {
    console.error(`Cannot read repo info: ${repoInfoRes.status}`);
    process.exit(1);
  }
  const repoInfo = (await repoInfoRes.json()) as { default_branch: string };
  const defaultBranch = repoInfo.default_branch;
  console.log(`Default branch: ${defaultBranch}`);

  const results: {
    bugId: string;
    path: string;
    commitSha?: string;
    alertId?: string;
    sessionId?: string;
    outcome?: string;
    prUrl?: string;
    error?: string;
  }[] = [];

  const crypto = await import("crypto");

  for (let i = 0; i < bugs.length; i++) {
    const bug = bugs[i];
    console.log(`\n[${i + 1}/${bugs.length}] ${bug.id}`);

    const result: typeof results[number] = { bugId: bug.id, path: bug.path };

    // ── 1. Commit buggy file via GitHub API ────────────────────────
    try {
      const commitRes = await fetch(
        `https://api.github.com/repos/${targetRepo}/contents/${bug.path}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: `chore(fixtures): inject bug ${bug.id} for golden dataset`,
            content: Buffer.from(bug.buggyContent).toString("base64"),
            branch: defaultBranch,
          }),
        }
      );
      if (!commitRes.ok) {
        // File might already exist — try fetching sha and updating
        const existingRes = await fetch(
          `https://api.github.com/repos/${targetRepo}/contents/${bug.path}?ref=${defaultBranch}`,
          { headers: { Authorization: `Bearer ${ghToken}` } }
        );
        if (existingRes.ok) {
          const existing = (await existingRes.json()) as { sha: string };
          const updateRes = await fetch(
            `https://api.github.com/repos/${targetRepo}/contents/${bug.path}`,
            {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${ghToken}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                message: `chore(fixtures): refresh bug ${bug.id} for golden dataset`,
                content: Buffer.from(bug.buggyContent).toString("base64"),
                sha: existing.sha,
                branch: defaultBranch,
              }),
            }
          );
          if (!updateRes.ok) {
            result.error = `commit failed: ${updateRes.status} ${(await updateRes.text()).slice(0, 120)}`;
            results.push(result);
            continue;
          }
          const upd = await updateRes.json() as { commit?: { sha?: string } };
          result.commitSha = upd.commit?.sha?.slice(0, 7);
        } else {
          result.error = `commit failed: ${commitRes.status} ${(await commitRes.text()).slice(0, 120)}`;
          results.push(result);
          continue;
        }
      } else {
        const cm = await commitRes.json() as { commit?: { sha?: string } };
        result.commitSha = cm.commit?.sha?.slice(0, 7);
      }
      console.log(`  ✓ committed to ${bug.path} (${result.commitSha})`);
    } catch (err) {
      result.error = `commit threw: ${err instanceof Error ? err.message : String(err)}`;
      results.push(result);
      continue;
    }

    // ── 2. POST simulated capture webhook ──────────────────────────
    const webhookPayload = {
      fingerprint: bug.alert.fingerprint + "-" + Date.now(),
      title: bug.alert.title,
      body: bug.alert.body,
      severity: "critical",
      timestamp: new Date().toISOString(),
      environment: "production",
      git: { repo: targetRepo },
      // Mark as synthetic so we can filter it out in analytics if desired
      metadata: { source: "bug-injection-script", bugId: bug.id, expectedFixPattern: bug.expectedFixPattern.source },
    };
    const payloadStr = JSON.stringify(webhookPayload);
    const signature = webhookSecret
      ? "sha256=" + crypto.createHmac("sha256", webhookSecret).update(payloadStr).digest("hex")
      : "";

    try {
      const webhookUrl = `https://app.inariwatch.com/api/webhooks/capture/${captureInteg.id}`;
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(signature ? { "x-capture-signature": signature } : {}),
        },
        body: payloadStr,
      });
      if (!res.ok) {
        result.error = `webhook POST failed: ${res.status} ${(await res.text()).slice(0, 120)}`;
        results.push(result);
        continue;
      }
      const wb = await res.json() as { alertId?: string };
      result.alertId = wb.alertId;
      console.log(`  ✓ alert posted (id: ${result.alertId?.slice(0, 8) ?? "?"})`);
    } catch (err) {
      result.error = `webhook threw: ${err instanceof Error ? err.message : String(err)}`;
      results.push(result);
      continue;
    }

    results.push(result);

    // ── 3. Delay before next bug (storm detection protection) ──────
    if (i < bugs.length - 1) {
      console.log(`  ... waiting ${delaySec}s before next bug`);
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
  }

  console.log(`\n=== Injection Summary ===`);
  console.log(`Injected:  ${results.filter((r) => r.alertId).length}/${results.length}`);
  console.log(``);
  console.log(`bug_id                         commit   alert_id   error`);
  for (const r of results) {
    console.log(
      `  ${r.bugId.padEnd(30)} ${(r.commitSha ?? "—").padEnd(8)} ${(r.alertId?.slice(0, 8) ?? "—").padEnd(10)} ${(r.error ?? "").slice(0, 60)}`
    );
  }

  console.log(`\nFollow outcomes in /admin/ai. Each successful alert should auto-remediate within ~2-5 min.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
