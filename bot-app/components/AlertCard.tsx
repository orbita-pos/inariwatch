import { View, Text, Pressable, StyleSheet } from "react-native";
import { router } from "expo-router";
import { colors, spacing, fontSize, severityColor, severityBg } from "../lib/theme";
import { hapticLight } from "../lib/haptics";
import type { Alert } from "../lib/types";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function AlertCard({ alert }: { alert: Alert }) {
  const color = severityColor(alert.severity);
  const bg = severityBg(alert.severity);

  return (
    <Pressable
      onPress={() => { hapticLight(); router.push(`/alert/${alert.id}`); }}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Alerta ${alert.severity}: ${alert.title}`}
      accessibilityHint="Toca para ver detalles"
      accessibilityState={{ selected: !alert.isRead }}
    >
      <View style={styles.row}>
        <View style={[styles.badge, { backgroundColor: bg }]}>
          <Text style={[styles.badgeText, { color }]}>
            {alert.severity.toUpperCase()}
          </Text>
        </View>
        {!alert.isRead && <View style={styles.unreadDot} />}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {alert.title}
      </Text>

      <View style={styles.meta}>
        {alert.projectName && (
          <Text style={styles.metaText}>{alert.projectName}</Text>
        )}
        <Text style={styles.metaText}>·</Text>
        <Text style={styles.metaText}>{timeAgo(alert.createdAt)}</Text>
        {alert.sourceIntegrations?.length > 0 && (
          <>
            <Text style={styles.metaText}>·</Text>
            <Text style={styles.metaText}>
              {alert.sourceIntegrations.join(", ")}
            </Text>
          </>
        )}
      </View>

      {alert.aiReasoning && (
        <Text style={styles.reasoning} numberOfLines={2}>
          {alert.aiReasoning}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  pressed: {
    opacity: 0.7,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: fontSize.xs,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  title: {
    color: colors.fgStrong,
    fontSize: fontSize.md,
    fontWeight: "600",
    lineHeight: 22,
    marginBottom: spacing.xs,
  },
  meta: {
    flexDirection: "row",
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  metaText: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
  },
  reasoning: {
    color: colors.fgDim,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
    lineHeight: 18,
  },
});
