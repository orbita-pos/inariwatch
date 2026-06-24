/**
 * Concurrency gate for AI calls — prevents a single user or workspace
 * from monopolizing AI resources.
 *
 * Limits:
 *   - 3 concurrent AI calls per user
 *   - 10 concurrent AI calls per workspace (project)
 *
 * Uses in-memory counters (safe for Vercel — each serverless instance
 * has its own counter, so actual concurrency may slightly exceed limits
 * under extreme load, but it prevents the common case of a single user
 * spamming analyze/remediate buttons).
 *
 * Redis-backed version would be exact but adds latency to every AI call.
 * In-memory is a 90% solution with zero latency cost.
 */

const userConcurrency = new Map<string, number>();
const projectConcurrency = new Map<string, number>();

const MAX_PER_USER = 3;
const MAX_PER_PROJECT = 10;

export class ConcurrencyLimitError extends Error {
  constructor(scope: string, current: number, max: number) {
    super(`AI concurrency limit reached: ${scope} has ${current}/${max} active calls`);
    this.name = "ConcurrencyLimitError";
  }
}

export function acquireAIConcurrency(userId: string, projectId: string): () => void {
  const userCount = userConcurrency.get(userId) ?? 0;
  if (userCount >= MAX_PER_USER) {
    throw new ConcurrencyLimitError(`user ${userId.slice(0, 8)}`, userCount, MAX_PER_USER);
  }

  const projectCount = projectConcurrency.get(projectId) ?? 0;
  if (projectCount >= MAX_PER_PROJECT) {
    throw new ConcurrencyLimitError(`project ${projectId.slice(0, 8)}`, projectCount, MAX_PER_PROJECT);
  }

  userConcurrency.set(userId, userCount + 1);
  projectConcurrency.set(projectId, projectCount + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const u = userConcurrency.get(userId) ?? 1;
    if (u <= 1) userConcurrency.delete(userId); else userConcurrency.set(userId, u - 1);
    const p = projectConcurrency.get(projectId) ?? 1;
    if (p <= 1) projectConcurrency.delete(projectId); else projectConcurrency.set(projectId, p - 1);
  };
}
