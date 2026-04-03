import { useState } from "react";
import { View, Text, ScrollView, TextInput, Pressable, ActivityIndicator, Alert as RNAlert, StyleSheet } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { createUptimeMonitor } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { colors, spacing, fontSize } from "../lib/theme";

export default function CreateMonitorScreen() {
  const [url, setUrl] = useState("https://");
  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [interval, setInterval] = useState("60");

  const mutation = useMutation({
    mutationFn: () =>
      createUptimeMonitor({
        url: url.trim(),
        project: project.trim(),
        name: name.trim() || undefined,
        interval_sec: parseInt(interval) || 60,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["uptime"] });
      RNAlert.alert("Monitor creado", "El monitor de uptime se creo correctamente.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    },
  });

  const canSubmit = url.trim().startsWith("http") && project.trim();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Crear monitor de uptime</Text>
      <Text style={styles.subtitle}>
        InariWatch verificara la URL en el intervalo configurado y alertara cuando este caida
      </Text>

      <Text style={styles.label}>URL *</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="https://api.example.com/health"
        placeholderTextColor={colors.fgMuted}
        keyboardType="url"
        autoCapitalize="none"
      />

      <Text style={styles.label}>Proyecto *</Text>
      <TextInput
        style={styles.input}
        value={project}
        onChangeText={setProject}
        placeholder="Slug del proyecto"
        placeholderTextColor={colors.fgMuted}
        autoCapitalize="none"
      />

      <Text style={styles.label}>Nombre (opcional)</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="API Health Check"
        placeholderTextColor={colors.fgMuted}
      />

      <Text style={styles.label}>Intervalo (segundos)</Text>
      <TextInput
        style={styles.input}
        value={interval}
        onChangeText={setInterval}
        placeholder="60"
        placeholderTextColor={colors.fgMuted}
        keyboardType="number-pad"
      />
      <Text style={styles.hint}>Minimo 30, maximo 3600</Text>

      <Pressable
        onPress={() => mutation.mutate()}
        disabled={!canSubmit || mutation.isPending}
        style={[styles.submitBtn, (!canSubmit || mutation.isPending) && { opacity: 0.5 }]}
      >
        {mutation.isPending ? (
          <ActivityIndicator color={colors.fgStrong} size="small" />
        ) : (
          <Text style={styles.submitText}>Crear monitor</Text>
        )}
      </Pressable>

      {mutation.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{mutation.error.message}</Text>
        </View>
      )}
    </ScrollView>
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
  hint: { color: colors.fgMuted, fontSize: fontSize.xs, marginTop: 4 },
  submitBtn: {
    backgroundColor: colors.accent, borderRadius: 10,
    paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.xl,
  },
  submitText: { color: colors.fgStrong, fontSize: fontSize.md, fontWeight: "600" },
  errorBox: { backgroundColor: colors.criticalDim, borderRadius: 10, padding: spacing.md, marginTop: spacing.lg },
  errorText: { color: colors.critical, fontSize: fontSize.sm },
});
