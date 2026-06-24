import { newSession, type Session } from "./auth";

export function startSession(userId: string): Session {
  const s = newSession(userId);
  return s;
}
