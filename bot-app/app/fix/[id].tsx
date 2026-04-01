import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRemediation, callMcpTool } from "../../lib/api";
import { FixStep } from "../../components/FixStep";
import { DiffView } from "../../components/DiffView";
import { colors, spacing, fontSize } from "../../lib/theme";
import type { RemediationStep } from "../../lib/types";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

export default function FixProgressScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data: session, isLoading } = useQuery({
    queryKey: ["remediation", id],
    queryFn: () => fetchRemediation(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.includes(status)) return false;
      return 3000; // Poll every 3s while active
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => callMcpTool("silence_alert", { alert_id: session?.alertId, resolve: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["remediation", id] }),
  });

  if (isLoading || !session) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const steps = (session.steps ?? []) as RemediationStep[];
  const isTerminal = TERMINAL_STATUSES.includes(session.status);
  const isProposing = session.status === "proposing";
  const isFailed = session.status === "failed";

  const confColor = (session.confidenceScore ?? 0) >= 80 ? colors.success
    : (session.confidenceScore ?? 0) >= 50 ? colors.warning : colors.critical;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.projectName}>{session.projectName}</Text>
        <View style={[styles.statusBadge, isTerminal && (isFailed ? styles.statusFailed : styles.statusDone)]}>
          <Text style={styles.statusText}>{session.status}</Text>
        </View>
      </View>

      {/* Confidence */}
      {session.confidenceScore != null && (
        <View style={styles.confBox}>
          <Text style={styles.confLabel}>Confidence</Text>
          <Text style={[styles.confValue, { color: confColor }]}>
            {session.confidenceScore}%
          </Text>
        </View>
      )}

      {/* PR Link */}
      {session.prUrl && (
        <View style={styles.prBox}>
          <Text style={styles.prLabel}>Pull Request</Text>
          <Text style={styles.prUrl}>{session.prUrl}</Text>
        </View>
      )}

      {/* Timeline */}
      <Text style={styles.sectionTitle}>Progress</Text>
      <View style={styles.timeline}>
        {steps.map((step, i) => (
          <FixStep key={step.id || i} step={step} isLast={i === steps.length - 1} />
        ))}
      </View>

      {!isTerminal && steps.length === 0 && (
        <View style={styles.waitingBox}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.waitingText}>Starting remediation...</Text>
        </View>
      )}

      {/* File Changes */}
      {session.fileChanges && (
        <View style={styles.section}>
          <DiffView changes={session.fileChanges as { path: string; content?: string }[]} />
        </View>
      )}

      {/* Self Review */}
      {session.selfReviewResult && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Self Review</Text>
          <Text style={styles.body}>
            {typeof session.selfReviewResult === "string"
              ? session.selfReviewResult
              : JSON.stringify(session.selfReviewResult, null, 2)}
          </Text>
        </View>
      )}

      {/* Actions */}
      {isProposing && (
        <View style={styles.actions}>
          <Pressable
            onPress={() => approveMutation.mutate()}
            style={[styles.actionBtn, { backgroundColor: colors.successDim, borderColor: colors.success }]}
          >
            <Text style={[styles.actionText, { color: colors.success }]}>
              {approveMutation.isPending ? "..." : "✅ Approve & Merge"}
            </Text>
          </Pressable>
          <Pressable style={[styles.actionBtn, { borderColor: colors.critical }]}>
            <Text style={[styles.actionText, { color: colors.critical }]}>❌ Cancel</Text>
          </Pressable>
        </View>
      )}

      {isFailed && (
        <View style={styles.actions}>
          <Pressable style={[styles.actionBtn, { borderColor: colors.accent, backgroundColor: colors.accentDim }]}>
            <Text style={[styles.actionText, { color: colors.accent }]}>🔄 Retry</Text>
          </Pressable>
        </View>
      )}

      {session.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{session.error}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.bg },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  projectName: { color: colors.fgStrong, fontSize: fontSize.lg, fontWeight: "600" },
  statusBadge: { backgroundColor: colors.accentDim, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: 6 },
  statusDone: { backgroundColor: colors.successDim },
  statusFailed: { backgroundColor: colors.criticalDim },
  statusText: { color: colors.fg, fontSize: fontSize.xs, fontWeight: "600", textTransform: "capitalize" },
  confBox: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  confLabel: { color: colors.fgMuted, fontSize: fontSize.sm },
  confValue: { fontSize: fontSize.xl, fontWeight: "700" },
  prBox: { backgroundColor: colors.surfaceInner, borderRadius: 8, padding: spacing.md, marginBottom: spacing.lg },
  prLabel: { color: colors.fgMuted, fontSize: fontSize.xs, marginBottom: 4 },
  prUrl: { color: colors.accent, fontSize: fontSize.sm },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm },
  timeline: { marginBottom: spacing.xl },
  waitingBox: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.xl },
  waitingText: { color: colors.fgDim, fontSize: fontSize.sm },
  section: { marginBottom: spacing.xl },
  body: { color: colors.fg, fontSize: fontSize.sm, lineHeight: 20, fontFamily: "monospace" },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  actionBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flex: 1, alignItems: "center" },
  actionText: { fontSize: fontSize.sm, fontWeight: "600" },
  errorBox: { backgroundColor: colors.criticalDim, borderRadius: 10, padding: spacing.md, marginTop: spacing.lg },
  errorText: { color: colors.critical, fontSize: fontSize.sm },
});
