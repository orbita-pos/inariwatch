export interface Session {
  userId: string;
  token: string;
}

export function newSession(userId: string): Session {
  return { userId, token: "sample" };
}
