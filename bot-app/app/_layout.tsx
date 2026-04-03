import { useEffect, useState } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar, AppState, LogBox, View, Text, Pressable, Linking, StyleSheet } from "react-native";

// expo-notifications shows a console.error in Expo Go (SDK 53+) — not a crash, just a dev warning
LogBox.ignoreLogs(["expo-notifications"]);
import { ThemeProvider, DarkTheme } from "@react-navigation/native";
import { QueryClientProvider } from "@tanstack/react-query";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { isLoggedIn, onAuthChange } from "../lib/auth";
import { setupNotificationHandler, setupPush, clearBadge } from "../lib/push";
import { isBiometricEnabled, authenticateBiometric } from "../lib/biometric";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { OfflineBanner } from "../components/OfflineBanner";
import { queryClient } from "../lib/query-client";
import { colors, spacing, fontSize } from "../lib/theme";

const NAV_THEME = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.fgStrong,
    border: colors.border,
    primary: colors.accent,
  },
};

const APP_VERSION = "1.0.0";

export default function RootLayout() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);

  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    isLoggedIn().then(async (loggedIn) => {
      setAuthed(loggedIn);
      if (loggedIn) {
        setupPush().catch(() => {});
        const bioEnabled = await isBiometricEnabled();
        if (bioEnabled) {
          setLocked(true);
          const ok = await authenticateBiometric();
          setLocked(!ok);
        }
      }
    });
    setupNotificationHandler().catch(() => {});
    checkVersion();

    const unsubAuth = onAuthChange((loggedIn) => {
      setAuthed(loggedIn);
      if (loggedIn) setupPush().catch(() => {});
    });

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") clearBadge().catch(() => {});
    });
    return () => { sub.remove(); unsubAuth(); };
  }, []);

  // Auth guard — redirect when auth state changes
  useEffect(() => {
    if (authed === null) return;
    const onLoginScreen = segments[0] === "login";
    if (authed && onLoginScreen) {
      router.replace("/(tabs)");
    } else if (!authed && !onLoginScreen) {
      router.replace("/login");
    }
  }, [authed, segments]);

  async function checkVersion() {
    try {
      const resp = await fetch("https://app.inariwatch.com/api/mobile/version");
      const data = await resp.json();
      if (data.updateRequired || compareVersions(APP_VERSION, data.minVersion) < 0) {
        setUpdateRequired(true);
      }
    } catch {}
  }

  if (updateRequired) {
    return (
      <View style={updateStyles.container}>
        <Text style={updateStyles.emoji}>🔄</Text>
        <Text style={updateStyles.title}>Update Required</Text>
        <Text style={updateStyles.subtitle}>A new version of InariWatch Bot is available.</Text>
        <Pressable
          onPress={() => Linking.openURL("https://app.inariwatch.com/download")}
          style={updateStyles.button}
        >
          <Text style={updateStyles.buttonText}>Download Update</Text>
        </Pressable>
      </View>
    );
  }

  if (authed === null) return null;

  if (locked) {
    return (
      <View style={updateStyles.container}>
        <Text style={updateStyles.emoji}>🔒</Text>
        <Text style={updateStyles.title}>InariWatch</Text>
        <Text style={updateStyles.subtitle}>Autenticacion biometrica requerida</Text>
        <Pressable
          onPress={async () => { const ok = await authenticateBiometric(); setLocked(!ok); }}
          style={updateStyles.button}
        >
          <Text style={updateStyles.buttonText}>Desbloquear</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ThemeProvider value={NAV_THEME}>
    <ErrorBoundary>
    <KeyboardProvider>
    <QueryClientProvider client={queryClient}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <OfflineBanner />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
          navigationBarColor: colors.bg,
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="login" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="alert/[id]" />
        <Stack.Screen name="fix/[id]" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="search" />
        <Stack.Screen name="code-search" />
        <Stack.Screen name="analytics" />
        <Stack.Screen name="pr-risk" />
        <Stack.Screen name="create-monitor" />
        <Stack.Screen name="status" />
      </Stack>
    </QueryClientProvider>
    </KeyboardProvider>
    </ErrorBoundary>
    </ThemeProvider>
  );
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

const updateStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", alignItems: "center", padding: spacing.xl },
  emoji: { fontSize: 48, marginBottom: spacing.md },
  title: { color: colors.fgStrong, fontSize: fontSize.xxl, fontWeight: "700", marginBottom: spacing.sm },
  subtitle: { color: colors.fgDim, fontSize: fontSize.md, textAlign: "center", marginBottom: spacing.xxl },
  button: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  buttonText: { color: colors.fgStrong, fontSize: fontSize.md, fontWeight: "600" },
});
