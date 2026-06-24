import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";

type Props = { children: React.ReactNode };
type State = { hasError: boolean; error: string | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.emoji}>🦊</Text>
        <Text style={styles.title}>Algo salio mal</Text>
        <Text style={styles.message}>{this.state.error ?? "Error desconocido"}</Text>
        <Pressable
          onPress={() => this.setState({ hasError: false, error: null })}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
  },
  emoji: { fontSize: 48, marginBottom: spacing.md },
  title: {
    color: colors.fgStrong,
    fontSize: fontSize.xxl,
    fontWeight: "700",
    marginBottom: spacing.sm,
  },
  message: {
    color: colors.fgDim,
    fontSize: fontSize.sm,
    textAlign: "center",
    marginBottom: spacing.xxl,
    lineHeight: 20,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  buttonText: {
    color: colors.fgStrong,
    fontSize: fontSize.md,
    fontWeight: "600",
  },
});
