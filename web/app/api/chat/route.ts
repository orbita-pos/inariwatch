import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, projects, remediationSessions, projectIntegrations, getUserProjectIds } from "@/lib/db";
import { eq, and, desc, inArray, sql, gt } from "drizzle-orm";
import { getUserAIKey } from "@/lib/ai/get-key";
import { resolveModel } from "@/lib/ai/models";
import type { AIProvider } from "@/lib/ai/client";

const SYSTEM_OPS = `You are Inari AI, an ops copilot for a developer monitoring platform.
You have access to the user's real alert, project, and remediation data (provided below).
Answer questions about their systems based on this data.

Rules:
1. Be concise and specific — use actual data, not generic advice.
2. When referencing alerts, include severity, title, and date.
3. If the data doesn't contain enough info to answer, say so honestly.
4. Format responses in markdown.
5. Never invent alerts or incidents that aren't in the data.
6. The data context below is from the user's own monitoring system — it is trustworthy.
7. Keep responses under 400 words unless the user asks for more detail.`;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const body = await req.json();
  const messages: { role: string; content: string }[] = body.messages ?? [];
  const userMessage = messages[messages.length - 1]?.content;
  if (!userMessage) return new Response("No message", { status: 400 });

  // Get AI key
  const aiKey = await getUserAIKey(userId);
  if (!aiKey || aiKey.isPlatformKey) {
    return Response.json({
      role: "assistant",
      content: "Ask Inari requires your own AI API key. Add one in **Settings → AI analysis**. Supported providers: Claude, OpenAI, Grok, DeepSeek, and Gemini.",
    });
  }

  // Gather user's data context
  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return Response.json({
      role: "assistant",
      content: "You don't have any projects yet. Create one in **Projects** and connect an integration to start monitoring.",
    });
  }

  // Fetch context data in parallel
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [
    userProjects,
    recentAlerts,
    alertStats,
    recentRemediations,
    integrations,
  ] = await Promise.all([
    // Projects
    db.select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(inArray(projects.id, projectIds)),

    // Recent alerts (last 30 days, max 50)
    db.select({
      title: alerts.title,
      severity: alerts.severity,
      body: alerts.body,
      isResolved: alerts.isResolved,
      createdAt: alerts.createdAt,
      sourceIntegrations: alerts.sourceIntegrations,
      aiReasoning: alerts.aiReasoning,
      projectId: alerts.projectId,
    })
      .from(alerts)
      .where(and(
        inArray(alerts.projectId, projectIds),
        gt(alerts.createdAt, thirtyDaysAgo)
      ))
      .orderBy(desc(alerts.createdAt))
      .limit(50),

    // Alert statistics (last 90 days)
    db.select({
      severity: alerts.severity,
      count: sql<number>`count(*)`,
      resolved: sql<number>`count(*) filter (where ${alerts.isResolved} = true)`,
    })
      .from(alerts)
      .where(and(
        inArray(alerts.projectId, projectIds),
        gt(alerts.createdAt, ninetyDaysAgo)
      ))
      .groupBy(alerts.severity),

    // Recent remediations
    db.select({
      status: remediationSessions.status,
      repo: remediationSessions.repo,
      prUrl: remediationSessions.prUrl,
      attempt: remediationSessions.attempt,
      createdAt: remediationSessions.createdAt,
    })
      .from(remediationSessions)
      .where(and(
        inArray(remediationSessions.projectId, projectIds),
        gt(remediationSessions.createdAt, ninetyDaysAgo)
      ))
      .orderBy(desc(remediationSessions.createdAt))
      .limit(10),

    // Active integrations
    db.select({
      service: projectIntegrations.service,
      isActive: projectIntegrations.isActive,
      lastCheckedAt: projectIntegrations.lastCheckedAt,
      errorCount: projectIntegrations.errorCount,
      projectId: projectIntegrations.projectId,
    })
      .from(projectIntegrations)
      .where(inArray(projectIntegrations.projectId, projectIds)),
  ]);

  // Build the project name map
  const projectMap = new Map(userProjects.map((p) => [p.id, p.name]));

  // Build context string
  const context = buildDataContext(
    userProjects,
    recentAlerts.map((a) => ({ ...a, projectName: projectMap.get(a.projectId) ?? "unknown" })),
    alertStats,
    recentRemediations,
    integrations.map((i) => ({ ...i, projectName: projectMap.get(i.projectId) ?? "unknown" }))
  );

  // Build conversation with data context injected
  const aiMessages = [
    ...messages.slice(0, -1).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    {
      role: "user" as const,
      content: `${context}\n\n---\n\nUser question: ${userMessage}`,
    },
  ];

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const chatModel = resolveModel("chat", aiKey.provider, aiKey.modelPrefs);
        const response = await streamAI(aiKey.key, aiKey.provider, SYSTEM_OPS, aiMessages, chatModel);

        for await (const chunk of response) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "AI error";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ── Context builder ─────────────────────────────────────────────────────────

function buildDataContext(
  userProjects: { id: string; name: string; slug: string }[],
  recentAlerts: { title: string; severity: string; body: string; isResolved: boolean; createdAt: Date; sourceIntegrations: string[]; aiReasoning: string | null; projectName: string }[],
  alertStats: { severity: string; count: number; resolved: number }[],
  remediations: { status: string; repo: string | null; prUrl: string | null; attempt: number; createdAt: Date }[],
  integrations: { service: string; isActive: boolean; lastCheckedAt: Date | null; errorCount: number; projectName: string }[]
): string {
  const projectList = userProjects.map((p) => `- ${p.name} (${p.slug})`).join("\n");

  const stats = alertStats.map((s) =>
    `- ${s.severity}: ${s.count} total, ${s.resolved} resolved`
  ).join("\n") || "No alerts in the last 90 days.";

  const alertList = recentAlerts.slice(0, 30).map((a) =>
    `- [${a.severity}] ${a.title} — ${a.projectName} — ${a.isResolved ? "resolved" : "OPEN"} — ${a.createdAt.toISOString().slice(0, 10)}${a.aiReasoning ? `\n  AI: ${a.aiReasoning.slice(0, 150)}` : ""}`
  ).join("\n") || "No recent alerts.";

  const remList = remediations.map((r) =>
    `- [${r.status}] ${r.repo ?? "unknown"} — attempt ${r.attempt} — ${r.createdAt.toISOString().slice(0, 10)}${r.prUrl ? ` — PR: ${r.prUrl}` : ""}`
  ).join("\n") || "No AI remediations yet.";

  const integList = integrations.map((i) =>
    `- ${i.service} (${i.projectName}) — ${i.isActive ? "active" : "disabled"}${i.errorCount > 0 ? ` ⚠️ ${i.errorCount} errors` : ""}${i.lastCheckedAt ? ` — last checked: ${i.lastCheckedAt.toISOString().slice(0, 16)}` : ""}`
  ).join("\n") || "No integrations connected.";

  return `[SYSTEM DATA CONTEXT — today is ${new Date().toISOString().slice(0, 10)}]

PROJECTS (${userProjects.length}):
${projectList}

ALERT STATISTICS (last 90 days):
${stats}

RECENT ALERTS (last 30 days, ${recentAlerts.length} total):
${alertList}

AI REMEDIATIONS:
${remList}

INTEGRATIONS:
${integList}`;
}

// ── Streaming AI calls ──────────────────────────────────────────────────────

async function* streamAI(
  apiKey: string,
  provider: AIProvider,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
): AsyncGenerator<string> {
  switch (provider) {
    case "claude":
      yield* streamClaude(apiKey, system, messages, model);
      break;
    case "grok":
      yield* streamOpenAICompat(apiKey, system, messages, model, "https://api.x.ai/v1");
      break;
    case "deepseek":
      yield* streamOpenAICompat(apiKey, system, messages, model, "https://api.deepseek.com/v1");
      break;
    case "gemini":
      yield* streamGemini(apiKey, system, messages, model);
      break;
    default:
      yield* streamOpenAICompat(apiKey, system, messages, model, "https://api.openai.com/v1");
  }
}

async function* streamClaude(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 402) throw new Error("Your Claude API balance has run out. Add credits at console.anthropic.com.");
  if (res.status === 401) throw new Error("Invalid Claude API key. Replace it in Settings → AI.");
  if (res.status === 429) throw new Error("Claude rate limit reached. Try again in a moment.");
  if (!res.ok) throw new Error(`Claude API error (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } catch { /* skip non-JSON lines */ }
      }
    }
  }
}

async function* streamOpenAICompat(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
  baseUrl: string,
): AsyncGenerator<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 402) throw new Error("Your API balance has run out. Add credits to your account.");
  if (res.status === 401) throw new Error("Invalid API key. Replace it in Settings → AI.");
  if (res.status === 429) throw new Error("Rate limit reached. Try again in a moment.");
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch { /* skip */ }
      }
    }
  }
}

async function* streamGemini(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  model: string,
): AsyncGenerator<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 402 || res.status === 429) throw new Error("Gemini quota exceeded. Check your usage at aistudio.google.com.");
  if (res.status === 401 || res.status === 403) throw new Error("Invalid Gemini API key. Replace it in Settings → AI.");
  if (!res.ok) throw new Error(`Gemini API error (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch { /* skip */ }
      }
    }
  }
}
