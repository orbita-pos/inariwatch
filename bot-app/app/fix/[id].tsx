import { View, Text, ScrollView, Pressable, Alert as RNAlert, StyleSheet, ActivityIndicator, Linking } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRemediation, submitFeedback, verifyRemediation, triggerFix } from "../../lib/api";
import { FixStep } from "../../components/FixStep";
import { DiffView } from "../../components/DiffView";
import { ScreenWrapper } from "../../components/ScreenWrapper";
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
      return 3000;
    },
  });

  // Approve — open PR in browser for review
  const handleApprove = () => {
    if (!session?.prUrl) {
      RNAlert.alert("Sin PR", "Aun no se ha creado el Pull Request.");
      return;
    }
    RNAlert.alert(
      "Revisar PR",
      "Se abrira el Pull Request en tu navegador para revisar y aprobar.",
      [
        { text: "Cancelar", style: "cancel" },
        { text: "Abrir PR", onPress: () => Linking.openURL(session.prUrl) },
      ]
    );
  };

  // Cancel — submit negative feedback + navigate back
  const cancelMutation = useMutation({
    mutationFn: () => submitFeedback(id, false),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["remediation", id] });
      router.back();
    },
  });

  const handleCancel = () => {
    RNAlert.alert(
      "Cancelar remediacion",
      "Esto marcara la remediacion como fallida. Continuar?",
      [
        { text: "No", style: "cancel" },
        { text: "Si, cancelar", style: "destructive", onPress: () => cancelMutation.mutate() },
      ]
    );
  };

  // Retry — trigger fix again for same alert
  const retryMutation = useMutation({
    mutationFn: () => triggerFix(session?.alertId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["remediation", id] }),
  });

  const handleRetry = () => {
    RNAlert.alert(
      "Reintentar",
      "Esto iniciara una nueva remediacion para esta alerta.",
      [
        { text: "Cancelar", style: "cancel" },
        { text: "Reintentar", onPress: () => retryMutation.mutate() },
      ]
    );
  };

  // Feedback — did the fix work?
  const feedbackMutation = useMutation({
    mutationFn: (worked: boolean) => submitFeedback(id, worked),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["remediation", id] }),
  });

  // Verify remediation chain
  const verifyMutation = useMutation({
    mutationFn: () => verifyRemediation(session?.alertId),
  });

  if (isLoading || !session) {
    return (
      <ScreenWrapper title="Progreso del Fix">
        <View style={styles.loading}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      </ScreenWrapper>
    );
  }

  const steps = (session.steps ?? []) as RemediationStep[];
  const isTerminal = TERMINAL_STATUSES.includes(session.status);
  const isProposing = session.status === "proposing";
  const isFailed = session.status === "failed";
  const isCompleted = session.status === "completed";

  const confColor = (session.confidenceScore ?? 0) >= 80 ? colors.success
    : (session.confidenceScore ?? 0) >= 50 ? colors.warning : colors.critical;

  return (
    <ScreenWrapper title="Progreso del Fix">
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
        <Pressable style={styles.prBox} onPress={() => Linking.openURL(session.prUrl)}>
          <Text style={styles.prLabel}>Pull Request</Text>
          <Text style={styles.prUrl}>{session.prUrl}</Text>
        </Pressable>
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

      {/* Actions: Proposing */}
      {isProposing && (
        <View style={styles.actions}>
          <Pressable
            onPress={handleApprove}
            style={[styles.actionBtn, { backgroundColor: colors.successDim, borderColor: colors.success }]}
          >
            <Text style={[styles.actionText, { color: colors.success }]}>Revisar PR</Text>
          </Pressable>
          <Pressable
            onPress={handleCancel}
            disabled={cancelMutation.isPending}
            style={[styles.actionBtn, { borderColor: colors.critical }]}
          >
            <Text style={[styles.actionText, { color: colors.critical }]}>
              {cancelMutation.isPending ? "..." : "Cancelar"}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Actions: Failed */}
      {isFailed && (
        <View style={styles.actions}>
          <Pressable
            onPress={handleRetry}
            disabled={retryMutation.isPending}
            style={[styles.actionBtn, { borderColor: colors.accent, backgroundColor: colors.accentDim }]}
          >
            <Text style={[styles.actionText, { color: colors.accent }]}>
              {retryMutation.isPending ? "Reintentando..." : "Reintentar"}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Feedback: Completed */}
      {isCompleted && !feedbackMutation.isSuccess && (
        <View style={styles.feedbackBox}>
          <Text style={styles.feedbackTitle}>El fix funciono?</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={() => feedbackMutation.mutate(true)}
              disabled={feedbackMutation.isPending}
              style={[styles.actionBtn, { backgroundColor: colors.successDim, borderColor: colors.success }]}
            >
              <Text style={[styles.actionText, { color: colors.success }]}>Si, funciono</Text>
            </Pressable>
            <Pressable
              onPress={() => feedbackMutation.mutate(false)}
              disabled={feedbackMutation.isPending}
              style={[styles.actionBtn, { borderColor: colors.critical }]}
            >
              <Text style={[styles.actionText, { color: colors.critical }]}>No funciono</Text>
            </Pressable>
          </View>
        </View>
      )}

      {feedbackMutation.isSuccess && (
        <View style={[styles.feedbackBox, { backgroundColor: colors.successDim }]}>
          <Text style={{ color: colors.success, fontSize: fontSize.sm, fontWeight: "600" }}>
            Feedback enviado. Gracias!
          </Text>
        </View>
      )}

      {/* Verify chain */}
      {isCompleted && (
        <Pressable
          onPress={() => verifyMutation.mutate()}
          disabled={verifyMutation.isPending}
          style={[styles.verifyBtn, verifyMutation.isPending && { opacity: 0.5 }]}
        >
          <Text style={styles.verifyText}>
            {verifyMutation.isPending ? "Verificando..." : "Verificar cadena de remediacion"}
          </Text>
        </Pressable>
      )}

      {verifyMutation.data && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Verificacion</Text>
          <Text style={styles.body}>{verifyMutation.data}</Text>
        </View>
      )}

      {session.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{session.error}</Text>
        </View>
      )}
    </ScrollView>
    </ScreenWrapper>
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
  feedbackBox: { backgroundColor: colors.surfaceInner, borderRadius: 10, padding: spacing.md, marginTop: spacing.xl },
  feedbackTitle: { color: colors.fgStrong, fontSize: fontSize.md, fontWeight: "600", marginBottom: spacing.xs },
  verifyBtn: { backgroundColor: colors.surfaceInner, borderRadius: 10, padding: spacing.md, marginTop: spacing.lg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  verifyText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: "600" },
  errorBox: { backgroundColor: colors.criticalDim, borderRadius: 10, padding: spacing.md, marginTop: spacing.lg },
  errorText: { color: colors.critical, fontSize: fontSize.sm },
});
