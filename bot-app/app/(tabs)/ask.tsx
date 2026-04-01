import { View, Text, StyleSheet } from "react-native";
import { colors, fontSize } from "../../lib/theme";

export default function AskScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>🧠</Text>
      <Text style={styles.title}>Ask Inari</Text>
      <Text style={styles.subtitle}>Coming in Sprint 3</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", alignItems: "center" },
  emoji: { fontSize: 48, marginBottom: 12 },
  title: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "600", marginBottom: 4 },
  subtitle: { color: colors.fgMuted, fontSize: fontSize.sm },
});
