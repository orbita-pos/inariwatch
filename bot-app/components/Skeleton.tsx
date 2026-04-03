import { useEffect, useRef } from "react";
import { View, Animated, StyleSheet } from "react-native";
import { colors, spacing } from "../lib/theme";

function usePulse() {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.6, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return opacity;
}

export function SkeletonLine({ width = "100%", height = 14 }: { width?: string | number; height?: number }) {
  const opacity = usePulse();
  return (
    <Animated.View
      style={[styles.line, { width, height, borderRadius: height / 2, opacity }]}
    />
  );
}

export function SkeletonAlertCard() {
  const opacity = usePulse();
  return (
    <Animated.View style={[styles.card, { opacity }]}>
      <View style={styles.cardRow}>
        <View style={[styles.line, { width: 60, height: 20, borderRadius: 4 }]} />
        <View style={[styles.line, { width: 40, height: 12, borderRadius: 4 }]} />
      </View>
      <View style={[styles.line, { width: "85%", height: 16, borderRadius: 4, marginTop: 10 }]} />
      <View style={[styles.line, { width: "60%", height: 12, borderRadius: 4, marginTop: 8 }]} />
      <View style={[styles.line, { width: "95%", height: 12, borderRadius: 4, marginTop: 8 }]} />
    </Animated.View>
  );
}

export function SkeletonSection({ lines = 3 }: { lines?: number }) {
  const opacity = usePulse();
  return (
    <Animated.View style={[styles.section, { opacity }]}>
      {Array.from({ length: lines }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.line,
            {
              width: i === lines - 1 ? "60%" : "100%",
              height: 14,
              borderRadius: 4,
              marginBottom: 8,
            },
          ]}
        />
      ))}
    </Animated.View>
  );
}

export function SkeletonAlertList({ count = 5 }: { count?: number }) {
  return (
    <View style={styles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonAlertCard key={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    backgroundColor: colors.surfaceInner,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  section: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});
