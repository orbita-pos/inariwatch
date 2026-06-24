/**
 * Pure helpers for `@<email>` mention parsing in replay comments.
 *
 * Why a dedicated module: the parser needs to be unit-testable without
 * spinning up the DB, and the email-resolution + notification code that
 * sits on top of it benefits from the same separation.
 */

/** Matches `@<email>` substrings inside a comment body. RFC 5321 is much
 *  laxer than this — we restrict to common ASCII to keep the regex fast
 *  and the false-positive rate low. */
const MENTION_RE = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

/**
 * Extract every `@email` found in the body. Returns lowercased + deduped
 * emails; ordering follows first-occurrence in the body.
 */
export function extractMentionEmails(body: string): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex on each call — RegExp has stateful global flag.
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const email = m[1].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Resolve a list of `@mention` emails to user ids that actually belong
 * to the org in question. Used to (a) populate `mentioned_user_ids` on
 * the row and (b) drive the notification fanout. Anyone NOT in the org
 * is silently dropped — we never expose "is X a user?" to outsiders.
 */
export interface MentionResolver {
  emails: string[];
  organizationId: string;
}
export interface ResolvedMentions {
  /** User ids that matched both an email AND org membership. */
  userIds: string[];
  /** The (id, email) pairs of resolved users for downstream notification. */
  users: { id: string; email: string }[];
}
