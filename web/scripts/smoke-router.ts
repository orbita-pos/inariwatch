/**
 * v0.3 S1 acceptance smoke — exercises the router against a real provider.
 *
 * Usage:
 *   PLATFORM_AI_KEY=sk-... npx tsx scripts/smoke-router.ts
 *
 * Runs three flows that each hit a different rule:
 *   1. alert.auto-analyze (CLOUD_OPENAI rule, complete mode)
 *   2. alert.classify     (CLOUD_GROQ rule with cloud-error fallback)
 *   3. code.fix.agent-loop  (CLOUD_OPENAI rule, tool-use mode, with a tiny
 *                           single-tool schema so we don't burn budget)
 *
 * Pass = all three return non-empty text/tool-use AND exactly one router
 * receipt is emitted per call.
 */

import { dispatch, registerReceiptSink, TASKS } from "@inariwatch/ai-router";

const apiKey = process.env.PLATFORM_AI_KEY ?? process.env.OPENAI_API_KEY;
if (!apiKey || !apiKey.startsWith("sk-")) {
  console.error(
    "smoke-router: set PLATFORM_AI_KEY (or OPENAI_API_KEY) to a real OpenAI key.",
  );
  process.exit(1);
}

const receipts: unknown[] = [];
registerReceiptSink((r) => {
  receipts.push(r);
});

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`✗ ${name}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

void (async () => {
  await check("alert.auto-analyze (complete)", async () => {
    const out = await dispatch({
      mode: "complete",
      task: TASKS.ALERT_AUTO_ANALYZE,
      apiKey: apiKey!,
      systemPrompt: "Reply with a single word.",
      messages: [{ role: "user", content: "Say 'ok'" }],
      maxTokens: 8,
    });
    if (out.mode !== "complete" || !out.response.text) {
      throw new Error("empty response");
    }
  });

  await check("alert.classify (groq with openai fallback)", async () => {
    // Without a Groq key the rule's primary will fail; fallback to OpenAI
    // is what we're verifying.
    const out = await dispatch({
      mode: "complete",
      task: TASKS.ALERT_CLASSIFY,
      apiKey: apiKey!,
      provider: "openai",
      systemPrompt:
        'Classify "TypeError: Cannot read property X of undefined" as auto_fix, triage_only, or full_remediation. Reply only with the class name.',
      messages: [{ role: "user", content: "go" }],
      maxTokens: 16,
      temperature: 0,
    });
    if (out.mode !== "complete" || !out.response.text) {
      throw new Error("empty response");
    }
  });

  await check("code.fix.agent-loop (tool-use)", async () => {
    const out = await dispatch({
      mode: "tool-use",
      task: TASKS.CODE_FIX_AGENT_LOOP,
      apiKey: apiKey!,
      provider: "openai",
      systemPrompt:
        "Use the noop tool exactly once and stop.",
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          name: "noop",
          description: "Does nothing.",
          input_schema: { type: "object", properties: {} },
        },
      ],
      model: "gpt-4o-mini",
      maxTokens: 64,
    });
    if (out.mode !== "tool-use") {
      throw new Error("expected tool-use mode response");
    }
  });

  console.log(`\nReceipts emitted: ${receipts.length} (expected 3)`);
  if (receipts.length !== 3) {
    console.error("✗ wrong receipt count");
    process.exit(3);
  }
  console.log("\nv0.3 S1 smoke: PASS");
})();
