import * as SecureStore from "expo-secure-store";
import * as Linking from "expo-linking";
import { AppState } from "react-native";

const API_BASE = "https://app.inariwatch.com";
const TOKEN_KEY = "inariwatch_token";

// Auth state listeners — lets _layout.tsx react when login/logout happens
type AuthListener = (loggedIn: boolean) => void;
const listeners = new Set<AuthListener>();

export function onAuthChange(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  listeners.forEach((l) => l(true));
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  listeners.forEach((l) => l(false));
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

/**
 * Wait until the app is in the foreground.
 * When the user switches to the browser to approve, the app goes to background
 * and setTimeout timers fire all at once — burning through poll attempts.
 * This pauses the loop until the user comes back.
 */
function waitForForeground(): Promise<void> {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise((resolve) => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") { sub.remove(); resolve(); }
    });
  });
}

export async function pollForToken(
  code: string,
  onStatus?: (status: string) => void
): Promise<string | null> {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min (matches backend code expiry)

  while (Date.now() < deadline) {
    await sleep(3000);
    onStatus?.("waiting");

    try {
      const resp = await fetch(`${API_BASE}/api/cli/auth/poll?code=${code}&client=mobile`, {
        signal: AbortSignal.timeout(10_000),
      });
      console.log("[auth-poll] status:", resp.status);
      if (resp.status === 404) return null; // code consumed or invalid
      if (!resp.ok) continue;

      const data = await resp.json();
      console.log("[auth-poll] data:", JSON.stringify(data));
      if (data.status === "approved" && data.apiToken) {
        await setToken(data.apiToken);
        return data.apiToken;
      }
      if (data.status === "expired" || data.status === "invalid") {
        return null;
      }
    } catch (err) {
      console.log("[auth-poll] error:", err);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
