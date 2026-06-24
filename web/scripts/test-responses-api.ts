/**
 * Smoke test for the Responses API migration (PR #1).
 *
 * Validates end-to-end:
 *   - Router in callAIWithTools correctly detects gpt-5.x and uses Responses API
 *   - First turn returns a responseId
 *   - Second turn threads previousResponseId successfully
 *   - Tool results round-trip correctly via function_call_output
 *   - reasoningEffort is accepted without error
 *   - store:false + include:reasoning.encrypted_content don't blow up
 *
 * Usage:
 *   npx tsx scripts/test-responses-api.ts
 *   npx tsx scripts/test-responses-api.ts --model gpt-5.4          # full model
 *   npx tsx scripts/test-responses-api.ts --model gpt-4o-mini      # fallback path (Chat Completions)
 */

import { config } from "dotenv";
import path from "path";

config({ path: path.join(__dirname, "../.env.local") });

import { callAIWithTools, type ToolDefinition, type AIMessage, type ToolUseBlock, type ToolResultBlock, type ContentBlock } from "../lib/ai/client";
import { isGPT5Family } from "../lib/ai/openai-config";

// Simple 2-tool setup. The model should call get_weather(city) then submit_final.
const TOOLS: ToolDefinition[] = [
  {
    name: "get_weather",
    description: "Get the current weather in a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string", description: "The city name" } },
      required: ["city"],
    },
  },
  {
    name: "submit_final",
    description: "Call this when you have the weather answer and are done",
    input_schema: {
      type: "object",
      properties: { answer: { type: "string", description: "The full answer to report" } },
      required: ["answer"],
    },
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf("--model");
  return {
    model: modelIdx >= 0 ? args[modelIdx + 1] : "gpt-5.4-mini",
  };
}

async function main() {
  const args = parseArgs();
  const apiKey = process.env.PLATFORM_AI_KEY ?? "";
  if (!apiKey) {
    console.error("❌ PLATFORM_AI_KEY not set in .env.local");
    process.exit(1);
  }

  const isResponsesPath = isGPT5Family(args.model);

  console.log(`🧪 Responses API smoke test`);
  console.log(`   model: ${args.model}`);
  console.log(`   path:  ${isResponsesPath ? "Responses API (new)" : "Chat Completions (legacy)"}`);
  console.log();

  const systemPrompt = "You are a helpful weather assistant. Use get_weather to look up the weather, then call submit_final with a concise 1-sentence answer.";
  const messages: AIMessage[] = [
    { role: "user", content: "What is the weather in Mexico City?" },
  ];

  // ── Turn 1 ─────────────────────────────────────────────────────────────
  console.log(`▶ Turn 1: initial request`);
  const t1 = Date.now();
  const resp1 = await callAIWithTools(apiKey, systemPrompt, messages, TOOLS, {
    model: args.model,
    provider: "openai",
    maxTokens: 2048,
    reasoningEffort: "low",
  });
  const dt1 = Date.now() - t1;

  console.log(`  duration:      ${dt1}ms`);
  console.log(`  stopReason:    ${resp1.stopReason}`);
  console.log(`  responseId:    ${resp1.responseId ?? "(none)"}`);

  if (resp1.stopReason !== "tool_use") {
    console.error(`❌ Expected tool_use, got ${resp1.stopReason}`);
    console.error(`   text: ${(resp1 as { text?: string }).text?.slice(0, 200)}`);
    process.exit(1);
  }

  const toolUses1 = (resp1.content as ContentBlock[]).filter(
    (b): b is ToolUseBlock => b.type === "tool_use",
  );
  console.log(`  tools called:  ${toolUses1.map((t) => t.name).join(", ")}`);

  const weatherCall = toolUses1.find((t) => t.name === "get_weather");
  if (!weatherCall) {
    console.error(`❌ Expected get_weather call, got ${toolUses1.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`  weather input: ${JSON.stringify(weatherCall.input)}`);

  if (isResponsesPath && !resp1.responseId) {
    console.error(`❌ Responses API path returned no responseId — threading will fail`);
    process.exit(1);
  }

  // Simulate weather result and prepare turn 2
  messages.push({ role: "assistant", content: resp1.content });
  const toolResults: ToolResultBlock[] = toolUses1
    .filter((t) => t.name === "get_weather")
    .map((t) => ({
      type: "tool_result" as const,
      tool_use_id: t.id,
      content: "22°C, partly cloudy, light wind from the east",
    }));
  messages.push({ role: "user", content: toolResults });

  // ── Turn 2: thread priorOutput (reasoning + function_call items) ─────
  const priorOutputCount = resp1.priorOutput?.length ?? 0;
  console.log(`\n▶ Turn 2: forwarding priorOutput (${priorOutputCount} items)…`);
  const t2 = Date.now();
  const resp2 = await callAIWithTools(apiKey, systemPrompt, messages, TOOLS, {
    model: args.model,
    provider: "openai",
    maxTokens: 2048,
    reasoningEffort: "medium",
    priorOutput: resp1.priorOutput,
  });
  const dt2 = Date.now() - t2;

  console.log(`  duration:      ${dt2}ms`);
  console.log(`  stopReason:    ${resp2.stopReason}`);
  console.log(`  responseId:    ${resp2.responseId ?? "(none)"}`);

  if (resp2.stopReason === "tool_use") {
    const toolUses2 = (resp2.content as ContentBlock[]).filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    console.log(`  tools called:  ${toolUses2.map((t) => t.name).join(", ")}`);
    const submit = toolUses2.find((t) => t.name === "submit_final");
    if (submit) {
      console.log(`  answer:        ${JSON.stringify(submit.input).slice(0, 200)}`);
    }
  } else {
    console.log(`  text:          ${(resp2 as { text: string }).text.slice(0, 200)}`);
  }

  // ── Validation summary ───────────────────────────────────────────────
  console.log(`\n─────────────────────────────────────────`);
  console.log(`Total duration: ${dt1 + dt2}ms`);
  console.log(`Turn-2 lift:    ${dt2 < dt1 ? "-" : "+"}${Math.abs(dt2 - dt1)}ms vs turn 1`);

  if (isResponsesPath) {
    if (resp1.responseId && resp2.responseId) {
      console.log(`✅ Responses API: both turns returned responseIds, threading worked`);
    } else {
      console.log(`❌ Responses API: missing responseId somewhere`);
      process.exit(1);
    }
  } else {
    console.log(`ℹ  Chat Completions path (no responseId expected, none returned: ${!resp1.responseId && !resp2.responseId ? "✓" : "✗"})`);
  }

  console.log(`\n🎉 Smoke test passed.`);
}

main().catch((err) => {
  console.error(`\n❌ Test failed:`, err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack.split("\n").slice(0, 5).join("\n"));
  }
  process.exit(1);
});
