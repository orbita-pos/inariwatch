import { useState, useRef, useCallback } from "react";
import { View, Text, TextInput, FlatList, RefreshControl, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { fetchAlerts } from "../lib/api";
import { AlertCard } from "../components/AlertCard";
import { FilterChips } from "../components/FilterChips";
import { SkeletonAlertList } from "../components/Skeleton";
import { ScreenWrapper } from "../components/ScreenWrapper";
import { colors, spacing, fontSize } from "../lib/theme";
import type { Alert } from "../lib/types";

export default function SearchScreen() {
  const params = useLocalSearchParams<{ project?: string }>();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [severity, setSeverity] = useState<string>("all");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const handleChange = (text: string) => {
    setQuery(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebouncedQuery(text.trim()), 400);
  };

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["search-alerts", severity, debouncedQuery, params.project],
    queryFn: () =>
      fetchAlerts({
        severity: severity === "all" ? undefined : severity,
        limit: 100,
      }),
    enabled: true,
  });

  const alerts = data?.alerts ?? [];
  const filtered = debouncedQuery
    ? alerts.filter((a) => {
        const q = debouncedQuery.toLowerCase();
        return (
          a.title.toLowerCase().includes(q) ||
          a.body?.toLowerCase().includes(q) ||
          a.aiReasoning?.toLowerCase().includes(q) ||
          a.projectName?.toLowerCase().includes(q)
        );
      })
    : params.project
    ? alerts.filter((a) => a.projectName?.toLowerCase() === params.project?.toLowerCase())
    : alerts;

  const renderItem = useCallback(
    ({ item }: { item: Alert }) => <AlertCard alert={item} />,
    []
  );

  return (
    <ScreenWrapper>
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={handleChange}
          placeholder="Buscar por titulo, error, proyecto..."
          placeholderTextColor={colors.fgMuted}
          autoFocus
          returnKeyType="search"
        />
      </View>

      <FilterChips
        selected={severity as "all" | "critical" | "warning" | "info"}
        onSelect={(k) => setSeverity(k)}
      />

      {params.project && (
        <View style={styles.filterTag}>
          <Text style={styles.filterText}>Proyecto: {params.project}</Text>
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.accent} />
        }
        contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          isLoading ? (
            <SkeletonAlertList count={4} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🔍</Text>
              <Text style={styles.emptyTitle}>
                {debouncedQuery ? "Sin resultados" : "Busca alertas"}
              </Text>
              <Text style={styles.emptyText}>
                {debouncedQuery
                  ? `No hay alertas que coincidan con "${debouncedQuery}"`
                  : "Escribe para buscar por titulo, error o proyecto"}
              </Text>
            </View>
          )
        }
      />
    </View>
    </ScreenWrapper>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchRow: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs },
  input: {
    backgroundColor: colors.surfaceInner, borderRadius: 10,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    color: colors.fg, fontSize: fontSize.md, borderWidth: 1, borderColor: colors.border,
  },
  filterTag: {
    marginHorizontal: spacing.lg, marginBottom: spacing.sm,
    backgroundColor: colors.accentDim, borderRadius: 6, paddingHorizontal: spacing.sm, paddingVertical: 4, alignSelf: "flex-start",
  },
  filterText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: "600" },
  list: { paddingBottom: spacing.xxl },
  emptyContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { alignItems: "center", padding: spacing.xl },
  emptyEmoji: { fontSize: 48, marginBottom: spacing.md },
  emptyTitle: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "600", marginBottom: spacing.xs },
  emptyText: { color: colors.fgMuted, fontSize: fontSize.sm, textAlign: "center" },
});
