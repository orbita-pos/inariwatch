import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warning" },
  { key: "info", label: "Info" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

export function FilterChips({
  selected,
  onSelect,
}: {
  selected: FilterKey;
  onSelect: (key: FilterKey) => void;
}) {
  return (
    <View style={styles.container}>
      {FILTERS.map((f) => (
        <Pressable
          key={f.key}
          onPress={() => onSelect(f.key)}
          style={[styles.chip, selected === f.key && styles.chipActive]}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Filtrar por ${f.label}`}
          accessibilityState={{ selected: selected === f.key }}
        >
          <Text
            style={[styles.label, selected === f.key && styles.labelActive]}
          >
            {f.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 20,
    backgroundColor: colors.surfaceInner,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentDim,
    borderColor: colors.accent,
  },
  label: {
    color: colors.fgMuted,
    fontSize: fontSize.sm,
    fontWeight: "500",
  },
  labelActive: {
    color: colors.accent,
  },
});
