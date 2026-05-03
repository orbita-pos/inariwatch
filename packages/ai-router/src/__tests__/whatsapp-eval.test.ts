// v0.3 S5 — eval harness smoke tests for WhatsApp + voice.
//
// These tests exercise the rubric scorer + voice WAV checker without
// touching a real LLM judge or model. Real-model eval runs are a
// production wrapper (`web/scripts/run-eval.ts`) that consumes the
// same exports we're testing.

import { describe, it, expect } from "vitest";

import {
  NOTIFY_COMPOSE_WHATSAPP_CORPUS,
  type ComposeWhatsappEvalItem,
} from "../eval/whatsapp-corpus";
import {
  scoreWhatsappRubric,
  scoreWhatsappItem,
  checkVoiceWav,
  type ComposeWhatsappEvalOutput,
  type WhatsappJudgeFn,
} from "../eval/whatsapp-judge";

describe("whatsapp eval — corpus", () => {
  it("ships ≥ 30 representative scenarios", () => {
    expect(NOTIFY_COMPOSE_WHATSAPP_CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it("has ≥ 1 Spanish-language scenario", () => {
    const es = NOTIFY_COMPOSE_WHATSAPP_CORPUS.filter(
      (c) => c.input.language === "es",
    );
    expect(es.length).toBeGreaterThanOrEqual(1);
  });

  it("ids are unique", () => {
    const ids = NOTIFY_COMPOSE_WHATSAPP_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("whatsapp eval — rubric", () => {
  const item: ComposeWhatsappEvalItem = NOTIFY_COMPOSE_WHATSAPP_CORPUS[0];

  it("perfect output scores full 60", () => {
    const r = scoreWhatsappRubric(item.rubric, {
      body: "TypeError detected at form.tsx line 42. handleSubmit failed because user is undefined. Push the fix once auth is restored.",
      buttons: [{ id: "ack", title: "Acknowledge" }],
    });
    expect(r.score).toBe(60);
    expect(r.failures).toEqual([]);
  });

  it("missing must-contain phrase docks 5 points", () => {
    const r = scoreWhatsappRubric(item.rubric, {
      body: "An error happened in form.tsx at line 42 when user was undefined.", // no 'TypeError'
      buttons: [],
    });
    expect(r.score).toBe(55);
    expect(r.failures.join("\n")).toMatch(/missing 'TypeError'/i);
  });

  it("leaked markdown docks 10 points (no rubric must-not-contain needed)", () => {
    const r = scoreWhatsappRubric(item.rubric, {
      body: "TypeError at **form.tsx** at line 42 — handleSubmit hit undefined.",
      buttons: [],
    });
    expect(r.score).toBeLessThanOrEqual(50);
    expect(r.failures.join("\n")).toMatch(/leaked '\*\*'/i);
  });

  it("inline URL docks 10 points (WhatsApp invariant)", () => {
    const r = scoreWhatsappRubric(item.rubric, {
      body: "TypeError detected; see https://app.inariwatch.com/alerts/abc for details.",
      buttons: [],
    });
    expect(r.score).toBeLessThanOrEqual(50);
    expect(r.failures.join("\n")).toMatch(/contains a URL/i);
  });

  it("body over 1024 chars docks 10 points", () => {
    const huge = "TypeError ".repeat(200); // > 1024
    const r = scoreWhatsappRubric(item.rubric, {
      body: huge,
      buttons: [],
    });
    // The rubric for "wa-fe-typeerror" sets maxLengthChars=600, so going
    // over 600 is what trips the deduction here. Either way, score < 60.
    expect(r.score).toBeLessThan(60);
    expect(r.failures.join("\n")).toMatch(/body too long/i);
  });

  it("scoreWhatsappItem combines rubric + judge into 0-100", async () => {
    const fakeJudge: WhatsappJudgeFn = async () => ({
      score: 35,
      reasoning: "tone OK, factual, concise",
    });
    const out: ComposeWhatsappEvalOutput = {
      body: "TypeError detected at form.tsx line 42 — handleSubmit failed when user was undefined.",
      buttons: [{ id: "ack", title: "Acknowledge" }],
    };
    const score = await scoreWhatsappItem(item, out, fakeJudge);
    expect(score.score).toBe(score.rubricScore + score.judgeScore);
    expect(score.score).toBeGreaterThanOrEqual(85);
    expect(score.judgeReasoning).toBe("tone OK, factual, concise");
  });
});

describe("voice eval — WAV smoke check", () => {
  function makeWav(durationMs: number): Uint8Array {
    const sampleRate = 22050;
    const channels = 1;
    const bits = 16;
    const samples = Math.round((sampleRate * durationMs) / 1000);
    const dataSize = samples * channels * (bits / 8);
    const buf = new Uint8Array(44 + dataSize);
    const dv = new DataView(buf.buffer);
    buf.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    dv.setUint32(4, 36 + dataSize, true);
    buf.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
    buf.set([0x66, 0x6d, 0x74, 0x20], 12); // fmt
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * (bits / 8), true);
    dv.setUint16(32, channels * (bits / 8), true);
    dv.setUint16(34, bits, true);
    buf.set([0x64, 0x61, 0x74, 0x61], 36); // data
    dv.setUint32(40, dataSize, true);
    return buf;
  }

  it("accepts a synthetic 500ms WAV", () => {
    const wav = makeWav(500);
    const result = checkVoiceWav(wav);
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBe(500);
    expect(result.sampleRateHz).toBe(22050);
    expect(result.channels).toBe(1);
    expect(result.bitsPerSample).toBe(16);
  });

  it("rejects buffers shorter than the header", () => {
    const result = checkVoiceWav(new Uint8Array(20));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too short/);
  });

  it("rejects buffers missing RIFF magic", () => {
    const wav = makeWav(100);
    wav[0] = 0x58; // X
    const result = checkVoiceWav(wav);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing RIFF/);
  });

  it("rejects buffers with empty data chunk", () => {
    const wav = makeWav(0);
    const result = checkVoiceWav(wav);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });
});
