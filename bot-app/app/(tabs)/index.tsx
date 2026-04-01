import { useState, useCallback } from "react";
import { View, FlatList, Text, RefreshControl, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchAlerts, ackAlert, resolveAlert } from "../../lib/api";
import { AlertCard } from "../../components/AlertCard";
import { FilterChips } from "../../components/FilterChips";
import { colors, spacing, fontSize } from "../../lib/theme";
import type { Alert } from "../../lib/types";

export default function FeedScreen() {
  const [severity, setSeverity] = useState<string>("all");

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["alerts", severity],
    queryFn: () =>
      fetchAlerts({
        severity: severity === "all" ? undefined : severity,
        limit: 50,
      }),
    refetchInterval: 10_000, // Poll every 10s
  });

  const alerts = data?.alerts ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  const renderItem = useCallback(
    ({ item }: { item: Alert }) => <AlertCard alert={item} />,
    []
  );

  return (
    <View style={styles.container}>
      <FilterChips
        selected={severity as "all" | "critical" | "warning" | "info"}
        onSelect={(k) => setSeverity(k)}
      />

      {unreadCount > 0 && (
        <View style={styles.unreadBanner}>
          <Text style={styles.unreadText}>
            {unreadCount} unread alert{unreadCount !== 1 ? "s" : ""}
          </Text>
        </View>
      )}

      <FlatList
        data={alerts}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.accent}
          />
        }
        contentContainerStyle={alerts.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          isLoading ? (
            <Text style={styles.emptyText}>Loading...</Text>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>✅</Text>
              <Text style={styles.emptyTitle}>All clear</Text>
              <Text style={styles.emptyText}>No unresolved alerts</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  list: {
    paddingBottom: spacing.xxl,
  },
  unreadBanner: {
    backgroundColor: colors.accentDim,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  unreadText: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  empty: {
    alignItems: "center",
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    color: colors.fgStrong,
    fontSize: fontSize.xl,
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  emptyText: {
    color: colors.fgMuted,
    fontSize: fontSize.sm,
  },
});
