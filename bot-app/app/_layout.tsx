import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar, View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { isLoggedIn } from "../lib/auth";
import { setupNotificationHandler, setupPush } from "../lib/push";
import { colors, spacing, fontSize } from "../lib/theme";

const APP_VERSION = "1.0.0";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 2,
    },
  },
});

export default function RootLayout() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => {
    isLoggedIn().then((loggedIn) => {
      setAuthed(loggedIn);
      if (loggedIn) setupPush();
    });
    setupNotificationHandler();
    checkVersion();
  }, []);

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

  return (
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
    <QueryClientProvider client={queryClient}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      >
        {!authed ? (
          <Stack.Screen name="login" />
        ) : (
          <>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="alert/[id]"
              options={{ headerShown: true, headerTitle: "Alert", headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.fgStrong }}
            />
            <Stack.Screen
              name="fix/[id]"
              options={{ headerShown: true, headerTitle: "Fix Progress", headerStyle: { backgroundColor: colors.surface }, headerTintColor: colors.fgStrong }}
            />
          </>
        )}
      </Stack>
    </QueryClientProvider>
    </KeyboardProvider>
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
