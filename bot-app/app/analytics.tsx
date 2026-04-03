import { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { getErrorTrends } from "../lib/api";
import { SkeletonSection } from "../components/Skeleton";
import { ScreenWrapper } from "../components/ScreenWrapper";
import { colors, spacing, fontSize } from "../lib/theme";

const PERIODS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
];

export default function AnalyticsScreen() {
  const [days, setDays] = useState(7);

  const { data: trendsText, isLoading } = useQuery({
    queryKey: ["error-trends", days],
    queryFn: () => getErrorTrends(days),
  });

  // Parse trends text into bars
  const bars = parseTrendBars(trendsText);
  const maxCount = Math.max(...bars.map((b) => b.total), 1);

  return (
    <ScreenWrapper title="Analytics">
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Period selector */}
      <View style={styles.periodRow}>
        {PERIODS.map((p) => (
          <Pressable
            key={p.days}
            onPress={() => setDays(p.days)}
            style={[styles.periodBtn, days === p.days && styles.periodActive]}
          >
            <Text style={[styles.periodText, days === p.days && styles.periodTextActive]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {isLoading ? (
        <>
          <SkeletonSection lines={4} />
          <SkeletonSection lines={3} />
        </>
      ) : (
        <>
          {/* Bar chart */}
          {bars.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>ALERTAS POR DIA</Text>
              <View style={styles.chart}>
                {bars.map((bar, i) => (
                  <View key={i} style={styles.barCol}>
                    <View style={styles.barStack}>
                      {bar.critical > 0 && (
                        <View style={[styles.barSegment, { height: (bar.critical / maxCount) * 120, backgroundColor: colors.critical }]} />
                      )}
                      {bar.warning > 0 && (
                        <View style={[styles.barSegment, { height: (bar.warning / maxCount) * 120, backgroundColor: colors.warning }]} />
                      )}
                      {bar.info > 0 && (
                        <View style={[styles.barSegment, { height: (bar.info / maxCount) * 120, backgroundColor: colors.info }]} />
                      )}
                      {bar.total === 0 && (
                        <View style={[styles.barSegment, { height: 2, backgroundColor: colors.border }]} />
                      )}
                    </View>
                    <Text style={styles.barLabel}>{bar.label}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.legend}>
                <LegendDot color={colors.critical} label="Critical" />
                <LegendDot color={colors.warning} label="Warning" />
                <LegendDot color={colors.info} label="Info" />
              </View>
            </View>
          )}

          {/* Raw text */}
          {trendsText && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>DETALLE</Text>
              <View style={styles.textBlock}>
                <Text style={styles.monoText}>{trendsText}</Text>
              </View>
            </View>
          )}
        </>
      )}
    </ScrollView>
    </ScreenWrapper>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

type Bar = { label: string; critical: number; warning: number; info: number; total: number };

function parseTrendBars(text?: string): Bar[] {
  if (!text) return [];
  const bars: Bar[] = [];
  // Try to parse lines like "2026-03-28: 3 critical, 5 warning, 1 info"
  // or "Mar 28: critical=3, warning=5, info=1"
  const lines = text.split("\n");
  for (const line of lines) {
    const dateMatch = line.match(/(\d{4}-\d{2}-\d{2}|\w{3}\s+\d{1,2})/);
    if (!dateMatch) continue;

    const label = dateMatch[1].includes("-")
      ? dateMatch[1].slice(5) // "03-28"
      : dateMatch[1]; // "Mar 28"

    const critMatch = line.match(/(\d+)\s*critical/i);
    const warnMatch = line.match(/(\d+)\s*warning/i);
    const infoMatch = line.match(/(\d+)\s*info/i);
    const critical = critMatch ? parseInt(critMatch[1]) : 0;
    const warning = warnMatch ? parseInt(warnMatch[1]) : 0;
    const info = infoMatch ? parseInt(infoMatch[1]) : 0;

    bars.push({ label, critical, warning, info, total: critical + warning + info });
  }
  return bars;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  title: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "700", marginBottom: spacing.xs },
  subtitle: { color: colors.fgDim, fontSize: fontSize.sm, marginBottom: spacing.lg },
  periodRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.xl },
  periodBtn: {
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    borderRadius: 8, borderWidth: 1, borderColor: colors.border,
  },
  periodActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  periodText: { color: colors.fgMuted, fontSize: fontSize.sm, fontWeight: "600" },
  periodTextActive: { color: colors.fgStrong },
  section: { marginBottom: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", letterSpacing: 1, marginBottom: spacing.sm },
  chart: { flexDirection: "row", alignItems: "flex-end", gap: 4, height: 150, paddingTop: spacing.md },
  barCol: { flex: 1, alignItems: "center" },
  barStack: { justifyContent: "flex-end", height: 120 },
  barSegment: { width: 16, borderRadius: 2, marginTop: 1 },
  barLabel: { color: colors.fgMuted, fontSize: 9, marginTop: 4 },
  legend: { flexDirection: "row", gap: spacing.lg, marginTop: spacing.md },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { color: colors.fgMuted, fontSize: fontSize.xs },
  textBlock: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  monoText: { color: colors.fg, fontSize: fontSize.xs, fontFamily: "monospace", lineHeight: 18 },
});
