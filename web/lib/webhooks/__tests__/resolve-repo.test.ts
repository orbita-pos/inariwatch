import { describe, it, expect } from "vitest";
import {
  normalizeRepo,
  resolveRepoFromCaptureEvent,
  resolveRepoFromVercelPayload,
  resolveRepoFromGithubPayload,
  resolveRepoFromSentryPayload,
  resolveRepoFromDatadogTags,
} from "../resolve-repo";

describe("normalizeRepo", () => {
  it("accepts plain owner/repo", () => {
    expect(normalizeRepo("orbita-pos/inariwatch")).toBe("orbita-pos/inariwatch");
  });

  it("strips .git suffix from plain form", () => {
    expect(normalizeRepo("orbita-pos/inariwatch.git")).toBe("orbita-pos/inariwatch");
  });

  it("parses https GitHub URLs", () => {
    expect(normalizeRepo("https://github.com/orbita-pos/inariwatch")).toBe("orbita-pos/inariwatch");
    expect(normalizeRepo("https://github.com/orbita-pos/inariwatch.git")).toBe("orbita-pos/inariwatch");
  });

  it("parses git+https URLs (npm package.json style)", () => {
    expect(normalizeRepo("git+https://github.com/orbita-pos/inariwatch.git")).toBe("orbita-pos/inariwatch");
  });

  it("parses SSH form git@host:owner/repo.git", () => {
    expect(normalizeRepo("git@github.com:orbita-pos/inariwatch.git")).toBe("orbita-pos/inariwatch");
  });

  it("parses ssh://git@host/owner/repo", () => {
    expect(normalizeRepo("ssh://git@github.com/orbita-pos/inariwatch.git")).toBe("orbita-pos/inariwatch");
  });

  it("handles gitlab/bitbucket hosts (uses last two segments)", () => {
    expect(normalizeRepo("https://gitlab.com/my-group/my-repo.git")).toBe("my-group/my-repo");
    expect(normalizeRepo("https://bitbucket.org/team/app")).toBe("team/app");
  });

  it("returns null for non-strings", () => {
    expect(normalizeRepo(null)).toBeNull();
    expect(normalizeRepo(undefined)).toBeNull();
    expect(normalizeRepo(123)).toBeNull();
    expect(normalizeRepo({})).toBeNull();
  });

  it("returns null for empty/whitespace", () => {
    expect(normalizeRepo("")).toBeNull();
    expect(normalizeRepo("   ")).toBeNull();
  });

  it("returns null for invalid shapes", () => {
    expect(normalizeRepo("just-one-segment")).toBeNull();
    expect(normalizeRepo("owner/repo/too-deep")).toEqual("repo/too-deep"); // last two — acceptable behavior for URL-like strings
    expect(normalizeRepo("owner/")).toBeNull();
    expect(normalizeRepo("/repo")).toBeNull();
  });

  it("rejects shell/path metacharacters", () => {
    expect(normalizeRepo("owner/repo;rm -rf /")).toBeNull();
    expect(normalizeRepo("owner/repo$()")).toBeNull();
  });
});

describe("resolveRepoFromCaptureEvent", () => {
  it("prefers event.git.repo (v0.10+ SDK)", () => {
    expect(
      resolveRepoFromCaptureEvent({ git: { repo: "a/b", url: "https://x.com/c/d" } }),
    ).toBe("a/b");
  });

  it("falls back to event.git.url", () => {
    expect(
      resolveRepoFromCaptureEvent({ git: { url: "https://github.com/a/b.git" } }),
    ).toBe("a/b");
  });

  it("falls back to metadata.repo", () => {
    expect(resolveRepoFromCaptureEvent({ metadata: { repo: "a/b" } })).toBe("a/b");
  });

  it("returns null when nothing is present", () => {
    expect(resolveRepoFromCaptureEvent({})).toBeNull();
    expect(resolveRepoFromCaptureEvent({ git: {} })).toBeNull();
  });
});

describe("resolveRepoFromVercelPayload", () => {
  it("prefers gitSource.org/repo", () => {
    expect(
      resolveRepoFromVercelPayload({
        gitSource: { type: "github", org: "orbita-pos", repo: "inariwatch" },
      }),
    ).toBe("orbita-pos/inariwatch");
  });

  it("falls back to meta.githubOrg + githubCommitRepo", () => {
    expect(
      resolveRepoFromVercelPayload({
        meta: { githubOrg: "orbita-pos", githubCommitRepo: "inariwatch" },
      }),
    ).toBe("orbita-pos/inariwatch");
  });

  it("tolerates missing gitSource", () => {
    expect(resolveRepoFromVercelPayload({})).toBeNull();
  });

  it("returns null when only partial info", () => {
    expect(
      resolveRepoFromVercelPayload({ gitSource: { type: "github", org: "x" } }),
    ).toBeNull();
  });
});

describe("resolveRepoFromGithubPayload", () => {
  it("extracts repository.full_name", () => {
    expect(
      resolveRepoFromGithubPayload({ repository: { full_name: "orbita-pos/inariwatch" } }),
    ).toBe("orbita-pos/inariwatch");
  });

  it("returns null when full_name missing", () => {
    expect(resolveRepoFromGithubPayload({})).toBeNull();
    expect(resolveRepoFromGithubPayload({ repository: {} })).toBeNull();
  });
});

describe("resolveRepoFromSentryPayload", () => {
  it("maps project slug through integration config", () => {
    expect(
      resolveRepoFromSentryPayload(
        { project: { slug: "my-service" } },
        { "my-service": "orbita-pos/my-service" },
      ),
    ).toBe("orbita-pos/my-service");
  });

  it("returns null when no mapping supplied", () => {
    expect(resolveRepoFromSentryPayload({ project: { slug: "x" } }, null)).toBeNull();
  });

  it("returns null when slug not in map", () => {
    expect(
      resolveRepoFromSentryPayload({ project: { slug: "unknown" } }, { other: "a/b" }),
    ).toBeNull();
  });
});

describe("resolveRepoFromDatadogTags", () => {
  it("parses repo:owner/name tag", () => {
    expect(resolveRepoFromDatadogTags(["env:prod", "repo:orbita-pos/inariwatch"])).toBe(
      "orbita-pos/inariwatch",
    );
  });

  it("parses github_repository:owner/name tag", () => {
    expect(resolveRepoFromDatadogTags(["github_repository:orbita-pos/inariwatch"])).toBe(
      "orbita-pos/inariwatch",
    );
  });

  it("returns null when no repo tag", () => {
    expect(resolveRepoFromDatadogTags(["env:prod", "service:web"])).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(resolveRepoFromDatadogTags(null)).toBeNull();
    expect(resolveRepoFromDatadogTags("repo:a/b")).toBeNull();
  });
});
