import { WebClient } from "@slack/web-api";
import { db, slackInstallations, slackChannelMappings } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { getRedis } from "@/lib/redis";

const clientCache = new Map<string, { client: WebClient; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Get a Slack WebClient for a given installation */
export async function getSlackClient(installationId: string): Promise<WebClient> {
  // 1. Check in-memory cache (hot path)
  const cached = clientCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;

  // 2. Check Redis cache (shared across instances, survives cold starts)
  const redis = getRedis();
  if (redis) {
    try {
      const cachedToken = await redis.get<string>(`slack_token:${installationId}`);
      if (cachedToken) {
        const token = decrypt(cachedToken);
        const client = new WebClient(token);
        clientCache.set(installationId, { client, expiresAt: Date.now() + CACHE_TTL });
        return client;
      }
    } catch {
      // Redis unavailable — fall through to DB
    }
  }

  // 3. DB lookup
  const [install] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.id, installationId))
    .limit(1);

  if (!install) throw new Error(`Slack installation ${installationId} not found`);

  const token = decrypt(install.botToken);
  const client = new WebClient(token);

  clientCache.set(installationId, { client, expiresAt: Date.now() + CACHE_TTL });

  // Cache encrypted token in Redis (5 min TTL)
  if (redis) {
    redis.set(`slack_token:${installationId}`, install.botToken, { ex: 300 }).catch(() => {});
  }

  return client;
}

/** Get a Slack client + channel for a project. Returns null if no mapping exists. */
export async function getSlackClientForProject(
  projectId: string,
): Promise<{ client: WebClient; channelId: string; installationId: string } | null> {
  const [mapping] = await db
    .select({
      installationId: slackChannelMappings.installationId,
      channelId: slackChannelMappings.channelId,
    })
    .from(slackChannelMappings)
    .where(and(
      eq(slackChannelMappings.projectId, projectId),
      eq(slackChannelMappings.isActive, true),
    ))
    .limit(1);

  if (!mapping) return null;

  const client = await getSlackClient(mapping.installationId);
  return { client, channelId: mapping.channelId, installationId: mapping.installationId };
}
