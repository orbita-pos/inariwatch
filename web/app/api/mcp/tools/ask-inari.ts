import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { gatherChatContext, buildContextString, SYSTEM_OPS } from "@/lib/services/chat.service";

export async function execute(
  args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const question = args.question as string;
  if (!question) return "Error: question is required.";

  const projectIds = await getUserProjectIds(user.userId);
  if (projectIds.length === 0) return "No projects found. Create one at app.inariwatch.com.";

  const ctx = await gatherChatContext(projectIds);
  const context = buildContextString(ctx);

  // Sampling-first: let the client LLM answer with full operational context
  return JSON.stringify({
    _sampling_request: {
      description: "Answer the user's question using the operational context below.",
      messages: [{
        role: "user",
        content: { type: "text", text: `${context}\n\n---\n\nUser question: ${question}` },
      }],
      systemPrompt: SYSTEM_OPS,
      context: { tool: "ask_inari" },
      maxTokens: 2000,
    },
  }, null, 2);
}
