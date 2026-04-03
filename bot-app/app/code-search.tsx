import { useState, useRef } from "react";
import { View, Text, TextInput, ScrollView, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { searchCodebase, reindexCodebase } from "../lib/api";
import { ScreenWrapper } from "../components/ScreenWrapper";
import { colors, spacing, fontSize } from "../lib/theme";

export default function CodeSearchScreen() {
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");

  const searchMut = useMutation({
    mutationFn: () => searchCodebase(query, project || undefined, 5),
  });

  const reindexMut = useMutation({
    mutationFn: () => reindexCodebase(project),
  });

  const handleSearch = () => {
    if (query.trim().length < 2) return;
    searchMut.mutate();
  };

  return (
    <ScreenWrapper>
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Buscar en codigo</Text>
      <Text style={styles.subtitle}>
        Busqueda hibrida (vector + keyword) en el codebase indexado
      </Text>

      {/* Query input */}
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Error, funcion, concepto..."
        placeholderTextColor={colors.fgMuted}
        onSubmitEditing={handleSearch}
        returnKeyType="search"
      />

      {/* Project filter (optional) */}
      <TextInput
        style={[styles.input, { marginTop: spacing.sm }]}
        value={project}
        onChangeText={setProject}
        placeholder="Proyecto (opcional)"
        placeholderTextColor={colors.fgMuted}
      />

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable
          onPress={handleSearch}
          disabled={searchMut.isPending || query.trim().length < 2}
          style={[styles.searchBtn, (searchMut.isPending || query.trim().length < 2) && { opacity: 0.5 }]}
        >
          {searchMut.isPending ? (
            <ActivityIndicator color={colors.fgStrong} size="small" />
          ) : (
            <Text style={styles.searchBtnText}>Buscar</Text>
          )}
        </Pressable>

        {project.trim() && (
          <Pressable
            onPress={() => reindexMut.mutate()}
            disabled={reindexMut.isPending}
            style={[styles.reindexBtn, reindexMut.isPending && { opacity: 0.5 }]}
          >
            <Text style={styles.reindexText}>
              {reindexMut.isPending ? "Re-indexando..." : "Re-indexar"}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Reindex result */}
      {reindexMut.data && (
        <View style={styles.resultBox}>
          <Text style={[styles.resultText, { color: colors.success }]}>
            {reindexMut.data}
          </Text>
        </View>
      )}

      {/* Search results */}
      {searchMut.data && (
        <View style={styles.results}>
          <Text style={styles.sectionTitle}>RESULTADOS</Text>
          <View style={styles.codeBlock}>
            <Text style={styles.codeText}>{searchMut.data}</Text>
          </View>
        </View>
      )}

      {searchMut.error && (
        <View style={[styles.resultBox, { backgroundColor: colors.criticalDim }]}>
          <Text style={[styles.resultText, { color: colors.critical }]}>
            {searchMut.error.message}
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
  subtitle: { color: colors.fgDim, fontSize: fontSize.sm, marginBottom: spacing.lg, lineHeight: 20 },
  input: {
    backgroundColor: colors.surfaceInner, borderRadius: 10,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    color: colors.fg, fontSize: fontSize.md, borderWidth: 1, borderColor: colors.border,
  },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  searchBtn: {
    flex: 1, backgroundColor: colors.accent, borderRadius: 10,
    paddingVertical: spacing.md, alignItems: "center",
  },
  searchBtnText: { color: colors.fgStrong, fontSize: fontSize.md, fontWeight: "600" },
  reindexBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md, alignItems: "center",
  },
  reindexText: { color: colors.fgDim, fontSize: fontSize.sm },
  resultBox: {
    backgroundColor: colors.surfaceInner, borderRadius: 10,
    padding: spacing.md, marginTop: spacing.lg,
  },
  resultText: { fontSize: fontSize.sm },
  results: { marginTop: spacing.xl },
  sectionTitle: { color: colors.fgDim, fontSize: fontSize.xs, fontWeight: "600", letterSpacing: 1, marginBottom: spacing.sm },
  codeBlock: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: spacing.md,
  },
  codeText: { color: colors.fg, fontSize: fontSize.xs, fontFamily: "monospace", lineHeight: 18 },
});
