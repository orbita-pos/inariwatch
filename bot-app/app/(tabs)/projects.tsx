import { useCallback } from "react";
import { View, Text, FlatList, Pressable, RefreshControl, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { getStatus, getUptime } from "../../lib/api";
import { SkeletonSection } from "../../components/Skeleton";
import { useAppStatePolling } from "../../lib/use-app-state-polling";
import { colors, spacing, fontSize } from "../../lib/theme";

type ProjectInfo = {
  name: string;
  integrations: string[];
  alerts24h: number;
  isUp: boolean | null;
};

function parseProjects(statusText: string): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  // Split by project blocks — each starts with "## " or "Project: "
  const blocks = statusText.split(/(?=^## |\nProject: )/m);

  for (const block of blocks) {
    const nameMatch = block.match(/^##\s+(.+)|^Project:\s+(.+)/m);
    if (!nameMatch) continue;
    const name = (nameMatch[1] || nameMatch[2]).trim();

    const integrations: string[] = [];
    if (/sentry/i.test(block)) integrations.push("Sentry");
    if (/vercel/i.test(block)) integrations.push("Vercel");
    if (/github/i.test(block)) integrations.push("GitHub");
    if (/datadog/i.test(block)) integrations.push("Datadog");
    if (/capture/i.test(block)) integrations.push("Capture");

    const alertMatch = block.match(/Alerts?\s*\(24h\):\s*(\d+)/i);
    const alerts24h = alertMatch ? parseInt(alertMatch[1]) : 0;

    projects.push({ name, integrations, alerts24h, isUp: null });
  }
  return projects;
}

function parseUptime(uptimeText: string, projects: ProjectInfo[]): ProjectInfo[] {
  return projects.map((p) => {
    const pattern = new RegExp(`${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(up|down|\\u2713|\\u2717)`, "i");
    const match = uptimeText.match(pattern);
    return {
      ...p,
      isUp: match ? /up|✓/i.test(match[1]) : null,
    };
  });
}

export default function ProjectsScreen() {
  const poll = useAppStatePolling(30_000);

  const { data: statusText, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["status"],
    queryFn: getStatus,
    refetchInterval: poll,
  });

  const { data: uptimeText } = useQuery({
    queryKey: ["uptime"],
    queryFn: getUptime,
    refetchInterval: poll,
  });

  const rawProjects = statusText ? parseProjects(statusText) : [];
  const projects = uptimeText ? parseUptime(uptimeText, rawProjects) : rawProjects;

  const renderProject = useCallback(({ item }: { item: ProjectInfo }) => (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/search?project=${encodeURIComponent(item.name)}`)}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.cardName}>{item.name}</Text>
        {item.isUp !== null && (
          <View style={[styles.uptimeDot, item.isUp ? styles.dotUp : styles.dotDown]} />
        )}
      </View>

      {/* Integrations */}
      <View style={styles.intRow}>
        {item.integrations.map((int) => (
          <View key={int} style={styles.intBadge}>
            <Text style={styles.intText}>{int}</Text>
          </View>
        ))}
        {item.integrations.length === 0 && (
          <Text style={styles.noInt}>Sin integraciones</Text>
        )}
      </View>

      {/* Alert count */}
      <View style={styles.cardFooter}>
        <Text style={[
          styles.alertCount,
          item.alerts24h > 0 ? { color: colors.critical } : { color: colors.fgMuted },
        ]}>
          {item.alerts24h} alerta{item.alerts24h !== 1 ? "s" : ""} (24h)
        </Text>
        <Text style={styles.uptimeLabel}>
          {item.isUp === true ? "Online" : item.isUp === false ? "Offline" : "—"}
        </Text>
      </View>
    </Pressable>
  ), []);

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.list}>
          <SkeletonSection lines={3} />
          <SkeletonSection lines={3} />
          <SkeletonSection lines={3} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={projects}
        keyExtractor={(item) => item.name}
        renderItem={renderProject}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.accent} />
        }
        contentContainerStyle={projects.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>📦</Text>
            <Text style={styles.emptyTitle}>Sin proyectos</Text>
            <Text style={styles.emptyText}>Crea un proyecto en app.inariwatch.com</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, paddingBottom: spacing.xxl },
  card: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: spacing.lg, marginBottom: spacing.md,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  cardName: { color: colors.fgStrong, fontSize: fontSize.lg, fontWeight: "700", flex: 1 },
  uptimeDot: { width: 10, height: 10, borderRadius: 5 },
  dotUp: { backgroundColor: colors.success },
  dotDown: { backgroundColor: colors.critical },
  intRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: spacing.md },
  intBadge: { backgroundColor: colors.surfaceInner, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  intText: { color: colors.fgDim, fontSize: fontSize.xs },
  noInt: { color: colors.fgMuted, fontSize: fontSize.xs, fontStyle: "italic" },
  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  alertCount: { fontSize: fontSize.sm, fontWeight: "600" },
  uptimeLabel: { color: colors.fgMuted, fontSize: fontSize.xs },
  emptyContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { alignItems: "center" },
  emptyEmoji: { fontSize: 48, marginBottom: spacing.md },
  emptyTitle: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "600", marginBottom: spacing.xs },
  emptyText: { color: colors.fgMuted, fontSize: fontSize.sm },
});
