// Tests for the recursive tool-schema sanitizer used by the OpenAI/
// Together-compat path. Pins behavior so we don't drift back to
// whack-a-mole patches every time a new tool surfaces a new violation.

import { describe, expect, it } from "vitest";
import {
  makeToolNameSanitizer,
  sanitizeToolSchemaForStrict,
} from "../providers/_openai-compat-shared";

describe("sanitizeToolSchemaForStrict", () => {
  it("injects items: {} on a property array missing items", () => {
    // Reproduces the live `comm.send_slack` / `blocks` 400 from Together:
    //   `Invalid schema for function 'comm-send_slack':
    //    In context=('properties', 'blocks'), array schema missing items.`
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      properties: {
        blocks: { type: "array", maxItems: 50 },
      },
      required: ["blocks"],
    });

    const blocks = (schema.properties as Record<string, unknown>).blocks as Record<
      string,
      unknown
    >;
    expect(blocks.type).toBe("array");
    expect(blocks.items).toEqual({});
    expect(blocks).not.toHaveProperty("maxItems");
  });

  it("preserves explicit items on arrays and recurses into them", () => {
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string", pattern: "^x" } },
      },
    });
    const args = (schema.properties as Record<string, unknown>).args as Record<
      string,
      unknown
    >;
    expect(args.items).toEqual({ type: "string" }); // pattern stripped recursively
  });

  it("strips nested oneOf/allOf/not but preserves nested anyOf and enum", () => {
    // `comm.send_telegram::chat_id` had a nested oneOf — landmine before this fix.
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      properties: {
        chat_id: { oneOf: [{ type: "string" }, { type: "integer" }] },
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
        mode: { type: "string", enum: ["A", "B"] },
        bad: { allOf: [{ type: "string" }] },
        worse: { not: { type: "boolean" } },
      },
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.chat_id).not.toHaveProperty("oneOf");
    expect(props.bad).not.toHaveProperty("allOf");
    expect(props.worse).not.toHaveProperty("not");
    expect(props.nullable.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(props.mode).toEqual({ type: "string", enum: ["A", "B"] });
  });

  it("strips top-level oneOf/anyOf/allOf/not/enum and defaults type to object", () => {
    // Reproduces the 0ce8dd93 fix at root level (slack_schema's top-level anyOf).
    const schema = sanitizeToolSchemaForStrict({
      anyOf: [{ required: ["text"] }, { required: ["blocks"] }],
      properties: {
        text: { type: "string" },
        blocks: { type: "array", items: { type: "object" } },
      },
    });
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema.type).toBe("object");
  });

  it("strips unsupported validation keywords at every depth", () => {
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      properties: {
        s: { type: "string", pattern: "^x", minLength: 1, maxLength: 9, format: "email" },
        n: { type: "number", minimum: 0, maximum: 100, multipleOf: 5 },
        a: {
          type: "array",
          items: { type: "string", pattern: "^x", maxLength: 4 },
          uniqueItems: true,
          minItems: 1,
          maxItems: 9,
        },
      },
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.s).toEqual({ type: "string" });
    expect(props.n).toEqual({ type: "number" });
    expect(props.a).toEqual({ type: "array", items: { type: "string" } });
  });

  it("degrades tuple-form items: [...] to anyOf and drops prefixItems", () => {
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      properties: {
        pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
        legacy: { type: "array", prefixItems: [{ type: "string" }] },
      },
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.pair.items).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(props.legacy).not.toHaveProperty("prefixItems");
    expect(props.legacy.items).toEqual({});
  });

  it("strips schema metadata ($schema, $id, $ref, title, default, examples)", () => {
    const schema = sanitizeToolSchemaForStrict({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "tool",
      title: "MyTool",
      type: "object",
      properties: {
        a: { type: "string", default: "x", examples: ["y"], title: "A" },
        b: { $ref: "#/$defs/Foo" },
      },
    });
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("$id");
    expect(schema).not.toHaveProperty("title");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.a).toEqual({ type: "string" });
    expect(props.b).toEqual({});
  });

  it("recurses into additionalProperties and patternProperties when they are schemas", () => {
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      additionalProperties: { type: "string", pattern: "^z" },
      patternProperties: {
        "^x_": { type: "string", maxLength: 4 },
      },
    });
    expect(schema.additionalProperties).toEqual({ type: "string" });
    expect(schema.patternProperties).toEqual({
      "^x_": { type: "string" },
    });
  });

  it("preserves boolean additionalProperties without recursion", () => {
    const schema = sanitizeToolSchemaForStrict({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    });
    expect(schema.additionalProperties).toBe(false);
  });

  it("end-to-end fixture: live comm.send_slack schema produces a strict-valid result", () => {
    const slack = sanitizeToolSchemaForStrict({
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: {
        channel: {
          type: "string",
          pattern: "^[#@C][A-Za-z0-9._-]+$|^[A-Z][A-Z0-9]+$",
        },
        text: { type: "string", maxLength: 40000 },
        blocks: {
          type: "array",
          items: { type: "object" },
          maxItems: 50,
          description: "Slack Block Kit blocks",
        },
      },
      anyOf: [{ required: ["text"] }, { required: ["blocks"] }],
    });

    expect(slack).not.toHaveProperty("anyOf");
    expect(slack.type).toBe("object");
    expect(slack.additionalProperties).toBe(false);
    expect(slack.required).toEqual(["channel"]);
    const props = slack.properties as Record<string, Record<string, unknown>>;
    expect(props.channel).toEqual({ type: "string" });
    expect(props.text).toEqual({ type: "string" });
    expect(props.blocks).toEqual({
      type: "array",
      items: { type: "object" },
      description: "Slack Block Kit blocks",
    });
  });
});

describe("makeToolNameSanitizer", () => {
  it("dots → hyphens on outbound, restored on inbound", () => {
    const { sanitize, restore } = makeToolNameSanitizer();
    const safe = sanitize("comm.send_slack");
    expect(safe).toBe("comm-send_slack");
    expect(restore(safe)).toBe("comm.send_slack");
  });

  it("only maps when sanitization actually changed the string", () => {
    const { sanitize, restore } = makeToolNameSanitizer();
    const safe = sanitize("plain_name");
    expect(safe).toBe("plain_name");
    expect(restore(safe)).toBe("plain_name");
  });

  it("strips arbitrary disallowed characters defensively (`$`, `:`, etc.)", () => {
    const { sanitize, restore } = makeToolNameSanitizer();
    expect(sanitize("ns$thing:name")).toBe("ns-thing-name");
    expect(restore("ns-thing-name")).toBe("ns$thing:name");
  });

  it("instances are independent — reverse maps don't leak across calls", () => {
    const a = makeToolNameSanitizer();
    const b = makeToolNameSanitizer();
    a.sanitize("ns.one");
    expect(b.restore("ns-one")).toBe("ns-one"); // b never saw it
  });
});
