import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlertDetail, ackAlert, resolveAlert, triggerFix } from "../../lib/api";
import { colors, spacing, fontSize, severityColor, severityBg } from "../../lib/theme";
import { SubstrateView } from "../../components/SubstrateView";
import { CommunityFixCard } from "../../components/CommunityFixCard";

export default function AlertDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data: alert, isLoading } = useQuery({
    queryKey: ["alert", id],
    queryFn: () => fetchAlertDetail(id),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["alerts"] });

  const ackMutation = useMutation({ mutationFn: () => ackAlert(id), onSuccess: invalidate });
  const resolveMutation = useMutation({ mutationFn: () => resolveAlert(id), onSuccess: invalidate });
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={[styles.badge, { backgroundColor: severityBg(alert.severity) }]}>
        <Text style={[styles.badgeText, { color: severityColor(alert.severity) }]}>
          {alert.severity.toUpperCase()}
        </Text>
      </View>
      <Text style={styles.title}>{alert.title}</Text>
      <Text style={styles.meta}>
        {alert.projectName} · {new Date(alert.createdAt).toLocaleString()}
      </Text>
      <Text style={styles.sources}>
        {(alert.sourceIntegrations ?? []).join(", ") || "capture"}
      </Text>

      {/* Body */}
      {alert.body && (
        <Section title="Details">
          <Text style={styles.body}>{alert.body}</Text>
        </Section>
      )}

      {/* AI Diagnosis */}
      {alert.aiReasoning && (
        <Section title="AI Diagnosis">
          <Text style={styles.body}>{alert.aiReasoning}</Text>
        </Section>
      )}

      {/* Substrate */}
      {alert.substrate && (
        <Section title="Substrate I/O">
          <SubstrateView recording={alert.substrate} />
        </Section>
      )}

      {/* Community Fix */}
      {alert.communityFix && (
        <Section title="Community Fix">
          <CommunityFixCard
            fix={alert.communityFix}
            onApply={() => fixMutation.mutate()}
          />
        </Section>
      )}

      {/* Remediation History */}
      {alert.remediations && alert.remediations.length > 0 && (
        <Section title="Remediation History">
          {alert.remediations.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => router.push(`/fix/${s.id}`)}
              style={styles.remCard}
            >
              <View style={styles.remHeader}>
                <Text style={styles.remStatus}>{s.status}</Text>
                <Text style={styles.remTime}>
                  {new Date(s.createdAt).toLocaleDateString()}
                </Text>
              </View>
              {s.confidenceScore != null && (
                <Text style={styles.remConf}>Confidence: {s.confidenceScore}%</Text>
              )}
              {s.prUrl && <Text style={styles.remPr}>PR: {s.prUrl}</Text>}
            </Pressable>
          ))}
        </Section>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        {!alert.isRead && (
          <ActionBtn label="👁️ Ack" color={colors.info} loading={ackMutation.isPending} onPress={() => ackMutation.mutate()} />
        )}
        {!alert.isResolved && (
          <ActionBtn label="✅ Resolve" color={colors.success} loading={resolveMutation.isPending} onPress={() => resolveMutation.mutate()} />
        )}
        <ActionBtn label="🔧 Fix It" color={colors.accent} filled loading={fixMutation.isPending} onPress={() => fixMutation.mutate()} />
      </View>
    </ScrollView>
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

function ActionBtn({ label, color, filled, loading, onPress }: {
  label: string; color: string; filled?: boolean; loading: boolean; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} disabled={loading}
      style={[styles.actionBtn, { borderColor: color }, filled && { backgroundColor: color + "20" }]}>
      <Text style={[styles.actionText, { color }]}>{loading ? "..." : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.bg },
  badge: { alignSelf: "flex-start", paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 6, marginBottom: spacing.sm },
  badgeText: { fontSize: fontSize.xs, fontWeight: "700", letterSpacing: 0.5 },
  title: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "700", lineHeight: 28, marginBottom: spacing.xs },
  meta: { color: colors.fgMuted, fontSize: fontSize.sm, marginBottom: 2 },
  sources: { color: colors.fgMuted, fontSize: fontSize.xs, marginBottom: spacing.xl },
  section: { marginBottom: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm },
  body: { color: colors.fg, fontSize: fontSize.md, lineHeight: 22 },
  remCard: { backgroundColor: colors.surfaceInner, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  remHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  remStatus: { color: colors.fg, fontSize: fontSize.sm, fontWeight: "600", textTransform: "capitalize" },
  remTime: { color: colors.fgMuted, fontSize: fontSize.xs },
  remConf: { color: colors.fgDim, fontSize: fontSize.xs },
  remPr: { color: colors.accent, fontSize: fontSize.xs, marginTop: 2 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.lg },
  actionBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  actionText: { fontSize: fontSize.sm, fontWeight: "600" },
});
