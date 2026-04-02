import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";

const API_BASE = "https://app.inariwatch.com";
const TOKEN_KEY = "inariwatch_token";

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  return !!token;
}

/**
 * Device flow auth:
 * 1. Start → get code
 * 2. Open browser → user approves
 * 3. Poll → get token
 */
export async function startDeviceFlow(): Promise<{
  code: string;
  verifyUrl: string;
}> {
  const resp = await fetch(`${API_BASE}/api/cli/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) throw new Error("Failed to start auth flow");
  return resp.json();
}

export async function openVerifyPage(verifyUrl: string): Promise<void> {
  await Linking.openURL(verifyUrl);
}

export async function pollForToken(
  code: string,
  onStatus?: (status: string) => void
): Promise<string | null> {
  const maxAttempts = 60; // 5 minutes at 5s intervals
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);
    onStatus?.("waiting");

    try {
      const resp = await fetch(`${API_BASE}/api/cli/auth/poll?code=${code}&client=mobile`);
      if (!resp.ok) continue;

      const data = await resp.json();
      if (data.status === "approved" && data.apiToken) {
        await setToken(data.apiToken);
        return data.apiToken;
      }
      if (data.status === "expired" || data.status === "invalid") {
        return null;
      }
    } catch {
      // Network error, retry
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
