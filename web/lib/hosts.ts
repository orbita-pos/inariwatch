/**
 * Inari Live V1 — Session 4. Host + framework SSOT.
 *
 * Used by:
 *   * `/dashboard/projects/[slug]/manual-setup` — renders host + framework
 *     instruction tabs.
 *   * `desktop/src/lib/wizard/hosts.ts` — mirror copy for the Tier 2/3
 *     wizard step. Keep the two in sync when a host is added.
 *
 * Host ids match the strings the Rust wizard returns from
 * `detect_host()` (see `desktop/src-tauri/src/wizard/detect.rs`). When
 * adding a new host, update both sides + `HOST_TIERS` below.
 */

export type HostId =
  | "vercel"
  | "netlify"
  | "railway"
  | "fly"
  | "render"
  | "cloudflare"
  | "heroku"
  | "gcp_app_engine"
  | "kubernetes"
  | "docker_compose"
  | "docker"
  | "self_hosted_other";

export type FrameworkId = "next" | "express" | "vite" | "other";

export type Tier = 1 | 2 | 3;

export interface HostMeta {
  id:           HostId;
  name:         string;
  tier:         Tier;
  /** lucide-react icon name, looked up by the React side at render. */
  icon:         "Globe" | "Cloud" | "Server" | "Container" | "Boxes" | "Cog";
  /**
   * Tier 2 deeplink template. The wizard / manual page resolves
   * `{slug}` (project name) and `{owner}` (workspace) at render. When
   * the host doesn't have a deterministic deeplink for the env-vars
   * page (Railway / Fly), we fall back to the dashboard root and
   * include a one-line "navigate to: …" hint in `dashboardHint`.
   */
  dashboardUrl?: string;
  /** Human hint for navigating once the dashboard opens. Tier 2 only. */
  dashboardHint?: string;
  /** Instruction body for the manual-setup tab + the wizard's host-sync step. */
  instructions: string;
}

/**
 * Lookup map. Order matters for the dropdown UX in the manual setup
 * page + the universal escape hatch — the order here is what the user
 * sees top-to-bottom.
 */
export const HOSTS: Record<HostId, HostMeta> = {
  vercel: {
    id:   "vercel",
    name: "Vercel",
    tier: 1,
    icon: "Globe",
    dashboardUrl: "https://vercel.com/dashboard",
    dashboardHint:
      "Open your project → Settings → Environment Variables → Add INARIWATCH_DSN to Production / Preview / Development.",
    instructions: [
      "1. Open your project on vercel.com.",
      "2. Settings → Environment Variables.",
      "3. Add INARIWATCH_DSN with the value above. Tick Production, Preview, Development.",
      "4. Redeploy (Deployments tab → ⋯ → Redeploy) so the env var lands in the running build.",
    ].join("\n"),
  },
  netlify: {
    id:   "netlify",
    name: "Netlify",
    tier: 2,
    icon: "Globe",
    // Netlify env-vars page is per-project — `app.netlify.com/projects` lists
    // them; users click in. We can't deeplink straight to env vars without
    // the project slug, which we don't store yet (V1.5 follow-up).
    dashboardUrl: "https://app.netlify.com/teams",
    dashboardHint:
      "Open your site → Site settings → Environment variables → Add a variable.",
    instructions: [
      "1. Open app.netlify.com → your site.",
      "2. Site settings → Environment variables → Add a variable.",
      "3. Key: INARIWATCH_DSN  ·  Value: paste the token above.",
      "4. Save. Trigger a fresh deploy (Deploys tab → Trigger deploy).",
    ].join("\n"),
  },
  railway: {
    id:   "railway",
    name: "Railway",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://railway.app/dashboard",
    dashboardHint:
      "Pick your project → Variables tab → New Variable.",
    instructions: [
      "1. Open railway.app → your project.",
      "2. Variables tab (top nav) → New Variable.",
      "3. Name: INARIWATCH_DSN  ·  Value: paste the token above.",
      "4. Railway auto-redeploys on save.",
    ].join("\n"),
  },
  fly: {
    id:   "fly",
    name: "Fly.io",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://fly.io/apps",
    dashboardHint:
      "Pick your app → Secrets in the left rail. Or run: fly secrets set INARIWATCH_DSN=…",
    instructions: [
      "Option A — dashboard:",
      "1. fly.io/apps → your app → Secrets.",
      "2. Set INARIWATCH_DSN to the token above.",
      "",
      "Option B — CLI (faster):",
      "    fly secrets set INARIWATCH_DSN=\"<token>\"",
      "",
      "Fly redeploys automatically when secrets change.",
    ].join("\n"),
  },
  render: {
    id:   "render",
    name: "Render",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://dashboard.render.com",
    dashboardHint:
      "Pick your service → Environment in the left rail → Add Environment Variable.",
    instructions: [
      "1. dashboard.render.com → your service.",
      "2. Environment (left rail) → Add Environment Variable.",
      "3. Key: INARIWATCH_DSN  ·  Value: paste the token above.",
      "4. Save Changes — Render redeploys automatically.",
    ].join("\n"),
  },
  cloudflare: {
    id:   "cloudflare",
    name: "Cloudflare",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://dash.cloudflare.com",
    dashboardHint:
      "Workers & Pages → your project → Settings → Variables and Secrets.",
    instructions: [
      "Workers & Pages:",
      "1. dash.cloudflare.com → Workers & Pages → your project.",
      "2. Settings → Variables and Secrets → Add variable.",
      "3. Type: Secret  ·  Name: INARIWATCH_DSN  ·  Value: paste the token above.",
      "4. Production + Preview environments. Save and deploy.",
      "",
      "Or with wrangler CLI:",
      "    wrangler secret put INARIWATCH_DSN",
    ].join("\n"),
  },
  heroku: {
    id:   "heroku",
    name: "Heroku",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://dashboard.heroku.com/apps",
    dashboardHint:
      "Pick your app → Settings → Reveal Config Vars → Add a config var.",
    instructions: [
      "1. dashboard.heroku.com/apps → your app → Settings.",
      "2. Reveal Config Vars → Add a config var.",
      "3. KEY: INARIWATCH_DSN  ·  VALUE: paste the token above.",
      "4. Heroku restarts the dynos with the new value automatically.",
      "",
      "Or with heroku CLI:",
      "    heroku config:set INARIWATCH_DSN=\"<token>\" --app <your-app>",
    ].join("\n"),
  },
  gcp_app_engine: {
    id:   "gcp_app_engine",
    name: "GCP App Engine",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://console.cloud.google.com/appengine",
    dashboardHint:
      "App Engine env vars live in app.yaml. Add the line below and redeploy.",
    instructions: [
      "App Engine reads env vars from app.yaml — there is no dashboard field.",
      "",
      "Edit app.yaml and add:",
      "    env_variables:",
      "      INARIWATCH_DSN: \"<token>\"",
      "",
      "Then redeploy:",
      "    gcloud app deploy",
    ].join("\n"),
  },
  kubernetes: {
    id:   "kubernetes",
    name: "Kubernetes",
    tier: 3,
    icon: "Boxes",
    instructions: [
      "1. Create a Secret with your token:",
      "    kubectl create secret generic inariwatch \\",
      "      --from-literal=INARIWATCH_DSN=\"<token>\"",
      "",
      "2. Reference it in your Deployment:",
      "    env:",
      "      - name: INARIWATCH_DSN",
      "        valueFrom:",
      "          secretKeyRef:",
      "            name: inariwatch",
      "            key:  INARIWATCH_DSN",
      "",
      "3. Re-apply:",
      "    kubectl apply -f deployment.yaml",
    ].join("\n"),
  },
  docker_compose: {
    id:   "docker_compose",
    name: "docker-compose",
    tier: 3,
    icon: "Container",
    instructions: [
      "Add the env var to your service in docker-compose.yml:",
      "",
      "    services:",
      "      app:",
      "        image: your-app",
      "        environment:",
      "          - INARIWATCH_DSN=<token>",
      "",
      "Then restart:",
      "    docker compose up -d --force-recreate",
    ].join("\n"),
  },
  docker: {
    id:   "docker",
    name: "Docker",
    tier: 3,
    icon: "Container",
    instructions: [
      "Pass the env var on `docker run`:",
      "",
      "    docker run \\",
      "      -e INARIWATCH_DSN=\"<token>\" \\",
      "      your-image",
      "",
      "Or in a Dockerfile:",
      "    ENV INARIWATCH_DSN=\"<token>\"",
      "(prefer runtime injection — Dockerfile bakes the token into the image layer)",
    ].join("\n"),
  },
  self_hosted_other: {
    id:   "self_hosted_other",
    name: "Other / self-hosted",
    tier: 3,
    icon: "Server",
    instructions: [
      "Set INARIWATCH_DSN in your runtime environment.",
      "",
      "systemd unit:",
      "    [Service]",
      "    Environment=INARIWATCH_DSN=<token>",
      "",
      "PM2 ecosystem.config.js:",
      "    module.exports = {",
      "      apps: [{",
      "        name: \"app\",",
      "        script: \"server.js\",",
      "        env: { INARIWATCH_DSN: \"<token>\" }",
      "      }]",
      "    }",
      "",
      "Or pass it inline when starting the process:",
      "    INARIWATCH_DSN=\"<token>\" node server.js",
    ].join("\n"),
  },
};

/**
 * Tier-grouped host ids — drives the Tier-2 / Tier-3 ordering in the
 * manual setup host dropdown + the wizard's escape hatch.
 */
export const HOST_TIERS: Record<Tier, HostId[]> = {
  1: ["vercel"],
  2: ["netlify", "railway", "fly", "render", "cloudflare", "heroku", "gcp_app_engine"],
  3: ["kubernetes", "docker_compose", "docker", "self_hosted_other"],
};

export function getHostMeta(id: string | null | undefined): HostMeta | null {
  if (!id) return null;
  return (HOSTS as Record<string, HostMeta>)[id] ?? null;
}

// ── Framework + capture SDK snippets ────────────────────────────────────────

export interface FrameworkSnippet {
  id:           FrameworkId;
  name:         string;
  /** Shown above the snippet block in the manual-setup tab. */
  description:  string;
  /** Shell + code snippets, in order. Each is a `{ kind, body }` block. */
  steps:        Array<
    | { kind: "shell";    body: string }
    | { kind: "patch";    file: string; body: string }
    | { kind: "env";      file: string; body: string }
  >;
}

/**
 * Build the per-framework snippet block. The DSN string is embedded so
 * the manual setup UI can render it with the user's freshly-minted
 * plaintext token (then mask it once dismissed).
 *
 * `dsn` is expected to be the full DSN URL (`https://<token>@host/capture/<id>`)
 * — this is what `.env.local` consumes and what the SDK accepts. The
 * caller substitutes `<your DSN>` placeholder after dismissal.
 */
export function buildFrameworkSnippets(framework: FrameworkId, dsn: string): FrameworkSnippet {
  const escapedDsn = dsn; // No special escaping — DSN is already URL-safe.
  switch (framework) {
    case "next":
      return {
        id:   "next",
        name: "Next.js",
        description:
          "Wrap your Next config with `withInariWatch` and add an instrumentation file. Works for Next 13+.",
        steps: [
          { kind: "shell", body: "npm install @inariwatch/capture" },
          {
            kind: "patch",
            file: "next.config.ts",
            body: [
              "import { withInariWatch } from \"@inariwatch/capture/next\";",
              "",
              "const nextConfig = {",
              "  /* your config here */",
              "};",
              "",
              "export default withInariWatch(nextConfig);",
            ].join("\n"),
          },
          {
            kind: "patch",
            file: "instrumentation.ts",
            body: [
              "import \"@inariwatch/capture/auto\";",
              "export { captureRequestError as onRequestError } from \"@inariwatch/capture\";",
            ].join("\n"),
          },
          {
            kind: "env",
            file: ".env.local",
            body: `INARIWATCH_DSN=${escapedDsn}`,
          },
        ],
      };

    case "express":
      return {
        id:   "express",
        name: "Express / Node",
        description:
          "Add a side-effect import that boots the SDK before your routes load.",
        steps: [
          { kind: "shell", body: "npm install @inariwatch/capture" },
          {
            kind: "patch",
            file: "instrumentation.ts",
            body: [
              "// Import once, as early as possible in your entry point.",
              "import \"@inariwatch/capture/auto\";",
            ].join("\n"),
          },
          {
            kind: "shell",
            body:
              "# Or pass the SDK as a Node loader (zero source changes):\n"
              + "node --import @inariwatch/capture/auto server.js",
          },
          {
            kind: "env",
            file: ".env",
            body: `INARIWATCH_DSN=${escapedDsn}`,
          },
        ],
      };

    case "vite":
      return {
        id:   "vite",
        name: "Vite / SPA",
        description:
          "Drop a side-effect import at the top of your entry file. Errors in the browser are shipped via the InariWatch transport.",
        steps: [
          { kind: "shell", body: "npm install @inariwatch/capture" },
          {
            kind: "patch",
            file: "src/main.tsx",
            body: [
              "import \"@inariwatch/capture/auto\";",
              "// …rest of your existing imports + bootstrap",
            ].join("\n"),
          },
          {
            kind: "env",
            file: ".env.local",
            body: `INARIWATCH_DSN=${escapedDsn}`,
          },
        ],
      };

    case "other":
    default:
      return {
        id:   "other",
        name: "Other (manual)",
        description:
          "Install the SDK and import it once. The capture client reads INARIWATCH_DSN from the environment.",
        steps: [
          { kind: "shell", body: "npm install @inariwatch/capture" },
          {
            kind: "patch",
            file: "(your entry file)",
            body: "import \"@inariwatch/capture/auto\";",
          },
          {
            kind: "env",
            file: ".env",
            body: `INARIWATCH_DSN=${escapedDsn}`,
          },
        ],
      };
  }
}

/**
 * Detect the project framework from package.json contents. Mirrors the
 * Rust `detect_framework()` in `desktop/src-tauri/src/wizard/detect.rs`
 * so the manual setup page picks the same default tab the desktop
 * wizard would pick on the same repo.
 */
export function frameworkFromPackageJson(pkg: unknown): FrameworkId {
  if (!pkg || typeof pkg !== "object") return "other";
  const obj = pkg as Record<string, unknown>;
  const deps: Record<string, unknown> = {
    ...((obj.dependencies as Record<string, unknown>) ?? {}),
    ...((obj.devDependencies as Record<string, unknown>) ?? {}),
    ...((obj.peerDependencies as Record<string, unknown>) ?? {}),
  };
  if ("next" in deps)    return "next";
  if ("vite" in deps)    return "vite";
  if ("express" in deps) return "express";
  return "other";
}

/**
 * Detect the deploy host from a flat list of repo top-level filenames.
 * Mirrors the precedence rules in `desktop/src-tauri/src/wizard/detect.rs`
 * so the manual setup page pre-selects the same host tab the desktop
 * wizard would.
 *
 * The caller fetches the file list from the GitHub Tree API (`/repos/.../
 * git/trees/<branch>?recursive=0`) and passes it through. Directory entries
 * are accepted with or without a trailing slash.
 */
export function detectHostFromTopLevel(files: ReadonlyArray<string>): HostId | null {
  const has = (name: string) => files.includes(name);
  const hasDir = (name: string) =>
    files.includes(name) || files.includes(`${name}/`) || files.some((f) => f.startsWith(`${name}/`));

  // Tier 1.
  if (has("vercel.json") || hasDir(".vercel")) return "vercel";

  // Tier 2 — order matches the Rust priority.
  if (has("netlify.toml") || hasDir("netlify")) return "netlify";
  if (has("railway.json") || has("railway.toml")) return "railway";
  if (has("fly.toml")) return "fly";
  if (has("render.yaml")) return "render";
  if (has("wrangler.toml") || has("wrangler.jsonc") || has("wrangler.json")) {
    return "cloudflare";
  }
  if (has("Procfile")) return "heroku";
  // app.yaml only counts when the file is App-Engine-shaped (`runtime:`).
  // The shallow tree call doesn't give us body — caller can pass the
  // file content via the optional second arg if it has it. For SSR
  // we treat raw `app.yaml` as ambiguous and return null below; the
  // user can override via the dropdown.

  // Tier 3.
  if (hasDir("k8s") || hasDir("kubernetes") || hasDir("manifests")) {
    return "kubernetes";
  }
  if (
    has("docker-compose.yml") ||
    has("docker-compose.yaml") ||
    has("compose.yml") ||
    has("compose.yaml")
  ) {
    return "docker_compose";
  }
  if (has("Dockerfile")) return "docker";

  return null;
}
