import { describe, expect, it } from "vitest";
import {
  inferLanguage,
  extractErrorLineForFile,
  extractASTContext,
} from "../ast-extractor";

// ── Pure helpers (sync, no WASM) ─────────────────────────────────────────────

describe("inferLanguage", () => {
  it("maps TS/TSX/JS/JSX extensions", () => {
    expect(inferLanguage("handler.ts")).toBe("typescript");
    expect(inferLanguage("App.tsx")).toBe("tsx");
    expect(inferLanguage("util.js")).toBe("javascript");
    expect(inferLanguage("util.mjs")).toBe("javascript");
    expect(inferLanguage("form.jsx")).toBe("jsx");
    expect(inferLanguage("style.css")).toBeNull();
    expect(inferLanguage("schema.py")).toBeNull();
  });
});

describe("extractErrorLineForFile", () => {
  it("extracts line number from Node.js stack trace", () => {
    const trace = [
      "TypeError: Cannot read properties of null (reading 'id')",
      "    at processWebhook (src/webhooks/handler.ts:42:15)",
      "    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)",
    ].join("\n");
    expect(extractErrorLineForFile(trace, "src/webhooks/handler.ts")).toBe(42);
  });

  it("returns null when file not in stack trace", () => {
    const trace = "at foo (src/other.ts:10:5)";
    expect(extractErrorLineForFile(trace, "src/webhooks/handler.ts")).toBeNull();
  });

  it("handles Windows-style backslash separators", () => {
    const trace = "at bar (src\\lib\\utils.ts:7:1)";
    expect(extractErrorLineForFile(trace, "src/lib/utils.ts")).toBe(7);
  });
});

// ── WASM-backed extraction (async) ───────────────────────────────────────────

describe("extractASTContext", () => {
  it("finds enclosing function declaration", async () => {
    const code = [
      "export async function processWebhook(req: Request): Promise<void> {",
      "  const data = await req.json();",
      "  const id = data.id.toString();",
      "}",
    ].join("\n");

    const ctx = await extractASTContext(code, 3, "typescript");
    expect(ctx).not.toBeNull();
    expect(ctx!.enclosingFunction).toMatch(/processWebhook/);
    expect(ctx!.errorLine).toBe(3);
  }, 15_000);

  it("detects line inside try block as enclosingTryCatch=true", async () => {
    const code = [
      "async function handleRequest() {",
      "  try {",
      "    const result = await db.query(sql);",
      "    return result;",
      "  } catch (err) {",
      "    console.error(err);",
      "  }",
      "}",
    ].join("\n");

    const ctx = await extractASTContext(code, 3, "typescript");
    expect(ctx).not.toBeNull();
    expect(ctx!.enclosingTryCatch).toBe(true);
  }, 15_000);

  it("does NOT set enclosingTryCatch for a line in the catch block", async () => {
    const code = [
      "async function handleRequest() {",
      "  try {",
      "    const result = await db.query(sql);",
      "  } catch (err) {",
      "    console.error(err);",
      "  }",
      "}",
    ].join("\n");

    const ctx = await extractASTContext(code, 5, "typescript");
    expect(ctx).not.toBeNull();
    expect(ctx!.enclosingTryCatch).toBe(false);
  }, 15_000);

  it("extracts call expression on the error line", async () => {
    const code = [
      "function processData(values: unknown[]) {",
      "  const result = db.insert(values);",
      "  return result;",
      "}",
    ].join("\n");

    const ctx = await extractASTContext(code, 2, "typescript");
    expect(ctx).not.toBeNull();
    expect(ctx!.callExpression).toMatch(/db\.insert/);
  }, 15_000);

  it("returns null gracefully on empty content", async () => {
    const ctx = await extractASTContext("", 1, "typescript");
    // Should not throw — returns null or a mostly-empty context
    if (ctx !== null) {
      expect(ctx.enclosingFunction).toBeNull();
    }
  }, 15_000);

  it("detects enclosing class", async () => {
    const code = [
      "class WebhookHandler {",
      "  async handle(req: Request) {",
      "    const body = await req.json();",
      "    return body.id;",
      "  }",
      "}",
    ].join("\n");

    const ctx = await extractASTContext(code, 4, "typescript");
    expect(ctx).not.toBeNull();
    expect(ctx!.enclosingClass).toMatch(/class WebhookHandler/);
    expect(ctx!.enclosingFunction).toMatch(/handle/);
  }, 15_000);
});
