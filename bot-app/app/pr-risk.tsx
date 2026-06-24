import { useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { assessRisk } from "../lib/api";
import { MarkdownText } from "../components/MarkdownText";
import { ScreenWrapper } from "../components/ScreenWrapper";
import { colors, spacing, fontSize } from "../lib/theme";

export default function PRRiskScreen() {
  const [project, setProject] = useState("");
  const [prNumber, setPrNumber] = useState("");

  const riskMut = useMutation({
    mutationFn: () => assessRisk(project.trim(), parseInt(prNumber)),
  });

  const canSubmit = project.trim() && prNumber.trim() && !isNaN(parseInt(prNumber));

  return (
    <ScreenWrapper title="Riesgo de PR">
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      <Text style={styles.label}>Proyecto</Text>
      <TextInput
        style={styles.input}
        value={project}
        onChangeText={setProject}
        placeholder="Slug del proyecto"
        placeholderTextColor={colors.fgMuted}
      />

      <Text style={styles.label}>Numero de PR</Text>
      <TextInput
        style={styles.input}
        value={prNumber}
        onChangeText={setPrNumber}
        placeholder="123"
        placeholderTextColor={colors.fgMuted}
        keyboardType="number-pad"
      />

      <Pressable
        onPress={() => riskMut.mutate()}
        disabled={!canSubmit || riskMut.isPending}
        style={[styles.submitBtn, (!canSubmit || riskMut.isPending) && { opacity: 0.5 }]}
      >
        {riskMut.isPending ? (
          <ActivityIndicator color={colors.fgStrong} size="small" />
        ) : (
          <Text style={styles.submitText}>Analizar riesgo</Text>
        )}
      </Pressable>

      {/* Result */}
      {riskMut.data && (
        <View style={styles.result}>
          <Text style={styles.sectionTitle}>RESULTADO</Text>
          <View style={styles.resultCard}>
            <MarkdownText text={riskMut.data} />
          </View>
        </View>
      )}

      {riskMut.error && (
        <View style={[styles.resultCard, { backgroundColor: colors.criticalDim, marginTop: spacing.lg }]}>
          <Text style={{ color: colors.critical, fontSize: fontSize.sm }}>
            {riskMut.error.message}
          </Text>
        </View>
      )}
    </ScrollView>
    </ScreenWrapper>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  title: { color: colors.fgStrong, fontSize: fontSize.xl, fontWeight: "700", marginBottom: spacing.xs },
  subtitle: { color: colors.fgDim, fontSize: fontSize.sm, marginBottom: spacing.xl, lineHeight: 20 },
  label: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.xs, marginTop: spacing.md },
  input: {
    backgroundColor: colors.surfaceInner, borderRadius: 10,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    color: colors.fg, fontSize: fontSize.md, borderWidth: 1, borderColor: colors.border,
  },
  submitBtn: {
    backgroundColor: colors.accent, borderRadius: 10,
    paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.xl,
  },
  submitText: { color: colors.fgStrong, fontSize: fontSize.md, fontWeight: "600" },
  result: { marginTop: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", letterSpacing: 1, marginBottom: spacing.sm },
  resultCard: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: spacing.lg,
  },
});
