import { callAI } from "@/lib/ai/client";
import { getUserAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { gatherChatContext, buildContextString, SYSTEM_OPS } from "@/lib/services/chat.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const question = args.question as string;
  if (!question) return "Error: question is required.";

  const aiKey = await getUserAIKey(user.userId);

  if (!aiKey || aiKey.isPlatformKey) {
    return JSON.stringify({
      error: "Ask Inari requires an AI API key. Add one in Settings → AI analysis.",
      _sampling_request: {
        description: "No AI key configured. Use your client LLM to answer based on the context below.",
        messages: [{ role: "user", content: { type: "text", text: question } }],
        systemPrompt: SYSTEM_OPS,
        maxTokens: 2000,
      },
    }, null, 2);
  }

  const projectIds = await getUserProjectIds(user.userId);
  if (projectIds.length === 0) return "No projects found. Create one at app.inariwatch.com.";

  const ctx = await gatherChatContext(projectIds);
  const context = buildContextString(ctx);

  try {
    const chatModel = resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
    return await callAI(aiKey.key, SYSTEM_OPS, [
      { role: "user", content: `${context}\n\n---\n\nUser question: ${question}` },
    ], { provider: aiKey.provider, model: chatModel });
  } catch (e) {
    return `Error calling AI: ${e instanceof Error ? e.message : "unknown"}`;
  }
}
