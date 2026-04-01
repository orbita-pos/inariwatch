import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";
import type { SubstrateRecording } from "../lib/types";

export function SubstrateView({ recording }: { recording: SubstrateRecording }) {
  const categories = recording.categories ?? {};

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.icon}>📼</Text>
        <Text style={styles.title}>Substrate I/O Recording</Text>
      </View>

      <View style={styles.stats}>
        <StatPill label="Events" value={String(recording.eventCount)} />
        <StatPill label="Duration" value={`${recording.durationMs}ms`} />
        <StatPill label="Runtime" value={recording.runtime} />
      </View>

      {Object.keys(categories).length > 0 && (
        <View style={styles.categories}>
          {Object.entries(categories).map(([cat, count]) => (
            <View key={cat} style={styles.catRow}>
              <Text style={styles.catName}>{cat}</Text>
              <Text style={styles.catCount}>{count}</Text>
            </View>
          ))}
        </View>
      )}

      {recording.context && (
        <Text style={styles.context}>{recording.context}</Text>
      )}
    </View>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillValue}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceInner,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  icon: { fontSize: 18 },
  title: { color: colors.fgStrong, fontSize: fontSize.sm, fontWeight: "600" },
  stats: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  pill: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignItems: "center",
  },
  pillValue: { color: colors.fgStrong, fontSize: fontSize.sm, fontWeight: "700" },
  pillLabel: { color: colors.fgMuted, fontSize: fontSize.xs },
  categories: { marginBottom: spacing.md },
  catRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  catName: { color: colors.fgDim, fontSize: fontSize.sm },
  catCount: { color: colors.fg, fontSize: fontSize.sm, fontFamily: "monospace" },
  context: { color: colors.fgDim, fontSize: fontSize.xs, lineHeight: 16, marginTop: spacing.sm },
});
