/**
 * Tests for getStackInstructions — validates that each framework dep name
 * triggers the correct instruction string. Covers the Phase 1 expansion
 * that added Python, Go, Rust, Java, Ruby, and meta-frameworks.
 */

import { describe, it, expect } from "vitest";
import { getStackInstructions } from "../prompts";

describe("getStackInstructions — JavaScript/TypeScript frameworks", () => {
  it.each([
    ["next", "Next.js (App Router)"],
    ["nuxt", "Nuxt 3"],
    ["@remix-run/react", "Remix"],
    ["@sveltejs/kit", "SvelteKit"],
    ["astro", "Astro"],
    ["vite", "Vite"],
    ["express", "Express"],
    ["fastify", "Fastify"],
    ["hono", "Hono"],
    ["koa", "Koa"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });
});

describe("getStackInstructions — Node ORMs", () => {
  it.each([
    ["drizzle-orm", "Drizzle"],
    ["@prisma/client", "Prisma"],
    ["typeorm", "TypeORM"],
    ["sequelize", "Sequelize"],
    ["knex", "Knex"],
    ["mongoose", "MongoDB/Mongoose"],
    ["@neondatabase/serverless", "Neon serverless"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });
});

describe("getStackInstructions — Python frameworks", () => {
  it.each([
    ["django", "Django"],
    ["Django", "Django"],
    ["flask", "Flask"],
    ["fastapi", "FastAPI"],
    ["FastAPI", "FastAPI"],
    ["sqlalchemy", "SQLAlchemy"],
    ["pydantic", "Pydantic"],
    ["starlette", "Starlette"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });

  it("includes raw-SQL warning for Django", () => {
    const out = getStackInstructions(["django"]);
    expect(out.toLowerCase()).toContain(".raw()");
  });

  it("includes Pydantic guidance for FastAPI", () => {
    const out = getStackInstructions(["fastapi"]);
    expect(out).toContain("Pydantic");
  });
});

describe("getStackInstructions — Go frameworks", () => {
  it.each([
    ["github.com/gin-gonic/gin", "Gin"],
    ["gin-gonic/gin", "Gin"],
    ["github.com/labstack/echo", "Echo"],
    ["github.com/gofiber/fiber", "Fiber"],
    ["gorm.io/gorm", "GORM"],
    ["gorm", "GORM"],
    ["github.com/jmoiron/sqlx", "sqlx"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });

  it("warns against fmt.Sprintf for GORM", () => {
    const out = getStackInstructions(["gorm"]);
    expect(out).toContain("fmt.Sprintf");
  });
});

describe("getStackInstructions — Rust frameworks", () => {
  it.each([
    ["axum", "Axum"],
    ["actix-web", "Actix Web"],
    ["rocket", "Rocket"],
    ["sqlx", "sqlx"],
    ["diesel", "Diesel"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });

  it("recommends query! macro for sqlx (Rust)", () => {
    const out = getStackInstructions(["sqlx"]);
    // Both the Rust sqlx and the Go sqlx match the bare name; Rust entry
    // adds the query!() macro guidance which the Go one doesn't.
    expect(out).toContain("query!");
  });
});

describe("getStackInstructions — Java/Kotlin frameworks", () => {
  it.each([
    ["spring-boot-starter-web", "Spring Boot"],
    ["org.springframework.boot", "Spring Boot"],
    ["spring-data-jpa", "Spring Data JPA"],
    ["jpa", "Spring Data JPA"],
    ["hibernate", "Hibernate"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });
});

describe("getStackInstructions — Ruby frameworks", () => {
  it.each([
    ["rails", "Ruby on Rails"],
    ["actionpack", "Ruby on Rails"],
    ["sinatra", "Sinatra"],
  ])("detects %s and mentions %s", (dep, expected) => {
    expect(getStackInstructions([dep])).toContain(expected);
  });
});

describe("getStackInstructions — composite detection", () => {
  it("includes multiple instructions when multiple deps match", () => {
    const out = getStackInstructions(["next", "drizzle-orm", "@neondatabase/serverless"]);
    expect(out).toContain("Next.js");
    expect(out).toContain("Drizzle");
    expect(out).toContain("Neon serverless");
  });

  it("returns empty string when no deps match", () => {
    expect(getStackInstructions([])).toBe("");
    expect(getStackInstructions(["unknown-lib-xyz"])).toBe("");
  });

  it("handles mixed-language deps (Python + Go in same list)", () => {
    // This shouldn't happen in practice but the function must not crash.
    const out = getStackInstructions(["django", "gorm"]);
    expect(out).toContain("Django");
    expect(out).toContain("GORM");
  });
});
