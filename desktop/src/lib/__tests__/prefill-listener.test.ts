import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetPrefillStateForTests,
  applyPrefillForTests,
  consumeLastPrefilledAlertId,
} from "@/lib/prefill-listener";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";

beforeEach(() => {
  __resetChatStoreForTests();
  __resetPrefillStateForTests();
});

describe("prefill listener", () => {
  it("stuffs the input value when a payload arrives", () => {
    applyPrefillForTests({ alert_id: "a-1", text: "Fix this stacktrace" });
    expect(useChat.getState().inputValue).toBe("Fix this stacktrace");
  });

  it("flips the dock into conversation mode", () => {
    expect(useChat.getState().mode).toBe("idle");
    applyPrefillForTests({ alert_id: "a-1", text: "Fix it" });
    expect(useChat.getState().mode).toBe("conversation");
  });

  it("makes alert_id available to the next consumer call", () => {
    applyPrefillForTests({ alert_id: "a-7", text: "Investigate" });
    expect(consumeLastPrefilledAlertId()).toBe("a-7");
  });

  it("clears alert_id after one consume call", () => {
    applyPrefillForTests({ alert_id: "a-7", text: "Investigate" });
    expect(consumeLastPrefilledAlertId()).toBe("a-7");
    expect(consumeLastPrefilledAlertId()).toBeNull();
  });

  it("ignores payloads with non-string text", () => {
    // @ts-expect-error — exercising defensive guard
    applyPrefillForTests({ alert_id: "a-1", text: 123 });
    expect(useChat.getState().inputValue).toBe("");
    expect(useChat.getState().mode).toBe("idle");
  });

  it("stamps null on alert_id when payload omits one", () => {
    // @ts-expect-error — exercising defensive guard
    applyPrefillForTests({ text: "raw prefill" });
    expect(useChat.getState().inputValue).toBe("raw prefill");
    expect(consumeLastPrefilledAlertId()).toBeNull();
  });
});
