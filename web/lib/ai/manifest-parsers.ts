/**
 * Pure manifest parsers — extract dependency lists from each language's
 * dependency manifest file. No I/O, no database, no GitHub API — callers
 * pass raw file contents.
 *
 * Used by context-gatherer.ts (which handles the HTTP reads) and tested
 * directly via manifest-parsers.test.ts fixture strings.
 */

export type ProjectLanguage = "ts" | "js" | "python" | "go" | "rust" | "java" | "ruby" | "unknown";

export interface ProjectDeps {
  /** Detected primary language from manifest file found. */
  language: ProjectLanguage;
  /** Flat list of dependency/library names found in the manifest. */
  deps: string[];
  /** Which manifest file the deps came from. */
  source: string | null;
}

export function parsePackageJson(raw: string): ProjectDeps | null {
  try {
    const pkg = JSON.parse(raw);
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const hasTs = deps.includes("typescript") || deps.includes("@types/node");
    return { language: hasTs ? "ts" : "js", deps, source: "package.json" };
  } catch {
    return null;
  }
}

export function parsePyprojectToml(raw: string): ProjectDeps | null {
  const deps: string[] = [];
  // PEP 621: [project] dependencies = ["django>=4", "flask"]
  const projDepsMatch = raw.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (projDepsMatch) {
    for (const m of projDepsMatch[1].matchAll(/["']([a-zA-Z0-9_.\-]+)/g)) {
      deps.push(m[1].toLowerCase());
    }
  }
  // Poetry: [tool.poetry.dependencies] django = "^4.0"
  const poetryBlock = raw.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (poetryBlock) {
    for (const m of poetryBlock[1].matchAll(/^\s*([a-zA-Z0-9_.\-]+)\s*=/gm)) {
      if (m[1] !== "python") deps.push(m[1].toLowerCase());
    }
  }
  return deps.length > 0 ? { language: "python", deps, source: "pyproject.toml" } : null;
}

export function parseRequirementsTxt(raw: string): ProjectDeps | null {
  const deps: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
    const name = trimmed.split(/[=<>!~\s]/)[0];
    if (name) deps.push(name.toLowerCase());
  }
  return deps.length > 0 ? { language: "python", deps, source: "requirements.txt" } : null;
}

export function parseCargoToml(raw: string): ProjectDeps | null {
  const deps: string[] = [];
  // [dependencies] ... [dev-dependencies] ... [build-dependencies]
  // Uses lookahead for the section boundary so the next `[` isn't consumed
  // and the regex walker can match consecutive sections.
  const sections = raw.matchAll(/\[(?:dev-|build-)?dependencies(?:\.[a-zA-Z0-9_-]+)?\]([\s\S]*?)(?=\n\[|$)/g);
  for (const section of sections) {
    for (const m of section[1].matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=/gm)) {
      deps.push(m[1]);
    }
  }
  return deps.length > 0 ? { language: "rust", deps, source: "Cargo.toml" } : null;
}

export function parseGoMod(raw: string): ProjectDeps | null {
  const deps: string[] = [];
  // require ( ... ) block or individual `require foo/bar v1.2.3` lines
  const requireBlock = raw.match(/require\s*\(([\s\S]*?)\)/);
  if (requireBlock) {
    for (const m of requireBlock[1].matchAll(/^\s*([^\s]+)\s+v/gm)) {
      deps.push(m[1]);
    }
  }
  for (const m of raw.matchAll(/^require\s+([^\s]+)\s+v/gm)) {
    deps.push(m[1]);
  }
  return deps.length > 0 ? { language: "go", deps, source: "go.mod" } : null;
}

export function parsePomXml(raw: string): ProjectDeps | null {
  const deps: string[] = [];
  for (const m of raw.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
    deps.push(m[1]);
  }
  return deps.length > 0 ? { language: "java", deps, source: "pom.xml" } : null;
}

export function parseBuildGradle(raw: string, source = "build.gradle"): ProjectDeps | null {
  const deps: string[] = [];
  // implementation 'org.springframework.boot:spring-boot-starter-web:3.0.0'
  for (const m of raw.matchAll(/(?:implementation|api|testImplementation|compileOnly)\s*\(?\s*['"]([^:'"]+):([^:'"]+)/g)) {
    deps.push(m[2]); // artifactId
  }
  return deps.length > 0 ? { language: "java", deps, source } : null;
}

export function parseGemfile(raw: string): ProjectDeps | null {
  const deps: string[] = [];
  for (const m of raw.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) {
    deps.push(m[1]);
  }
  return deps.length > 0 ? { language: "ruby", deps, source: "Gemfile" } : null;
}
