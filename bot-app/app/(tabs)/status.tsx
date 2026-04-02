import { useState, useEffect } from "react";
import { View, Text, ScrollView, RefreshControl, Pressable, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getStatus, getUptime, getErrorTrends } from "../../lib/api";
import { getToken, clearToken } from "../../lib/auth";
import { router } from "expo-router";
import { colors, spacing, fontSize } from "../../lib/theme";

export default function StatusScreen() {
  const [token, setTokenState] = useState<string | null>(null);

  useEffect(() => {
    getToken().then(setTokenState);
  }, []);
  const { data: statusText, isLoading: statusLoading, refetch: refetchStatus, isRefetching, error: statusError } = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: 30_000,
    retry: (count, error) => !error?.message?.includes("Session expired") && count < 2,
  });

  const { data: uptimeText } = useQuery({
    queryKey: ["uptime"],
    queryFn: getUptime,
    refetchInterval: 30_000,
    retry: (count, error) => !error?.message?.includes("Session expired") && count < 2,
  });

  const { data: trendsText } = useQuery({
    queryKey: ["trends"],
    queryFn: () => getErrorTrends(7),
    refetchInterval: 60_000,
    retry: (count, error) => !error?.message?.includes("Session expired") && count < 2,
  });

  // Parse status text for stats
  const openMatch = statusText?.match(/Alerts \(24h\): (\d+)/g);
  const totalAlerts24h = openMatch
    ? openMatch.reduce((sum, m) => sum + parseInt(m.match(/(\d+)/)?.[1] ?? "0"), 0)
    : 0;

  // Parse uptime for overall status
  const allUp = uptimeText?.includes("All systems operational") || uptimeText?.includes("✓ All");

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetchStatus} tintColor={colors.accent} />
      }
    >
      {/* Overall Status */}
      <View style={[styles.statusBanner, allUp ? styles.statusUp : styles.statusDown]}>
        <Text style={styles.statusEmoji}>{allUp ? "✅" : "⚠️"}</Text>
        <Text style={[styles.statusLabel, allUp ? styles.statusLabelUp : styles.statusLabelDown]}>
          {allUp ? "All Systems Operational" : "Degraded"}
        </Text>
      </View>

      {/* Quick Stats */}
      <View style={styles.statsRow}>
        <StatBox label="Alerts (24h)" value={String(totalAlerts24h)} />
        <StatBox
          label="Uptime"
          value={allUp ? "100%" : "—"}
          color={allUp ? colors.success : colors.warning}
        />
      </View>

      {/* Uptime Monitors */}
      {uptimeText && (
        <Section title="Uptime Monitors">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{uptimeText}</Text>
          </View>
        </Section>
      )}

      {/* Error Trends */}
      {trendsText && (
        <Section title="Error Trends (7 days)">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{trendsText}</Text>
          </View>
        </Section>
      )}

      {/* Projects & Integrations */}
      {statusText && (
        <Section title="Projects & Integrations">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{statusText}</Text>
          </View>
        </Section>
      )}

      {statusLoading && (
        <Text style={styles.loadingText}>Loading...</Text>
      )}

      {/* Account debug */}
      <Section title="Account">
        <View style={styles.textBlock}>
          <Text style={styles.monoText}>
            Token: {token ? `${token.slice(0, 15)}...${token.slice(-6)}` : "NOT SET"}
          </Text>
          <Text style={[styles.monoText, { marginTop: 4 }]}>
            Status: {token ? "Authenticated" : "Not logged in"}
          </Text>
        </View>
        {token ? (
          <Pressable
            onPress={async () => { await clearToken(); router.replace("/login"); }}
            style={{ marginTop: 8, backgroundColor: colors.criticalDim, borderRadius: 8, padding: 10, alignItems: "center" }}
          >
            <Text style={{ color: colors.critical, fontSize: fontSize.sm, fontWeight: "600" }}>Sign out</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => router.replace("/login")}
            style={{ marginTop: 8, backgroundColor: colors.accentDim, borderRadius: 8, padding: 10, alignItems: "center" }}
          >
            <Text style={{ color: colors.accent, fontSize: fontSize.sm, fontWeight: "600" }}>Sign in</Text>
          </Pressable>
        )}
      </Section>
    </ScrollView>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  statusBanner: { borderRadius: 12, padding: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.lg },
  statusUp: { backgroundColor: colors.successDim, borderWidth: 1, borderColor: colors.success },
  statusDown: { backgroundColor: colors.warningDim, borderWidth: 1, borderColor: colors.warning },
  statusEmoji: { fontSize: 24 },
  statusLabel: { fontSize: fontSize.lg, fontWeight: "700" },
  statusLabelUp: { color: colors.success },
  statusLabelDown: { color: colors.warning },
  statsRow: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.xl },
  statBox: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg, alignItems: "center",
  },
  statValue: { color: colors.fgStrong, fontSize: fontSize.xxl, fontWeight: "700" },
  statLabel: { color: colors.fgMuted, fontSize: fontSize.xs, marginTop: 4 },
  section: { marginBottom: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm },
  textBlock: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  monoText: { color: colors.fg, fontSize: fontSize.sm, fontFamily: "monospace", lineHeight: 20 },
  loadingText: { color: colors.fgMuted, fontSize: fontSize.sm, textAlign: "center", marginTop: spacing.xl },
});
