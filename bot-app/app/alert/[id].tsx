import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlertDetail, ackAlert, resolveAlert, triggerFix } from "../../lib/api";
import { colors, spacing, fontSize, severityColor, severityBg } from "../../lib/theme";
import { router } from "expo-router";

export default function AlertDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data: alert, isLoading } = useQuery({
    queryKey: ["alert", id],
    queryFn: () => fetchAlertDetail(id),
  });

  const ackMutation = useMutation({
    mutationFn: () => ackAlert(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const resolveMutation = useMutation({
    mutationFn: () => resolveAlert(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const fixMutation = useMutation({
    mutationFn: () => triggerFix(id),
    onSuccess: (result) => {
      try {
        const data = JSON.parse(result);
        if (data.session_id) router.push(`/fix/${data.session_id}`);
      } catch {}
    },
  });

  if (isLoading || !alert) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const sevColor = severityColor(alert.severity);
  const sevBg = severityBg(alert.severity);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={[styles.badge, { backgroundColor: sevBg }]}>
        <Text style={[styles.badgeText, { color: sevColor }]}>
          {alert.severity.toUpperCase()}
        </Text>
      </View>
      <Text style={styles.title}>{alert.title}</Text>
      <Text style={styles.meta}>
        {alert.projectName} · {new Date(alert.createdAt).toLocaleString()}
      </Text>

      {/* Body */}
      {alert.body && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Details</Text>
          <Text style={styles.body}>{alert.body}</Text>
        </View>
      )}

      {/* AI Diagnosis */}
      {alert.aiReasoning && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>AI Diagnosis</Text>
          <Text style={styles.body}>{alert.aiReasoning}</Text>
        </View>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        {!alert.isRead && (
          <Pressable
            onPress={() => ackMutation.mutate()}
            style={[styles.actionBtn, { borderColor: colors.info }]}
          >
            <Text style={[styles.actionText, { color: colors.info }]}>
              {ackMutation.isPending ? "..." : "👁️ Acknowledge"}
            </Text>
          </Pressable>
        )}
        {!alert.isResolved && (
          <Pressable
            onPress={() => resolveMutation.mutate()}
            style={[styles.actionBtn, { borderColor: colors.success }]}
          >
            <Text style={[styles.actionText, { color: colors.success }]}>
              {resolveMutation.isPending ? "..." : "✅ Resolve"}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => fixMutation.mutate()}
          style={[styles.actionBtn, { borderColor: colors.accent, backgroundColor: colors.accentDim }]}
        >
          <Text style={[styles.actionText, { color: colors.accent }]}>
            {fixMutation.isPending ? "Starting..." : "🔧 Fix It"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.bg },
  badge: { alignSelf: "flex-start", paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 6, marginBottom: spacing.sm },
  badgeText: { fontSize: fontSize.xs, fontWeight: "700", letterSpacing: 0.5 },
  title: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "700", lineHeight: 28, marginBottom: spacing.xs },
  meta: { color: colors.fgMuted, fontSize: fontSize.sm, marginBottom: spacing.xl },
  section: { marginBottom: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm },
  body: { color: colors.fg, fontSize: fontSize.md, lineHeight: 22 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.lg },
  actionBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  actionText: { fontSize: fontSize.sm, fontWeight: "600" },
});
