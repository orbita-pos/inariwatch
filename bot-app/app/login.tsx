import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { router } from "expo-router";
import { startDeviceFlow, openVerifyPage, pollForToken } from "../lib/auth";
import { setupPush } from "../lib/push";
import { colors, spacing, fontSize } from "../lib/theme";

export default function LoginScreen() {
  const [status, setStatus] = useState<"idle" | "loading" | "waiting" | "error">("idle");
  const [code, setCode] = useState<string | null>(null);

  const handleLogin = async () => {
    setStatus("loading");
    try {
      const { code: authCode, verifyUrl } = await startDeviceFlow();
      setCode(authCode);
      setStatus("waiting");

      await openVerifyPage(verifyUrl);

      const token = await pollForToken(authCode, () => setStatus("waiting"));
      if (token) {
        await setupPush();
        router.replace("/(tabs)");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.logo}>🦊</Text>
        <Text style={styles.title}>InariWatch Bot</Text>
        <Text style={styles.subtitle}>
          Your production alerts, fixes, and AI diagnosis — right here.
        </Text>

        {status === "idle" && (
          <Pressable onPress={handleLogin} style={styles.button}>
            <Text style={styles.buttonText}>Sign in with InariWatch</Text>
          </Pressable>
        )}

        {status === "loading" && (
          <ActivityIndicator color={colors.accent} size="large" />
        )}

        {status === "waiting" && (
          <View style={styles.waitingBox}>
            {code && (
              <Text style={styles.code}>{code}</Text>
            )}
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.md }} />
            <Text style={styles.waitingText}>
              Approve in your browser...
            </Text>
          </View>
        )}

        {status === "error" && (
          <View>
            <Text style={styles.error}>Authentication failed or timed out.</Text>
            <Pressable onPress={handleLogin} style={[styles.button, { marginTop: spacing.lg }]}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    padding: spacing.xl,
  },
  content: {
    alignItems: "center",
  },
  logo: {
    fontSize: 64,
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.fgStrong,
    fontSize: fontSize.xxl,
    fontWeight: "700",
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.fgDim,
    fontSize: fontSize.md,
    textAlign: "center",
    marginBottom: spacing.xxl,
    lineHeight: 22,
  },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 12,
  },
  buttonText: {
    color: colors.fgStrong,
    fontSize: fontSize.md,
    fontWeight: "600",
  },
  waitingBox: {
    alignItems: "center",
  },
  code: {
    color: colors.accent,
    fontSize: fontSize.xxl,
    fontWeight: "700",
    fontFamily: "monospace",
    letterSpacing: 4,
  },
  waitingText: {
    color: colors.fgDim,
    fontSize: fontSize.sm,
    marginTop: spacing.md,
  },
  error: {
    color: colors.critical,
    fontSize: fontSize.sm,
    textAlign: "center",
  },
});
