import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";
import type { CommunityFix } from "../lib/types";

export function CommunityFixCard({
  fix,
  onApply,
}: {
  fix: CommunityFix;
  onApply: () => void;
}) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.icon}>💡</Text>
        <Text style={styles.title}>Community Fix Available</Text>
      </View>

      <View style={styles.stats}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{fix.successRate}%</Text>
          <Text style={styles.statLabel}>success</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{fix.totalApplications}</Text>
          <Text style={styles.statLabel}>teams</Text>
        </View>
      </View>

      <Text style={styles.approach}>{fix.fixApproach}</Text>
      {fix.fixDescription && (
        <Text style={styles.description}>{fix.fixDescription}</Text>
      )}

      <Pressable onPress={onApply} style={styles.applyBtn}>
        <Text style={styles.applyText}>Apply This Fix</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.accentDim,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  icon: { fontSize: 18 },
  title: { color: colors.accent, fontSize: fontSize.sm, fontWeight: "600" },
  stats: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  statBox: { alignItems: "center" },
  statValue: { color: colors.fgStrong, fontSize: fontSize.lg, fontWeight: "700" },
  statLabel: { color: colors.fgMuted, fontSize: fontSize.xs },
  approach: { color: colors.fg, fontSize: fontSize.sm, fontWeight: "500", marginBottom: spacing.xs },
  description: { color: colors.fgDim, fontSize: fontSize.sm, lineHeight: 18, marginBottom: spacing.md },
  applyBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  applyText: { color: colors.fgStrong, fontSize: fontSize.sm, fontWeight: "600" },
});
