import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { colors, fontSize } from "../../lib/theme";

export default function FixProgressScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>🔧</Text>
      <Text style={styles.title}>Fix Progress</Text>
      <Text style={styles.subtitle}>Session: {id?.slice(0, 12)}</Text>
      <Text style={styles.note}>Full implementation in Sprint 2</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", alignItems: "center" },
  emoji: { fontSize: 48, marginBottom: 12 },
  title: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "600", marginBottom: 4 },
  subtitle: { color: colors.fgDim, fontSize: fontSize.sm, fontFamily: "monospace", marginBottom: 12 },
  note: { color: colors.fgMuted, fontSize: fontSize.xs },
});
