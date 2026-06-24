import { useState, useEffect } from "react";
import { View, Text, ScrollView, RefreshControl, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getStatus, getUptime, getErrorTrends, runHealthCheck, runCheck } from "../lib/api";
import { getToken, clearToken } from "../lib/auth";
import { router } from "expo-router";
import { queryClient } from "../lib/query-client";
import { SkeletonSection } from "../components/Skeleton";
import { useAppStatePolling } from "../lib/use-app-state-polling";
import { ScreenWrapper } from "../components/ScreenWrapper";
import { colors, spacing, fontSize } from "../lib/theme";

export default function StatusScreen() {
  const [token, setTokenState] = useState<string | null>(null);
  const statusPoll = useAppStatePolling(30_000);
  const trendsPoll = useAppStatePolling(60_000);

  useEffect(() => { getToken().then(setTokenState); }, []);

  const { data: statusText, isLoading: statusLoading, refetch: refetchStatus, isRefetching } = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: statusPoll,
    retry: (count, error) => !error?.message?.includes("Session expired") && count < 2,
  });

  const { data: uptimeText } = useQuery({
    queryKey: ["uptime"],
    queryFn: getUptime,
    refetchInterval: statusPoll,
    retry: (count, error) => !error?.message?.includes("Session expired") && count < 2,
  });

  const { data: trendsText } = useQuery({
    queryKey: ["trends"],
    queryFn: () => getErrorTrends(7),
    refetchInterval: trendsPoll,
    retry: (count, error) => !error?.message?.includes("Session expired") && count < 2,
  });

  // Health check (on demand)
  const healthCheck = useMutation({ mutationFn: () => runHealthCheck() });

  // Run check on pull-to-refresh
  const checkMutation = useMutation({
    mutationFn: () => runCheck(),
    onSuccess: () => {
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["uptime"] });
    },
  });

  const handleRefresh = () => {
    checkMutation.mutate();
    refetchStatus();
  };

  // Parse status text for stats
  const openMatch = statusText?.match(/Alerts \(24h\): (\d+)/g);
  const totalAlerts24h = openMatch
    ? openMatch.reduce((sum, m) => sum + parseInt(m.match(/(\d+)/)?.[1] ?? "0"), 0)
    : 0;

  // Parse uptime for overall status
  const allUp = uptimeText?.includes("All systems operational") || uptimeText?.includes("All");

  return (
    <ScreenWrapper title="Status">
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || checkMutation.isPending}
          onRefresh={handleRefresh}
          tintColor={colors.accent}
        />
      }
    >
      {/* Overall Status */}
      <View style={[styles.statusBanner, allUp ? styles.statusUp : styles.statusDown]}>
        <Text style={styles.statusEmoji}>{allUp ? "✅" : "⚠️"}</Text>
        <Text style={[styles.statusLabel, allUp ? styles.statusLabelUp : styles.statusLabelDown]}>
          {allUp ? "Todos los sistemas operativos" : "Degradado"}
        </Text>
      </View>

      {/* Quick Stats */}
      <View style={styles.statsRow}>
        <StatBox label="Alertas (24h)" value={String(totalAlerts24h)} />
        <StatBox
          label="Uptime"
          value={allUp ? "100%" : "—"}
          color={allUp ? colors.success : colors.warning}
        />
      </View>

      {/* Health Check */}
      <Pressable
        onPress={() => healthCheck.mutate()}
        disabled={healthCheck.isPending}
        style={styles.healthBtn}
      >
        {healthCheck.isPending ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : (
          <Text style={styles.healthBtnText}>
            {healthCheck.data ? "Verificar salud de nuevo" : "Verificar salud del sistema"}
          </Text>
        )}
      </Pressable>

      {healthCheck.data && (
        <View style={styles.textBlock}>
          <Text style={styles.monoText}>{healthCheck.data}</Text>
        </View>
      )}

      {/* Uptime Monitors */}
      {uptimeText && (
        <Section title="Monitores de Uptime">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{uptimeText}</Text>
          </View>
        </Section>
      )}

      {/* Error Trends */}
      {trendsText && (
        <Section title="Tendencias de errores (7 dias)">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{trendsText}</Text>
          </View>
        </Section>
      )}

      {/* Projects & Integrations */}
      {statusText && (
        <Section title="Proyectos e Integraciones">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{statusText}</Text>
          </View>
        </Section>
      )}

      {statusLoading && (
        <>
          <SkeletonSection lines={4} />
          <SkeletonSection lines={3} />
          <SkeletonSection lines={2} />
        </>
      )}

      {/* Run check result */}
      {checkMutation.data && (
        <Section title="Resultado del ultimo check">
          <View style={styles.textBlock}>
            <Text style={styles.monoText}>{checkMutation.data}</Text>
          </View>
        </Section>
      )}

      {/* Account */}
      <Section title="Cuenta">
        <View style={styles.textBlock}>
          <Text style={styles.monoText}>
            Token: {token ? `${token.slice(0, 15)}...${token.slice(-6)}` : "NO CONFIGURADO"}
          </Text>
          <Text style={[styles.monoText, { marginTop: 4 }]}>
            Estado: {token ? "Autenticado" : "Sin sesion"}
          </Text>
        </View>
        {token ? (
          <Pressable
            onPress={async () => { queryClient.clear(); await clearToken(); router.replace("/login"); }}
            style={styles.signOutBtn}
          >
            <Text style={styles.signOutText}>Cerrar sesion</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => router.replace("/login")}
            style={styles.signInBtn}
          >
            <Text style={styles.signInText}>Iniciar sesion</Text>
          </Pressable>
        )}
      </Section>
    </ScrollView>
    </ScreenWrapper>
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
  statsRow: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.lg },
  statBox: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg, alignItems: "center",
  },
  statValue: { color: colors.fgStrong, fontSize: fontSize.xxl, fontWeight: "700" },
  statLabel: { color: colors.fgMuted, fontSize: fontSize.xs, marginTop: 4 },
  healthBtn: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.accent, padding: spacing.md, alignItems: "center",
    marginBottom: spacing.lg,
  },
  healthBtnText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: "600" },
  section: { marginBottom: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm },
  textBlock: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  monoText: { color: colors.fg, fontSize: fontSize.sm, fontFamily: "monospace", lineHeight: 20 },
  signOutBtn: { marginTop: 8, backgroundColor: colors.criticalDim, borderRadius: 8, padding: 10, alignItems: "center" },
  signOutText: { color: colors.critical, fontSize: fontSize.sm, fontWeight: "600" },
  signInBtn: { marginTop: 8, backgroundColor: colors.accentDim, borderRadius: 8, padding: 10, alignItems: "center" },
  signInText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: "600" },
});
