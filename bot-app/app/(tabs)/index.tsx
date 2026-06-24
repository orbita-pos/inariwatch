import { useState, useCallback, useRef, useEffect } from "react";
import { View, FlatList, Text, TextInput, RefreshControl, ActivityIndicator, StyleSheet } from "react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchAlerts } from "../../lib/api";
import { updateBadgeCount } from "../../lib/push";
import { AlertCard } from "../../components/AlertCard";
import { FilterChips } from "../../components/FilterChips";
import { SkeletonAlertList } from "../../components/Skeleton";
import { useAppStatePolling } from "../../lib/use-app-state-polling";
import { colors, spacing, fontSize } from "../../lib/theme";
import type { Alert } from "../../lib/types";

const PAGE_SIZE = 25;

export default function FeedScreen() {
  const [severity, setSeverity] = useState<string>("all");
  const [search, setSearch] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const pollInterval = useAppStatePolling(10_000);

  const handleSearch = (text: string) => {
    setSearch(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(text.trim()), 400);
  };

  const {
    data,
    isLoading,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["alerts", severity, debouncedSearch],
    queryFn: ({ pageParam = 0 }) =>
      fetchAlerts({
        severity: severity === "all" ? undefined : severity,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.alerts.length, 0);
      return lastPage.alerts.length === PAGE_SIZE ? loaded : undefined;
    },
    refetchInterval: pollInterval,
  });

  const alerts = data?.pages.flatMap((p) => p.alerts) ?? [];
  const unreadCount = data?.pages[0]?.unreadCount ?? 0;

  // Sync badge count with unread alerts
  useEffect(() => {
    updateBadgeCount(unreadCount).catch(() => {});
  }, [unreadCount]);

  // Filter by search text client-side (REST doesn't support text search)
  const filtered = debouncedSearch
    ? alerts.filter(
        (a) =>
          a.title.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
          a.aiReasoning?.toLowerCase().includes(debouncedSearch.toLowerCase())
      )
    : alerts;

  const renderItem = useCallback(
    ({ item }: { item: Alert }) => <AlertCard alert={item} />,
    []
  );

  const loadMore = () => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  };

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={handleSearch}
          placeholder="Buscar alertas..."
          placeholderTextColor={colors.fgMuted}
          returnKeyType="search"
        />
      </View>

      <FilterChips
        selected={severity as "all" | "critical" | "warning" | "info"}
        onSelect={(k) => setSeverity(k)}
      />

      {unreadCount > 0 && (
        <View style={styles.unreadBanner}>
          <Text style={styles.unreadText}>
            {unreadCount} alerta{unreadCount !== 1 ? "s" : ""} sin leer
          </Text>
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching && !isFetchingNextPage}
            onRefresh={refetch}
            tintColor={colors.accent}
          />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.list}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.accent} size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          isLoading ? (
            <SkeletonAlertList count={5} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>
                {debouncedSearch ? "🔍" : "✅"}
              </Text>
              <Text style={styles.emptyTitle}>
                {debouncedSearch ? "Sin resultados" : "Todo limpio"}
              </Text>
              <Text style={styles.emptyText}>
                {debouncedSearch
                  ? `No hay alertas que coincidan con "${debouncedSearch}"`
                  : "No hay alertas sin resolver"}
              </Text>
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
  searchRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  searchInput: {
    backgroundColor: colors.surfaceInner,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.fg,
    fontSize: fontSize.md,
    borderWidth: 1,
    borderColor: colors.border,
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
  footer: {
    paddingVertical: spacing.lg,
    alignItems: "center",
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
    textAlign: "center",
    paddingHorizontal: spacing.xl,
  },
});
