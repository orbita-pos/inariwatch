import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";
import type { RemediationStep } from "../lib/types";

export function FixStep({ step, isLast }: { step: RemediationStep; isLast: boolean }) {
  const icon =
    step.status === "completed" ? "✅" :
    step.status === "failed" ? "❌" : null;

  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`Paso ${step.type}: ${step.message}, estado ${step.status}`}
    >
      <View style={styles.timeline}>
        <View style={[styles.dot, step.status === "running" && styles.dotRunning]}>
          {step.status === "running" ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : (
            <Text style={styles.icon}>{icon}</Text>
          )}
        </View>
        {!isLast && <View style={styles.line} />}
      </View>

      <View style={styles.content}>
        <Text style={[
          styles.message,
          step.status === "failed" && styles.messageFailed,
        ]}>
          {step.message}
        </Text>
        <Text style={styles.time}>
          {new Date(step.timestamp).toLocaleTimeString()}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    minHeight: 48,
  },
  timeline: {
    width: 32,
    alignItems: "center",
  },
  dot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.surfaceInner,
    justifyContent: "center",
    alignItems: "center",
  },
  dotRunning: {
    backgroundColor: colors.accentDim,
  },
  icon: { fontSize: 12 },
  line: {
    width: 2,
    flex: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  content: {
    flex: 1,
    paddingLeft: spacing.sm,
    paddingBottom: spacing.md,
  },
  message: {
    color: colors.fg,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  messageFailed: {
    color: colors.critical,
  },
  time: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
});
