/**
 * Tests for the GitHub-repo pure helpers.
 * `resolveActiveGitHubRepo` itself is integration-tested via
 * `slash-dispatch.test.ts` with the IPC stubbed at the dispatcher
 * boundary.
 */

import { describe, expect, it } from "vitest";

import {
  detectHost,
  githubSubpath,
  parseGitHubRepo,
} from "../github-repo";

describe("parseGitHubRepo", () => {
  it("parses https URL with .git suffix", () => {
    expect(parseGitHubRepo("https://github.com/orbita-pos/inariwatch.git")).toEqual({
      owner: "orbita-pos",
      name: "inariwatch",
    });
  });

  it("parses https URL without .git suffix", () => {
    expect(parseGitHubRepo("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses http (insecure) URL", () => {
    expect(parseGitHubRepo("http://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses git@host:owner/name.git form", () => {
    expect(parseGitHubRepo("git@github.com:orbita-pos/inariwatch.git")).toEqual({
      owner: "orbita-pos",
      name: "inariwatch",
    });
  });

  it("parses ssh://git@host/owner/name.git form", () => {
    expect(parseGitHubRepo("ssh://git@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses git://host/owner/name form", () => {
    expect(parseGitHubRepo("git://github.com/owner/repo")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGitHubRepo("  https://github.com/owner/repo.git  ")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseGitHubRepo("https://github.com/owner/repo/")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("returns null for non-github hosts", () => {
    expect(parseGitHubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGitHubRepo("git@bitbucket.org:owner/repo.git")).toBeNull();
    expect(parseGitHubRepo("https://gitea.example.com/owner/repo")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseGitHubRepo("")).toBeNull();
    expect(parseGitHubRepo("not a url")).toBeNull();
    expect(parseGitHubRepo("https://github.com/")).toBeNull();
    expect(parseGitHubRepo("https://github.com/onlyowner")).toBeNull();
  });
});

describe("detectHost", () => {
  it("extracts host from https URLs", () => {
    expect(detectHost("https://gitlab.com/owner/repo")).toBe("gitlab.com");
    expect(detectHost("http://example.com:8080/x")).toBe("example.com:8080");
  });

  it("extracts host from git URLs", () => {
    expect(detectHost("git://gitea.dev/x/y")).toBe("gitea.dev");
  });

  it("extracts host from ssh shorthand", () => {
    expect(detectHost("git@bitbucket.org:owner/repo.git")).toBe("bitbucket.org");
  });

  it("extracts host from ssh:// URLs", () => {
    expect(detectHost("ssh://git@codeberg.org/owner/repo")).toBe("codeberg.org");
  });

  it("returns null for unparseable input", () => {
    expect(detectHost("just a string")).toBeNull();
    expect(detectHost("")).toBeNull();
  });
});

describe("githubSubpath", () => {
  it("returns empty string for bare command", () => {
    expect(githubSubpath("")).toBe("");
    expect(githubSubpath("   ")).toBe("");
  });

  it("maps prs and pulls to /pulls", () => {
    expect(githubSubpath("prs")).toBe("/pulls");
    expect(githubSubpath("pulls")).toBe("/pulls");
  });

  it("maps issues to /issues", () => {
    expect(githubSubpath("issues")).toBe("/issues");
  });

  it("maps actions to /actions", () => {
    expect(githubSubpath("actions")).toBe("/actions");
  });

  it("maps releases to /releases", () => {
    expect(githubSubpath("releases")).toBe("/releases");
  });

  it("is case-insensitive", () => {
    expect(githubSubpath("PRs")).toBe("/pulls");
    expect(githubSubpath("Issues")).toBe("/issues");
  });

  it("returns null for unknown subcommand", () => {
    expect(githubSubpath("unknown")).toBeNull();
    expect(githubSubpath("foo bar")).toBeNull();
    expect(githubSubpath("123")).toBeNull();
  });
});
