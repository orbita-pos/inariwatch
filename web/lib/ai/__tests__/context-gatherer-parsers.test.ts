/**
 * Tests for the pure manifest parsers exported from context-gatherer.ts.
 *
 * These validate that each language's dependency manifest format is parsed
 * correctly — the critical contract between real-world user repos and
 * `getStackInstructions()` which feeds AI remediation prompts.
 */

import { describe, it, expect } from "vitest";
import {
  parsePackageJson,
  parsePyprojectToml,
  parseRequirementsTxt,
  parseCargoToml,
  parseGoMod,
  parsePomXml,
  parseBuildGradle,
  parseGemfile,
} from "../manifest-parsers";

describe("parsePackageJson", () => {
  it("extracts deps and devDeps", () => {
    const raw = JSON.stringify({
      name: "example",
      dependencies: { next: "^15.0.0", react: "^19.0.0", "@prisma/client": "^6.0.0" },
      devDependencies: { typescript: "^5.5.0", "@types/node": "^25.0.0" },
    });
    const result = parsePackageJson(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("ts");
    expect(result!.source).toBe("package.json");
    expect(result!.deps).toContain("next");
    expect(result!.deps).toContain("react");
    expect(result!.deps).toContain("@prisma/client");
    expect(result!.deps).toContain("typescript");
  });

  it("returns js when no typescript present", () => {
    const raw = JSON.stringify({ dependencies: { express: "^4.0.0" } });
    const result = parsePackageJson(raw);
    expect(result!.language).toBe("js");
    expect(result!.deps).toEqual(["express"]);
  });

  it("returns null on invalid JSON", () => {
    expect(parsePackageJson("not json")).toBeNull();
  });

  it("handles empty manifest", () => {
    const result = parsePackageJson("{}");
    expect(result).not.toBeNull();
    expect(result!.deps).toEqual([]);
  });
});

describe("parsePyprojectToml", () => {
  it("parses PEP 621 style dependencies", () => {
    const raw = `
[project]
name = "example"
version = "0.1.0"
dependencies = [
  "django>=4.2",
  "flask==2.3.0",
  "requests",
]
`;
    const result = parsePyprojectToml(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("python");
    expect(result!.source).toBe("pyproject.toml");
    expect(result!.deps).toEqual(expect.arrayContaining(["django", "flask", "requests"]));
  });

  it("parses Poetry-style dependencies", () => {
    const raw = `
[tool.poetry]
name = "example"

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.110"
sqlalchemy = { version = "^2.0", extras = ["asyncio"] }
pydantic = "^2.5"

[tool.poetry.dev-dependencies]
pytest = "^7.0"
`;
    const result = parsePyprojectToml(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("python");
    expect(result!.deps).toEqual(expect.arrayContaining(["fastapi", "sqlalchemy", "pydantic"]));
    expect(result!.deps).not.toContain("python"); // explicitly excluded
  });

  it("returns null for empty toml", () => {
    expect(parsePyprojectToml("")).toBeNull();
  });
});

describe("parseRequirementsTxt", () => {
  it("parses typical requirements", () => {
    const raw = `
# Core
Django==4.2.7
flask>=2.3.0
requests

# Dev
pytest~=7.0
`;
    const result = parseRequirementsTxt(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("python");
    expect(result!.source).toBe("requirements.txt");
    expect(result!.deps).toEqual(expect.arrayContaining(["django", "flask", "requests", "pytest"]));
  });

  it("skips comments and flags", () => {
    const raw = `
# comment
-r other.txt
--index-url https://example.com
numpy
`;
    const result = parseRequirementsTxt(raw);
    expect(result!.deps).toEqual(["numpy"]);
  });

  it("returns null for empty file", () => {
    expect(parseRequirementsTxt("")).toBeNull();
  });
});

describe("parseCargoToml", () => {
  it("parses dependencies, dev-dependencies, build-dependencies", () => {
    const raw = `
[package]
name = "example"
version = "0.1.0"

[dependencies]
axum = "0.7"
sqlx = { version = "0.7", features = ["postgres"] }
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
mockall = "0.12"

[build-dependencies]
cc = "1.0"
`;
    const result = parseCargoToml(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("rust");
    expect(result!.source).toBe("Cargo.toml");
    expect(result!.deps).toEqual(expect.arrayContaining(["axum", "sqlx", "tokio", "mockall", "cc"]));
  });

  it("returns null for empty toml", () => {
    expect(parseCargoToml("")).toBeNull();
  });
});

describe("parseGoMod", () => {
  it("parses require block", () => {
    const raw = `
module github.com/example/app

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/jmoiron/sqlx v1.3.5
	gorm.io/gorm v1.25.5
)
`;
    const result = parseGoMod(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("go");
    expect(result!.source).toBe("go.mod");
    expect(result!.deps).toEqual(
      expect.arrayContaining([
        "github.com/gin-gonic/gin",
        "github.com/jmoiron/sqlx",
        "gorm.io/gorm",
      ]),
    );
  });

  it("parses individual require lines", () => {
    const raw = `
module github.com/example/app
go 1.21
require github.com/stretchr/testify v1.8.4
`;
    const result = parseGoMod(raw);
    expect(result!.deps).toContain("github.com/stretchr/testify");
  });

  it("returns null for empty file", () => {
    expect(parseGoMod("")).toBeNull();
  });
});

describe("parsePomXml", () => {
  it("parses artifactIds", () => {
    const raw = `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>org.hibernate</groupId>
      <artifactId>hibernate-core</artifactId>
    </dependency>
  </dependencies>
</project>
`;
    const result = parsePomXml(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("java");
    expect(result!.source).toBe("pom.xml");
    expect(result!.deps).toEqual(expect.arrayContaining(["spring-boot-starter-web", "hibernate-core"]));
  });

  it("returns null for empty pom", () => {
    expect(parsePomXml("<project></project>")).toBeNull();
  });
});

describe("parseBuildGradle", () => {
  it("parses Groovy gradle dependencies", () => {
    const raw = `
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'
    implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'
    api 'com.fasterxml.jackson.core:jackson-databind'
}
`;
    const result = parseBuildGradle(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("java");
    expect(result!.source).toBe("build.gradle");
    expect(result!.deps).toEqual(
      expect.arrayContaining([
        "spring-boot-starter-web",
        "spring-boot-starter-data-jpa",
        "junit-jupiter",
        "jackson-databind",
      ]),
    );
  });

  it("uses custom source name for kts flavor", () => {
    const raw = `dependencies { implementation("org.example:foo:1.0") }`;
    const result = parseBuildGradle(raw, "build.gradle.kts");
    expect(result!.source).toBe("build.gradle.kts");
    expect(result!.deps).toContain("foo");
  });

  it("returns null for empty file", () => {
    expect(parseBuildGradle("")).toBeNull();
  });
});

describe("parseGemfile", () => {
  it("parses gem entries", () => {
    const raw = `
source 'https://rubygems.org'

ruby '3.2.0'

gem 'rails', '~> 7.1.0'
gem 'pg'
gem 'redis', '>= 5.0'

group :development do
  gem 'rspec-rails'
end
`;
    const result = parseGemfile(raw);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("ruby");
    expect(result!.source).toBe("Gemfile");
    expect(result!.deps).toEqual(expect.arrayContaining(["rails", "pg", "redis", "rspec-rails"]));
  });

  it("returns null for empty Gemfile", () => {
    expect(parseGemfile("")).toBeNull();
  });
});
