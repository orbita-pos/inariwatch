/**
 * Inari Live V1 — Session 4. Desktop-side host catalogue.
 *
 * Mirror of `web/lib/hosts.ts` minus the framework snippets — the
 * desktop wizard renders the same tabs the manual setup page does for
 * Tier 3, but never lays the SDK install snippets in front of the user
 * (the install pipeline already wrote .env.local + patched config).
 *
 * Keep this file in sync with the web copy: when adding a host, update
 * both files + the Rust `detect_host()` in
 * `desktop/src-tauri/src/wizard/detect.rs`.
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

export type Tier = 1 | 2 | 3;

export type HostIconName = "Globe" | "Cloud" | "Server" | "Container" | "Boxes";

export interface HostMeta {
  id:            HostId;
  name:          string;
  tier:          Tier;
  /** lucide-react icon name; the React side switches on this string. */
  icon:          HostIconName;
  /** Tier-2 deeplink (full URL — wizard opens via `wizardOpenHostDashboard`). */
  dashboardUrl?: string;
  /** Hint rendered next to the dashboard button. Tier 2 only. */
  dashboardHint?: string;
  /** Body for the host-sync step's "How to add" panel. */
  instructions:  string;
}

export const HOSTS: Record<HostId, HostMeta> = {
  vercel: {
    id:   "vercel",
    name: "Vercel",
    tier: 1,
    icon: "Globe",
    dashboardUrl: "https://vercel.com/dashboard",
    dashboardHint:
      "Already wired automatically by the install pipeline. No further action needed.",
    instructions:
      "The wizard already pushed INARIWATCH_DSN to all three Vercel environments via your connected integration.",
  },
  netlify: {
    id:   "netlify",
    name: "Netlify",
    tier: 2,
    icon: "Globe",
    dashboardUrl: "https://app.netlify.com/teams",
    dashboardHint:
      "Open your site → Site settings → Environment variables → Add a variable.",
    instructions: [
      "1. The token is in your clipboard.",
      "2. We just opened app.netlify.com — pick your site.",
      "3. Site settings → Environment variables → Add a variable.",
      "4. Name: INARIWATCH_DSN  ·  Value: paste from clipboard.",
      "5. Save and trigger a redeploy.",
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
      "1. The token is in your clipboard.",
      "2. We just opened railway.app — pick your project.",
      "3. Variables tab → New Variable.",
      "4. Name: INARIWATCH_DSN  ·  Value: paste from clipboard.",
      "5. Railway auto-redeploys when secrets change.",
    ].join("\n"),
  },
  fly: {
    id:   "fly",
    name: "Fly.io",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://fly.io/apps",
    dashboardHint:
      "Pick your app → Secrets in the left rail. Or run `fly secrets set INARIWATCH_DSN=…`",
    instructions: [
      "Option A — dashboard:",
      "1. The token is in your clipboard.",
      "2. We just opened fly.io/apps — pick your app.",
      "3. Secrets (left rail) → New Secret. Name: INARIWATCH_DSN. Value: paste.",
      "",
      "Option B — CLI:",
      "    fly secrets set INARIWATCH_DSN=\"<paste from clipboard>\"",
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
      "1. The token is in your clipboard.",
      "2. We just opened dashboard.render.com — pick your service.",
      "3. Environment (left rail) → Add Environment Variable.",
      "4. Key: INARIWATCH_DSN  ·  Value: paste from clipboard.",
      "5. Save Changes — Render redeploys automatically.",
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
      "1. The token is in your clipboard.",
      "2. We just opened dash.cloudflare.com — Workers & Pages → your project.",
      "3. Settings → Variables and Secrets → Add variable. Type: Secret.",
      "4. Name: INARIWATCH_DSN  ·  Value: paste from clipboard.",
      "5. Production + Preview environments. Save and redeploy.",
      "",
      "Or via wrangler CLI:",
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
      "1. The token is in your clipboard.",
      "2. We just opened dashboard.heroku.com — pick your app → Settings.",
      "3. Reveal Config Vars → Add a config var.",
      "4. KEY: INARIWATCH_DSN  ·  VALUE: paste from clipboard.",
      "5. Heroku restarts the dynos automatically.",
      "",
      "Or with heroku CLI:",
      "    heroku config:set INARIWATCH_DSN=\"<paste from clipboard>\"",
    ].join("\n"),
  },
  gcp_app_engine: {
    id:   "gcp_app_engine",
    name: "GCP App Engine",
    tier: 2,
    icon: "Cloud",
    dashboardUrl: "https://console.cloud.google.com/appengine",
    dashboardHint:
      "App Engine env vars live in app.yaml — there's no dashboard field.",
    instructions: [
      "App Engine reads env vars from app.yaml — there is no dashboard field.",
      "",
      "Edit app.yaml and add:",
      "    env_variables:",
      "      INARIWATCH_DSN: \"<paste from clipboard>\"",
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
      "1. Create a Secret with the token from your clipboard:",
      "    kubectl create secret generic inariwatch \\",
      "      --from-literal=INARIWATCH_DSN=\"<paste from clipboard>\"",
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
      "          - INARIWATCH_DSN=<paste from clipboard>",
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
      "      -e INARIWATCH_DSN=\"<paste from clipboard>\" \\",
      "      your-image",
      "",
      "Or in a Dockerfile (prefer runtime injection — Dockerfile bakes the token into the image):",
      "    ENV INARIWATCH_DSN=\"<paste from clipboard>\"",
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
      "    Environment=INARIWATCH_DSN=<paste from clipboard>",
      "",
      "PM2 ecosystem.config.js:",
      "    module.exports = {",
      "      apps: [{",
      "        name: \"app\",",
      "        script: \"server.js\",",
      "        env: { INARIWATCH_DSN: \"<paste from clipboard>\" }",
      "      }]",
      "    }",
      "",
      "Or pass it inline:",
      "    INARIWATCH_DSN=\"<paste from clipboard>\" node server.js",
    ].join("\n"),
  },
};

export const HOST_TIERS: Record<Tier, HostId[]> = {
  1: ["vercel"],
  2: ["netlify", "railway", "fly", "render", "cloudflare", "heroku", "gcp_app_engine"],
  3: ["kubernetes", "docker_compose", "docker", "self_hosted_other"],
};

export function getHostMeta(id: string | null | undefined): HostMeta | null {
  if (!id) return null;
  return (HOSTS as Record<string, HostMeta>)[id] ?? null;
}

/** Convenience: bucket a host id into its tier. */
export function tierOf(id: string | null | undefined): Tier | null {
  const meta = getHostMeta(id);
  return meta ? meta.tier : null;
}
