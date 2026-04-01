import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isLoggedIn } from "../lib/auth";
import { setupNotificationHandler } from "../lib/push";
import { colors } from "../lib/theme";

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

  useEffect(() => {
    isLoggedIn().then(setAuthed);
    setupNotificationHandler();
  }, []);

  if (authed === null) return null; // Loading

  return (
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
  );
}
