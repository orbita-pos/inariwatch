/**
 * Tests for buildAlertBlocks — focused on the VAR Q1 addition: FullTrace
 * deep-link button when alert.sessionId is present.
 *
 * The pre-VAR behaviour (Fix It / Acknowledge / Resolve buttons + section
 * blocks) is exercised indirectly: every test asserts those still appear
 * untouched alongside the new button.
 */

import { describe, it, expect } from "vitest";
import { buildAlertBlocks } from "../blocks";

const baseAlert = {
  id: "alert-uuid-1",
  title: "TypeError: undefined is not a function",
  body: "  at processCheckout (checkout.tsx:42)",
  severity: "critical",
  sourceIntegrations: ["capture"],
};

function actionButtons(blocks: ReturnType<typeof buildAlertBlocks>["blocks"]) {
  const actionsBlock = blocks.find((b) => b.type === "actions");
  if (!actionsBlock || actionsBlock.type !== "actions") return [];
  return actionsBlock.elements as Array<{ text: { text: string }; url?: string; action_id?: string; value?: string }>;
}

describe("buildAlertBlocks — FullTrace button", () => {
  it("does NOT add FullTrace button when sessionId is absent (legacy alerts)", () => {
    const { blocks } = buildAlertBlocks(baseAlert, "Demo Project", null);
    const buttons = actionButtons(blocks);
    expect(buttons.map((b) => b.text.text)).toEqual(["Fix It", "Acknowledge", "Resolve"]);
    expect(buttons.find((b) => b.url)).toBeUndefined();
  });

  it("does NOT add FullTrace button when sessionId is null", () => {
    const { blocks } = buildAlertBlocks(
      { ...baseAlert, sessionId: null },
      "Demo Project",
      null,
    );
    const buttons = actionButtons(blocks);
    expect(buttons).toHaveLength(3);
  });

  it("appends FullTrace button when sessionId is present", () => {
    const { blocks } = buildAlertBlocks(
      { ...baseAlert, sessionId: "abc12345" },
      "Demo Project",
      null,
      "https://app.example.com",
    );
    const buttons = actionButtons(blocks);
    expect(buttons).toHaveLength(4);
    const ftButton = buttons[3];
    expect(ftButton.text.text).toBe("FullTrace ↗");
    expect(ftButton.url).toBe("https://app.example.com/sessions/abc12345");
    // It's a url-button, not an action-callback button — Slack opens
    // it directly in the browser without hitting our interactions endpoint.
    expect(ftButton.action_id).toBeUndefined();
    expect(ftButton.value).toBeUndefined();
  });

  it("falls back to APP_URL env when appUrl arg is omitted", () => {
    const original = process.env.APP_URL;
    process.env.APP_URL = "https://env.example.com";
    try {
      const { blocks } = buildAlertBlocks(
        { ...baseAlert, sessionId: "id-1234" },
        "Demo Project",
        null,
      );
      const ftButton = actionButtons(blocks).find((b) => b.url);
      expect(ftButton?.url).toBe("https://env.example.com/sessions/id-1234");
    } finally {
      if (original === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = original;
    }
  });

  it("strips trailing slash from base URL to avoid // in deep link", () => {
    const { blocks } = buildAlertBlocks(
      { ...baseAlert, sessionId: "id-x" },
      "Demo Project",
      null,
      "https://app.example.com/", // trailing slash
    );
    const ftButton = actionButtons(blocks).find((b) => b.url);
    expect(ftButton?.url).toBe("https://app.example.com/sessions/id-x");
  });

  it("URL-encodes the session id (safe against weird characters)", () => {
    const { blocks } = buildAlertBlocks(
      { ...baseAlert, sessionId: "weird id with spaces" },
      "Demo Project",
      null,
      "https://app.example.com",
    );
    const ftButton = actionButtons(blocks).find((b) => b.url);
    expect(ftButton?.url).toBe("https://app.example.com/sessions/weird%20id%20with%20spaces");
  });

  it("preserves existing 3 buttons in their original order + style", () => {
    const { blocks } = buildAlertBlocks(
      { ...baseAlert, sessionId: "any" },
      "Demo Project",
      null,
      "https://app.example.com",
    );
    const buttons = actionButtons(blocks);
    expect(buttons[0]).toMatchObject({ text: { text: "Fix It" }, action_id: "fix_alert" });
    expect(buttons[1]).toMatchObject({ text: { text: "Acknowledge" }, action_id: "ack_alert" });
    expect(buttons[2]).toMatchObject({ text: { text: "Resolve" }, action_id: "resolve_alert" });
  });
});
