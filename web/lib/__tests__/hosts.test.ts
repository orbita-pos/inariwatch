/**
 * Inari Live V1 — Session 4. Tests for the host + framework SSOT.
 *
 * Covers:
 *   * `frameworkFromPackageJson` — mirror of the Rust `detect_framework`
 *   * `detectHostFromTopLevel`   — mirror of the Rust `detect_host`
 *   * `buildFrameworkSnippets`   — DSN substitution + per-framework shape
 *   * `getHostMeta` + `HOST_TIERS` — lookup integrity
 */

import { describe, expect, it } from "vitest";

import {
  HOSTS,
  HOST_TIERS,
  buildFrameworkSnippets,
  detectHostFromTopLevel,
  frameworkFromPackageJson,
  getHostMeta,
  type FrameworkId,
  type HostId,
} from "../hosts";

describe("frameworkFromPackageJson", () => {
  it("returns 'next' when next is in dependencies", () => {
    expect(
      frameworkFromPackageJson({
        dependencies: { next: "^15.0.0", react: "^18" },
      }),
    ).toBe("next");
  });

  it("returns 'next' when next is in devDependencies", () => {
    expect(
      frameworkFromPackageJson({
        devDependencies: { next: "^15.0.0" },
      }),
    ).toBe("next");
  });

  it("returns 'vite' when vite is present and next is not", () => {
    expect(
      frameworkFromPackageJson({
        devDependencies: { vite: "^5.0.0" },
      }),
    ).toBe("vite");
  });

  it("returns 'express' when express is present", () => {
    expect(
      frameworkFromPackageJson({
        dependencies: { express: "^4.18.0" },
      }),
    ).toBe("express");
  });

  it("prefers next over vite when both are present", () => {
    expect(
      frameworkFromPackageJson({
        dependencies: { next: "^15.0.0" },
        devDependencies: { vite: "^5.0.0" },
      }),
    ).toBe("next");
  });

  it("returns 'other' for unrecognised packages", () => {
    expect(
      frameworkFromPackageJson({
        dependencies: { koa: "^2.0.0" },
      }),
    ).toBe("other");
  });

  it("returns 'other' for malformed input", () => {
    expect(frameworkFromPackageJson(null)).toBe("other");
    expect(frameworkFromPackageJson(undefined)).toBe("other");
    expect(frameworkFromPackageJson("not-an-object")).toBe("other");
  });
});

describe("detectHostFromTopLevel", () => {
  // Tier 1.
  it("detects Vercel via vercel.json", () => {
    expect(detectHostFromTopLevel(["vercel.json", "package.json"])).toBe("vercel");
  });

  it("detects Vercel via .vercel/project.json", () => {
    expect(detectHostFromTopLevel([".vercel/", ".vercel/project.json"])).toBe("vercel");
  });

  // Tier 2.
  it("detects Netlify via netlify.toml", () => {
    expect(detectHostFromTopLevel(["netlify.toml"])).toBe("netlify");
  });

  it("detects Netlify via netlify/functions/", () => {
    expect(detectHostFromTopLevel(["netlify/", "netlify/functions/"])).toBe("netlify");
  });

  it("detects Railway via railway.json", () => {
    expect(detectHostFromTopLevel(["railway.json"])).toBe("railway");
  });

  it("detects Fly via fly.toml", () => {
    expect(detectHostFromTopLevel(["fly.toml"])).toBe("fly");
  });

  it("prefers Fly over Heroku when both fly.toml and Procfile present", () => {
    expect(detectHostFromTopLevel(["fly.toml", "Procfile"])).toBe("fly");
  });

  it("detects Render via render.yaml", () => {
    expect(detectHostFromTopLevel(["render.yaml"])).toBe("render");
  });

  it("detects Cloudflare via wrangler.toml", () => {
    expect(detectHostFromTopLevel(["wrangler.toml"])).toBe("cloudflare");
  });

  it("detects Cloudflare via wrangler.jsonc", () => {
    expect(detectHostFromTopLevel(["wrangler.jsonc"])).toBe("cloudflare");
  });

  it("detects Heroku via Procfile", () => {
    expect(detectHostFromTopLevel(["Procfile"])).toBe("heroku");
  });

  // Tier 3.
  it("detects Kubernetes via k8s/ folder", () => {
    expect(detectHostFromTopLevel(["k8s/"])).toBe("kubernetes");
  });

  it("detects Kubernetes via manifests/ folder", () => {
    expect(detectHostFromTopLevel(["manifests/"])).toBe("kubernetes");
  });

  it("detects docker-compose via compose.yml", () => {
    expect(detectHostFromTopLevel(["compose.yml"])).toBe("docker_compose");
  });

  it("detects Docker via Dockerfile", () => {
    expect(detectHostFromTopLevel(["Dockerfile"])).toBe("docker");
  });

  it("prefers docker-compose over Dockerfile when both present", () => {
    expect(detectHostFromTopLevel(["Dockerfile", "docker-compose.yml"])).toBe("docker_compose");
  });

  it("prefers Kubernetes over Dockerfile when both present", () => {
    expect(detectHostFromTopLevel(["Dockerfile", "k8s/"])).toBe("kubernetes");
  });

  it("falls back to null when nothing matches", () => {
    expect(detectHostFromTopLevel(["package.json", "tsconfig.json"])).toBeNull();
  });

  it("Vercel still wins over every other marker (S3 contract)", () => {
    expect(
      detectHostFromTopLevel([
        "vercel.json",
        "Dockerfile",
        "netlify.toml",
        "fly.toml",
      ]),
    ).toBe("vercel");
  });
});

describe("buildFrameworkSnippets", () => {
  const FAKE_DSN = "https://iwk_pub_v1_test@app.test/capture/proj-x";

  it("Next.js snippet wraps next.config + writes instrumentation + .env.local", () => {
    const snippet = buildFrameworkSnippets("next", FAKE_DSN);
    expect(snippet.id).toBe("next");
    expect(snippet.steps).toHaveLength(4);
    const patches = snippet.steps.filter((s) => s.kind === "patch");
    expect(patches.map((p) => p.kind === "patch" && p.file)).toEqual([
      "next.config.ts",
      "instrumentation.ts",
    ]);
    const env = snippet.steps.find((s) => s.kind === "env");
    expect(env && env.kind === "env" ? env.body : null).toBe(
      `INARIWATCH_DSN=${FAKE_DSN}`,
    );
  });

  it("Express snippet uses .env (not .env.local) per Node convention", () => {
    const snippet = buildFrameworkSnippets("express", FAKE_DSN);
    const env = snippet.steps.find((s) => s.kind === "env");
    expect(env && env.kind === "env" ? env.file : null).toBe(".env");
  });

  it("Vite snippet patches src/main.tsx", () => {
    const snippet = buildFrameworkSnippets("vite", FAKE_DSN);
    const patch = snippet.steps.find((s) => s.kind === "patch");
    expect(patch && patch.kind === "patch" ? patch.file : null).toBe("src/main.tsx");
  });

  it("Other framework still produces npm install + import + env step", () => {
    const snippet = buildFrameworkSnippets("other", FAKE_DSN);
    const kinds = snippet.steps.map((s) => s.kind);
    expect(kinds).toContain("shell");
    expect(kinds).toContain("env");
  });

  it("DSN substitutes verbatim into env step body", () => {
    for (const framework of ["next", "express", "vite", "other"] as FrameworkId[]) {
      const snippet = buildFrameworkSnippets(framework, FAKE_DSN);
      const env = snippet.steps.find((s) => s.kind === "env");
      const body = env && env.kind === "env" ? env.body : "";
      expect(body.includes(FAKE_DSN)).toBe(true);
    }
  });
});

describe("HOSTS + HOST_TIERS lookup integrity", () => {
  it("every HOSTS key matches its meta.id (no rename drift)", () => {
    for (const [key, meta] of Object.entries(HOSTS)) {
      expect(meta.id).toBe(key);
    }
  });

  it("HOST_TIERS partitions all host ids exactly once", () => {
    const seen = new Set<HostId>();
    for (const tier of [1, 2, 3] as const) {
      for (const id of HOST_TIERS[tier]) {
        expect(seen.has(id), `${id} listed twice`).toBe(false);
        seen.add(id);
        expect(HOSTS[id].tier).toBe(tier);
      }
    }
    expect(seen.size).toBe(Object.keys(HOSTS).length);
  });

  it("getHostMeta returns null for unknown ids", () => {
    expect(getHostMeta(null)).toBeNull();
    expect(getHostMeta(undefined)).toBeNull();
    expect(getHostMeta("does-not-exist")).toBeNull();
  });

  it("Tier 1 contains only Vercel — guards against accidental tier promotion", () => {
    expect(HOST_TIERS[1]).toEqual(["vercel"]);
  });

  it("every Tier 2 host has a dashboardUrl deeplink", () => {
    for (const id of HOST_TIERS[2]) {
      expect(HOSTS[id].dashboardUrl, `${id} missing dashboardUrl`).toBeTruthy();
    }
  });

  it("Tier 3 hosts intentionally omit dashboardUrl", () => {
    for (const id of HOST_TIERS[3]) {
      expect(HOSTS[id].dashboardUrl).toBeUndefined();
    }
  });
});
