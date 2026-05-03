// v0.3 S5 — eval scorer for `notify.compose.whatsapp` outputs.
//
// Mirrors the email judge structure (`./judge.ts`) but pinned to the
// WhatsApp output shape (no subject, body+buttons only) and a stricter
// no-markdown invariant — WhatsApp clients render markdown literally,
// so any leaked `**bold**` / `_italic_` / backticks costs the run
// points.

import type {
  ComposeWhatsappEvalItem,
  ComposeWhatsappEvalRubric,
} from "./whatsapp-corpus";

export interface ComposeWhatsappEvalOutput {
  body: string;
  buttons: Array<{ id: string; title: string }>;
}

export interface WhatsappItemScore {
  id: string;
  score: number; // 0-100
  rubricScore: number; // 0-60
  judgeScore: number; // 0-40
  rubricFailures: string[];
  judgeReasoning?: string;
}

export type WhatsappJudgeFn = (
  item: ComposeWhatsappEvalItem,
  output: ComposeWhatsappEvalOutput,
) => Promise<{ score: number; reasoning: string }>;

// ── Hard rubric ────────────────────────────────────────────────────────────

/** Score 0-60. Mirrors the weights documented at the file top. */
export function scoreWhatsappRubric(
  rubric: ComposeWhatsappEvalRubric,
  output: ComposeWhatsappEvalOutput,
): { score: number; failures: string[] } {
  const failures: string[] = [];
  let score = 60;
  const bodyLc = output.body.toLowerCase();

  // body must-contain — each missing -5, max -30.
  if (rubric.bodyMustContain && rubric.bodyMustContain.length > 0) {
    let missing = 0;
    for (const phrase of rubric.bodyMustContain) {
      if (!bodyLc.includes(phrase.toLowerCase())) {
        missing += 1;
        failures.push(`body missing '${phrase}'`);
      }
    }
    score -= Math.min(30, missing * 5);
  }

  // body must-NOT-contain — each occurrence -10, max -30. Adds the
  // "no markdown" + "no URLs" defaults so every item enforces the
  // WhatsApp invariants whether or not the corpus item said so.
  const NO_MARKDOWN_DEFAULT = ["**", "```", "<a ", "</a>"];
  const URL_RE = /(https?:\/\/\S+)/i;
  const merged = [
    ...(rubric.bodyMustNotContain ?? []),
    ...NO_MARKDOWN_DEFAULT,
  ];
  let leaks = 0;
  for (const phrase of merged) {
    if (bodyLc.includes(phrase.toLowerCase())) {
      leaks += 1;
      failures.push(`body leaked '${phrase}'`);
    }
  }
  if (URL_RE.test(output.body)) {
    leaks += 1;
    failures.push("body contains a URL (WhatsApp prompt forbids inline URLs)");
  }
  score -= Math.min(30, leaks * 10);

  // Length window — outside the window deducts 10. Default cap 1024
  // (WhatsApp Meta limit), default floor 20.
  const minLen = rubric.minLengthChars ?? 20;
  const maxLen = rubric.maxLengthChars ?? 1024;
  if (output.body.length < minLen) {
    failures.push(`body too short (${output.body.length} < ${minLen})`);
    score -= 10;
  } else if (output.body.length > maxLen) {
    failures.push(`body too long (${output.body.length} > ${maxLen})`);
    score -= 10;
  }

  // Buttons — out-of-range deducts 10. Default range [0, 3].
  const [minB, maxB] = rubric.expectedButtonsRange ?? [0, 3];
  if (output.buttons.length < minB || output.buttons.length > maxB) {
    failures.push(
      `buttons count ${output.buttons.length} outside [${minB}, ${maxB}]`,
    );
    score -= 10;
  }
  // Each button title must be ≤ 20 chars (Meta cap).
  for (const b of output.buttons) {
    if ([...b.title].length > 20) {
      failures.push(`button title too long: '${b.title}'`);
      score -= 5;
      break; // single deduction even if multiple
    }
  }

  return { score: Math.max(0, score), failures };
}

// ── LLM-as-judge ───────────────────────────────────────────────────────────

export function buildWhatsappJudgePrompt(
  item: ComposeWhatsappEvalItem,
  output: ComposeWhatsappEvalOutput,
): { system: string; user: string } {
  const system =
    "You are evaluating a WhatsApp message body for an incident-management product. " +
    "Score the message on a 0-40 scale based on FOUR axes (10 points each):\n" +
    "1. Tone match — concise, urgent, recipient-role appropriate\n" +
    "2. Factual accuracy — references real fields from the alert, no hallucinated numbers/URLs\n" +
    "3. Action specificity — buttons (when present) are concrete and relevant; if no buttons, the body itself implies the next step\n" +
    "4. Language correctness — matches requested language (en/es), no mixed-language drift, no leaked markdown\n\n" +
    "Respond with strict JSON, no commentary or markdown:\n" +
    '{"score": <0-40>, "reasoning": "<one sentence>"}';
  const user = JSON.stringify({
    alert: item.input.alert,
    recipient_role: item.input.recipient_role,
    language: item.input.language,
    composition: output,
  });
  return { system, user };
}

export function makeWhatsappGpt4oMiniJudge(opts: {
  apiKey: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  model?: string;
}): WhatsappJudgeFn {
  const fetchImpl = opts.fetcher ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const model = opts.model ?? "gpt-4o-mini";
  return async (item, output) => {
    const { system, user } = buildWhatsappJudgePrompt(item, output);
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      throw new Error(`whatsapp-judge http ${res.status}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { score?: number; reasoning?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`whatsapp-judge returned non-JSON: ${raw.slice(0, 200)}`);
    }
    const score = clamp(toNumber(parsed.score, 0), 0, 40);
    return {
      score,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function toNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export async function scoreWhatsappItem(
  item: ComposeWhatsappEvalItem,
  output: ComposeWhatsappEvalOutput,
  judge: WhatsappJudgeFn,
): Promise<WhatsappItemScore> {
  const { score: rubricScore, failures } = scoreWhatsappRubric(
    item.rubric,
    output,
  );
  const judgement = await judge(item, output);
  const judgeScore = clamp(judgement.score, 0, 40);
  return {
    id: item.id,
    score: rubricScore + judgeScore,
    rubricScore,
    judgeScore,
    rubricFailures: failures,
    judgeReasoning: judgement.reasoning,
  };
}

// ── Voice WAV smoke check (deterministic, no LLM) ──────────────────────────
//
// `voice.tts.*` is deterministic synthesis — there's no LLM grading.
// The eval surface for voice is a smoke check on the WAV: header parses,
// duration > 0, audio data non-empty. Anything that produces a valid WAV
// passes. This function is exported so `web/scripts/run-eval.ts` (and
// future smoke harnesses) can validate voice outputs from any substrate
// (Piper, synthetic fallback, OpenAI tts-1 .mp3 → .wav, …).

export interface VoiceSmokeResult {
  ok: boolean;
  reason?: string;
  durationMs?: number;
  sampleRateHz?: number;
  channels?: number;
  bitsPerSample?: number;
  dataSize?: number;
}

export function checkVoiceWav(wav: Uint8Array): VoiceSmokeResult {
  if (wav.length < 44) {
    return { ok: false, reason: `WAV too short (${wav.length} < 44 bytes)` };
  }
  // RIFF / WAVE / fmt  / data magic
  const magicRiff = String.fromCharCode(...wav.subarray(0, 4));
  const magicWave = String.fromCharCode(...wav.subarray(8, 12));
  const magicFmt = String.fromCharCode(...wav.subarray(12, 16));
  const magicData = String.fromCharCode(...wav.subarray(36, 40));
  if (magicRiff !== "RIFF") return { ok: false, reason: "missing RIFF" };
  if (magicWave !== "WAVE") return { ok: false, reason: "missing WAVE" };
  if (magicFmt !== "fmt ") return { ok: false, reason: "missing fmt " };
  if (magicData !== "data") return { ok: false, reason: "missing data" };

  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const audioFmt = dv.getUint16(20, true);
  if (audioFmt !== 1) {
    return { ok: false, reason: `audio format ${audioFmt} not PCM (1)` };
  }
  const channels = dv.getUint16(22, true);
  const rate = dv.getUint32(24, true);
  const bits = dv.getUint16(34, true);
  const dataSize = dv.getUint32(40, true);
  const bytesPerSec = rate * channels * (bits / 8);
  if (bytesPerSec === 0) {
    return { ok: false, reason: "bytes/sec == 0 (rate * channels * bits)" };
  }
  if (dataSize === 0) {
    return { ok: false, reason: "data chunk is empty" };
  }
  const durationMs = Math.round((dataSize * 1000) / bytesPerSec);
  if (durationMs <= 0) {
    return { ok: false, reason: `duration ${durationMs} ms not positive` };
  }
  return {
    ok: true,
    durationMs,
    sampleRateHz: rate,
    channels,
    bitsPerSample: bits,
    dataSize,
  };
}
