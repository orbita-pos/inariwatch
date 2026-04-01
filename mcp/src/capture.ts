import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export type ProjectType = "nextjs" | "node" | "unknown";

export type ProjectInfo = {
  type: ProjectType;
  hasCapture: boolean;
  packageManager: "npm" | "yarn" | "pnpm" | "bun";
};

export function detectProject(cwd: string = process.cwd()): ProjectInfo | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> || {}),
    ...(pkg.devDependencies as Record<string, string> || {}),
  };

  const hasCapture = "@inariwatch/capture" in deps;

  // Detect framework
  let type: ProjectType = "node";
  if ("next" in deps) type = "nextjs";

  // Detect package manager
  let packageManager: ProjectInfo["packageManager"] = "npm";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) packageManager = "bun";
  else if (existsSync(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (existsSync(join(cwd, "yarn.lock"))) packageManager = "yarn";

  return { type, hasCapture, packageManager };
}

export function installCapture(project: ProjectInfo, cwd: string = process.cwd()): { ok: boolean; error?: string } {
  if (project.hasCapture) return { ok: true }; // Already installed

  // Install the package
  const installCmd = {
    npm: "npm install @inariwatch/capture",
    yarn: "yarn add @inariwatch/capture",
    pnpm: "pnpm add @inariwatch/capture",
    bun: "bun add @inariwatch/capture",
  }[project.packageManager];

  try {
    execSync(installCmd, { cwd, stdio: "pipe" });
  } catch (e) {
    return { ok: false, error: `Failed to install: ${e instanceof Error ? e.message : "unknown"}` };
  }

  // Framework-specific setup
  if (project.type === "nextjs") {
    return setupNextjs(cwd);
  }

  return { ok: true };
}

function setupNextjs(cwd: string): { ok: boolean; error?: string } {
  // Create instrumentation.ts if it doesn't exist
  const instrumentationPath = join(cwd, "instrumentation.ts");
  if (!existsSync(instrumentationPath)) {
    writeFileSync(
      instrumentationPath,
      `import "@inariwatch/capture/auto"\nimport { captureRequestError } from "@inariwatch/capture"\nexport const onRequestError = captureRequestError\n`
    );
  }

  // Wrap next.config — detect .ts, .mjs, .js
  const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"];
  for (const file of configFiles) {
    const configPath = join(cwd, file);
    if (!existsSync(configPath)) continue;

    const content = readFileSync(configPath, "utf8");
    if (content.includes("withInariWatch")) break; // Already wrapped

    // Add import and wrap
    const isTs = file.endsWith(".ts");
    const isMjs = file.endsWith(".mjs");

    if (isTs || isMjs) {
      // ESM: add import at top, wrap default export
      const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`;

      if (content.includes("export default")) {
        // Wrap: export default X → export default withInariWatch(X)
        const wrapped = importLine + content.replace(
          /export default (.+)/,
          (_, exported) => {
            // Handle multiline: export default { ... } or export default nextConfig
            const trimmed = exported.trim();
            if (trimmed.endsWith(";")) {
              return `export default withInariWatch(${trimmed.slice(0, -1)});`;
            }
            return `export default withInariWatch(${trimmed})`;
          }
        );
        writeFileSync(configPath, wrapped);
      }
    } else {
      // CJS: add require, wrap module.exports
      const requireLine = `const { withInariWatch } = require("@inariwatch/capture/next")\n`;
      if (content.includes("module.exports")) {
        const wrapped = requireLine + content.replace(
          /module\.exports\s*=\s*/,
          "module.exports = withInariWatch("
        ) + ")";
        writeFileSync(configPath, wrapped);
      }
    }
    break;
  }

  return { ok: true };
}
