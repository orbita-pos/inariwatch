import { useState } from "react";
import {
  View, Text, ScrollView, Pressable, Alert as RNAlert,
  StyleSheet, ActivityIndicator, Linking,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAlertDetail, ackAlert, resolveAlert, triggerFix,
  getRootCause, getBuildLogs, getPostmortem, rollbackVercel,
  searchCommunityFixes, getSubstrateContext, reproduceBug,
} from "../../lib/api";
import { colors, spacing, fontSize, severityColor, severityBg } from "../../lib/theme";
import { SubstrateView } from "../../components/SubstrateView";
import { CommunityFixCard } from "../../components/CommunityFixCard";
import { SkeletonSection } from "../../components/Skeleton";

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

  // ── On-demand MCP tool mutations ──────────────────────────────────────────
  const rootCause = useMutation({ mutationFn: () => getRootCause(id) });
  const buildLogs = useMutation({ mutationFn: () => getBuildLogs({ project: alert?.projectName }) });
  const postmortem = useMutation({ mutationFn: () => getPostmortem(id) });
  const communityFixes = useMutation({ mutationFn: () => searchCommunityFixes(alert?.title ?? "") });
  const substrateCtx = useMutation({ mutationFn: () => getSubstrateContext(id) });
  const bugRepro = useMutation({ mutationFn: () => reproduceBug(id) });

  const handleRollback = () => {
    if (!alert?.projectName) return;
    RNAlert.alert(
      "Rollback Vercel",
      "Esto revertira el deploy a la version anterior. Continuar?",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Revertir",
          style: "destructive",
          onPress: () => rollbackMutation.mutate(),
        },
      ]
    );
  };
  const rollbackMutation = useMutation({
    mutationFn: () => rollbackVercel(alert?.projectName ?? ""),
  });

  if (isLoading || !alert) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <SkeletonSection lines={2} />
        <SkeletonSection lines={4} />
        <SkeletonSection lines={3} />
      </ScrollView>
    );
  }

  const hasVercel = (alert.sourceIntegrations ?? []).some((s) =>
    s.toLowerCase().includes("vercel")
  );

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
        <Section title="Detalles">
          <Text style={styles.body}>{alert.body}</Text>
        </Section>
      )}

      {/* AI Diagnosis */}
      {alert.aiReasoning && (
        <Section title="Diagnostico AI">
          <Text style={styles.body}>{alert.aiReasoning}</Text>
        </Section>
      )}

      {/* Substrate */}
      {alert.substrate && (
        <Section title="Substrate I/O">
          <SubstrateView recording={alert.substrate} />
        </Section>
      )}

      {/* Community Fix (from alert data) */}
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
        <Section title="Historial de Remediaciones">
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

      {/* ── On-demand analysis sections ──────────────────────────────────── */}

      <Text style={[styles.sectionTitle, { marginTop: spacing.lg }]}>ANALISIS AVANZADO</Text>

      {/* Deep Analysis */}
      <ToolSection
        title="Analisis Profundo"
        icon="🧠"
        description="Root cause analysis con AI"
        mutation={rootCause}
      />

      {/* Build Logs (only for Vercel sources) */}
      {hasVercel && (
        <ToolSection
          title="Build Logs"
          icon="📋"
          description="Logs del ultimo deploy de Vercel"
          mutation={buildLogs}
        />
      )}

      {/* Postmortem (only resolved alerts) */}
      {alert.isResolved && (
        <ToolSection
          title="Postmortem"
          icon="📝"
          description="Resumen post-incidente"
          mutation={postmortem}
        />
      )}

      {/* Substrate Context */}
      <ToolSection
        title="Contexto Substrate"
        icon="📼"
        description="HTTP, DB, file ops antes del crash"
        mutation={substrateCtx}
      />

      {/* Bug Reproduction */}
      <ToolSection
        title="Reproducir Bug"
        icon="🔄"
        description="Timeline de I/O recording"
        mutation={bugRepro}
      />

      {/* Community Fix Search */}
      <ToolSection
        title="Buscar Community Fixes"
        icon="🌐"
        description="Soluciones de otros equipos"
        mutation={communityFixes}
      />

      {/* Vercel Rollback */}
      {hasVercel && (
        <View style={styles.toolCard}>
          <Pressable
            onPress={handleRollback}
            disabled={rollbackMutation.isPending}
            style={styles.toolBtn}
          >
            <Text style={styles.toolIcon}>⏪</Text>
            <View style={styles.toolInfo}>
              <Text style={styles.toolTitle}>Rollback Vercel</Text>
              <Text style={styles.toolDesc}>Revertir al deploy anterior</Text>
            </View>
            {rollbackMutation.isPending && (
              <ActivityIndicator color={colors.accent} size="small" />
            )}
          </Pressable>
          {rollbackMutation.data && (
            <View style={styles.toolResult}>
              <Text style={styles.toolResultText}>{rollbackMutation.data}</Text>
            </View>
          )}
          {rollbackMutation.error && (
            <View style={[styles.toolResult, { backgroundColor: colors.criticalDim }]}>
              <Text style={[styles.toolResultText, { color: colors.critical }]}>
                {rollbackMutation.error.message}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Primary Actions */}
      <View style={styles.actions}>
        {!alert.isRead && (
          <ActionBtn label="Reconocer" color={colors.info} loading={ackMutation.isPending} onPress={() => ackMutation.mutate()} />
        )}
        {!alert.isResolved && (
          <ActionBtn label="Resolver" color={colors.success} loading={resolveMutation.isPending} onPress={() => resolveMutation.mutate()} />
        )}
        <ActionBtn label="Fix It" color={colors.accent} filled loading={fixMutation.isPending} onPress={() => fixMutation.mutate()} />
      </View>
    </ScrollView>
  );
}

// ── Reusable tool section (load on demand) ──────────────────────────────────

function ToolSection({ title, icon, description, mutation }: {
  title: string;
  icon: string;
  description: string;
  mutation: { mutate: () => void; isPending: boolean; data?: string; error: Error | null };
}) {
  return (
    <View style={styles.toolCard}>
      <Pressable
        onPress={() => { if (!mutation.data) mutation.mutate(); }}
        disabled={mutation.isPending}
        style={styles.toolBtn}
      >
        <Text style={styles.toolIcon}>{icon}</Text>
        <View style={styles.toolInfo}>
          <Text style={styles.toolTitle}>{title}</Text>
          <Text style={styles.toolDesc}>{description}</Text>
        </View>
        {mutation.isPending && (
          <ActivityIndicator color={colors.accent} size="small" />
        )}
        {mutation.data && <Text style={styles.toolLoaded}>✓</Text>}
      </Pressable>
      {mutation.data && (
        <View style={styles.toolResult}>
          <Text style={styles.toolResultText}>{mutation.data}</Text>
        </View>
      )}
      {mutation.error && (
        <View style={[styles.toolResult, { backgroundColor: colors.criticalDim }]}>
          <Text style={[styles.toolResultText, { color: colors.critical }]}>
            {mutation.error.message}
          </Text>
        </View>
      )}
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xl },
  actionBtn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  actionText: { fontSize: fontSize.sm, fontWeight: "600" },
  // Tool sections
  toolCard: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm, overflow: "hidden" },
  toolBtn: { flexDirection: "row", alignItems: "center", padding: spacing.md, gap: spacing.md },
  toolIcon: { fontSize: 20 },
  toolInfo: { flex: 1 },
  toolTitle: { color: colors.fgStrong, fontSize: fontSize.sm, fontWeight: "600" },
  toolDesc: { color: colors.fgMuted, fontSize: fontSize.xs },
  toolLoaded: { color: colors.success, fontSize: fontSize.sm },
  toolResult: { backgroundColor: colors.surfaceInner, padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, maxHeight: 300 },
  toolResultText: { color: colors.fg, fontSize: fontSize.xs, fontFamily: "monospace", lineHeight: 18 },
});
