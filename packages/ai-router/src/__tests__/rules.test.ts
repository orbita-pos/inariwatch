import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks";
import { RULES, getRule, resolvePrimary } from "../rules";

describe("routing rules — S3 (post-flip)", () => {
  it("non-cloud rules MUST be flag-gated (workspaceFlag required)", () => {
    // Invariant: a non-cloud primary REQUIRES a workspaceFlag so default
    // behavior stays cloud for every existing workspace. Adding a new
    // local-routed task without a flag would change behavior for every
    // customer the moment they upgrade.
    for (const [task, rule] of Object.entries(RULES)) {
      if (rule.primary.substrate === "cloud") continue;
      expect(
        rule.workspaceFlag,
        `task ${task} routes to ${rule.primary.substrate} but has no workspaceFlag`,
      ).toBeTruthy();
    }
  });

  it("non-cloud rules either have a fallback OR are documented no-fallback (whatsapp)", () => {
    // Most non-cloud rules (notify.compose.email, voice.tts.*) have a
    // cloud fallback so sidecar offline is transparent. Some — currently
    // only `notify.compose.whatsapp` — are intentionally no-fallback
    // because the cloud has no path to the user's WhatsApp account.
    // Caller (web's notification fan-out) decides graceful degradation.
    const NO_FALLBACK_ALLOWLIST = new Set<string>([
      TASKS.NOTIFY_COMPOSE_WHATSAPP,
    ]);
    for (const [task, rule] of Object.entries(RULES)) {
      if (rule.primary.substrate === "cloud") continue;
      if (NO_FALLBACK_ALLOWLIST.has(task)) {
        expect(
          rule.fallback,
          `task ${task} is documented no-fallback but has one`,
        ).toBeUndefined();
      } else {
        expect(
          rule.fallback,
          `task ${task} routes to ${rule.primary.substrate} but has no fallback`,
        ).toBeTruthy();
      }
    }
  });

  it("notify.compose.email is the first user-sidecar rule and lands behind localNotifyEnabled", () => {
    const r = getRule(TASKS.NOTIFY_COMPOSE_EMAIL);
    expect(r.primary.substrate).toBe("user-sidecar");
    expect(r.workspaceFlag).toBe("localNotifyEnabled");
    expect(r.fallback?.substrate).toBe("cloud");
    expect(r.fallbackTriggers).toContain("sidecar-offline");
    expect(r.fallbackTriggers).toContain("sidecar-timeout");
  });

  it("getRule returns the configured rule for each task", () => {
    const r = getRule(TASKS.CODE_FIX_SINGLE_SHOT);
    expect(r.primary.substrate).toBe("cloud");
    expect(r.fallback?.substrate).toBe("cloud");
  });

  it("resolvePrimary respects forceCloudOnly", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      forceCloudOnly: true,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("resolvePrimary applies workspace task overrides", () => {
    const r = resolvePrimary(TASKS.CODE_FIX_SINGLE_SHOT, {
      taskOverrides: {
        [TASKS.CODE_FIX_SINGLE_SHOT]: {
          substrate: "cloud",
          provider: "claude",
          model: "claude-sonnet-4-6",
        },
      },
    });
    expect(r.substrate).toBe("cloud");
    if (r.substrate === "cloud") {
      expect(r.provider).toBe("claude");
      expect(r.model).toBe("claude-sonnet-4-6");
    }
  });

  // S3 zero-regression invariant: workspaces with the flag OFF must
  // resolve to the same target the pre-S3 rule pointed at (cloud). If
  // this fails, a customer who never opts in starts seeing local-routed
  // dispatches — that's the regression the wedge has to avoid.
  it("notify.compose.email resolves to cloud when localNotifyEnabled is undefined", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL);
    expect(r.substrate).toBe("cloud");
  });

  it("notify.compose.email resolves to cloud when localNotifyEnabled is false", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      localNotifyEnabled: false,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("notify.compose.email resolves to user-sidecar when localNotifyEnabled is true", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      localNotifyEnabled: true,
    });
    expect(r.substrate).toBe("user-sidecar");
    if (r.substrate === "user-sidecar") {
      expect(r.model).toBe("qwen2.5-coder-1.5b");
    }
  });

  it("forceCloudOnly wins over localNotifyEnabled=true", () => {
    // §6.3 — workspace can opt out even if the per-task flag is on.
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      localNotifyEnabled: true,
      forceCloudOnly: true,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("taskOverrides win over both forceCloudOnly and localNotifyEnabled", () => {
    // Admin escape hatch — the override wins outright. Tests just that
    // the precedence order is correct, not that any user-facing toggle
    // surfaces it.
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      forceCloudOnly: true,
      localNotifyEnabled: false,
      taskOverrides: {
        [TASKS.NOTIFY_COMPOSE_EMAIL]: {
          substrate: "user-sidecar",
          model: "qwen2.5-coder-1.5b",
        },
      },
    });
    expect(r.substrate).toBe("user-sidecar");
  });

  it("notify.compose.{slack,telegram,push,digest,status-page,postmortem-prose} stay cloud", () => {
    for (const task of [
      TASKS.NOTIFY_COMPOSE_SLACK,
      TASKS.NOTIFY_COMPOSE_TELEGRAM,
      TASKS.NOTIFY_COMPOSE_PUSH,
      TASKS.NOTIFY_COMPOSE_DIGEST,
      TASKS.NOTIFY_COMPOSE_STATUS_PAGE,
      TASKS.NOTIFY_COMPOSE_POSTMORTEM_PROSE,
    ]) {
      // Even with localNotifyEnabled=true these stay cloud — they're not
      // gated on a workspaceFlag yet (that's S4+).
      const r = resolvePrimary(task, { localNotifyEnabled: true });
      expect(r.substrate, `task ${task}`).toBe("cloud");
    }
  });

  // ── v0.3 S5 (Baileys rewrite) — notify.compose.whatsapp + voice.tts.* ──

  it("notify.compose.whatsapp routes to user-sidecar behind localNotifyEnabled", () => {
    const r = getRule(TASKS.NOTIFY_COMPOSE_WHATSAPP);
    expect(r.primary.substrate).toBe("user-sidecar");
    if (r.primary.substrate === "user-sidecar") {
      expect(r.primary.model).toBe("qwen2.5-coder-1.5b");
    }
    expect(r.workspaceFlag).toBe("localNotifyEnabled");
    // Critical: NO cloud fallback. Cloud has no path to the user's
    // personal WhatsApp account, so sidecar-offline triggers graceful
    // skip on the caller side (NOT a transparent cloud retry).
    expect(r.fallback).toBeUndefined();
  });

  it("notify.compose.whatsapp resolves to cloud when localNotifyEnabled is off (parity with S3)", () => {
    // resolvePrimary returns rule.fallback ?? cloud when the flag is off
    // — for whatsapp the fallback is undefined, so we get plain cloud.
    // The dispatcher then sends to cloud, which has no whatsapp adapter
    // and the caller sees an error → skips this notification surface.
    expect(resolvePrimary(TASKS.NOTIFY_COMPOSE_WHATSAPP).substrate).toBe("cloud");
    expect(
      resolvePrimary(TASKS.NOTIFY_COMPOSE_WHATSAPP, { localNotifyEnabled: false })
        .substrate,
    ).toBe("cloud");
  });

  it("notify.compose.whatsapp resolves to user-sidecar when localNotifyEnabled is true", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_WHATSAPP, {
      localNotifyEnabled: true,
    });
    expect(r.substrate).toBe("user-sidecar");
  });

  it("voice.tts.alert routes to piper-tts behind localVoiceEnabled, with openai tts-1 fallback", () => {
    const r = getRule(TASKS.VOICE_TTS_ALERT);
    expect(r.primary.substrate).toBe("user-sidecar");
    if (r.primary.substrate === "user-sidecar") {
      expect(r.primary.model).toBe("piper-tts");
    }
    expect(r.workspaceFlag).toBe("localVoiceEnabled");
    expect(r.fallback?.substrate).toBe("cloud");
    if (r.fallback?.substrate === "cloud") {
      expect(r.fallback.provider).toBe("openai");
      expect(r.fallback.model).toBe("tts-1");
    }
    expect(r.fallbackTriggers).toContain("sidecar-offline");
    expect(r.fallbackTriggers).toContain("sidecar-timeout");
  });

  it("voice.tts.digest mirrors voice.tts.alert routing", () => {
    const r = getRule(TASKS.VOICE_TTS_DIGEST);
    expect(r.primary.substrate).toBe("user-sidecar");
    expect(r.workspaceFlag).toBe("localVoiceEnabled");
    expect(r.fallback?.substrate).toBe("cloud");
  });

  it("voice.tts.* with localVoiceEnabled OFF resolves to its cloud fallback", () => {
    expect(resolvePrimary(TASKS.VOICE_TTS_ALERT).substrate).toBe("cloud");
    expect(resolvePrimary(TASKS.VOICE_TTS_DIGEST).substrate).toBe("cloud");
  });

  it("voice.tts.alert with localVoiceEnabled=true resolves to user-sidecar", () => {
    const r = resolvePrimary(TASKS.VOICE_TTS_ALERT, {
      localVoiceEnabled: true,
    });
    expect(r.substrate).toBe("user-sidecar");
    if (r.substrate === "user-sidecar") {
      expect(r.model).toBe("piper-tts");
    }
  });

  it("forceCloudOnly demotes voice.tts to cloud even when localVoiceEnabled=true", () => {
    const r = resolvePrimary(TASKS.VOICE_TTS_ALERT, {
      localVoiceEnabled: true,
      forceCloudOnly: true,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("localNotifyEnabled and localVoiceEnabled are independent flags", () => {
    // Notify on, voice off → whatsapp routes local, voice routes cloud.
    expect(
      resolvePrimary(TASKS.NOTIFY_COMPOSE_WHATSAPP, {
        localNotifyEnabled: true,
        localVoiceEnabled: false,
      }).substrate,
    ).toBe("user-sidecar");
    expect(
      resolvePrimary(TASKS.VOICE_TTS_ALERT, {
        localNotifyEnabled: true,
        localVoiceEnabled: false,
      }).substrate,
    ).toBe("cloud");

    // Voice on, notify off → inverse.
    expect(
      resolvePrimary(TASKS.NOTIFY_COMPOSE_WHATSAPP, {
        localNotifyEnabled: false,
        localVoiceEnabled: true,
      }).substrate,
    ).toBe("cloud");
    expect(
      resolvePrimary(TASKS.VOICE_TTS_ALERT, {
        localNotifyEnabled: false,
        localVoiceEnabled: true,
      }).substrate,
    ).toBe("user-sidecar");
  });
});
