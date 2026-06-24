import { View, Text, ScrollView, StyleSheet } from "react-native";
import { colors, spacing, fontSize } from "../lib/theme";

type FileChange = { path: string; content?: string };

export function DiffView({ changes }: { changes: FileChange[] }) {
  if (!changes || changes.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Files Changed ({changes.length})</Text>
      {changes.map((file) => (
        <View key={file.path} style={styles.file}>
          <Text style={styles.path}>{file.path}</Text>
          {file.content && (
            <ScrollView horizontal style={styles.codeScroll}>
              <View style={styles.codeBlock}>
                {file.content.split("\n").map((line, i) => {
                  const isAdd = line.startsWith("+") && !line.startsWith("+++");
                  const isDel = line.startsWith("-") && !line.startsWith("---");
                  return (
                    <View
                      key={i}
                      style={[
                        styles.line,
                        isAdd && styles.lineAdd,
                        isDel && styles.lineDel,
                      ]}
                    >
                      <Text style={styles.lineNum}>{i + 1}</Text>
                      <Text
                        style={[
                          styles.lineText,
                          isAdd && styles.lineTextAdd,
                          isDel && styles.lineTextDel,
                        ]}
                      >
                        {line}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {},
  title: {
    color: colors.fgDim,
    fontSize: fontSize.xs,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  file: {
    backgroundColor: colors.surfaceInner,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    overflow: "hidden",
  },
  path: {
    color: colors.fg,
    fontSize: fontSize.xs,
    fontFamily: "monospace",
    padding: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  codeScroll: { maxHeight: 300 },
  codeBlock: { padding: spacing.sm },
  line: {
    flexDirection: "row",
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
  },
  lineAdd: { backgroundColor: "rgba(34, 197, 94, 0.1)" },
  lineDel: { backgroundColor: "rgba(239, 68, 68, 0.1)" },
  lineNum: {
    color: colors.fgMuted,
    fontSize: fontSize.xs,
    fontFamily: "monospace",
    width: 30,
    textAlign: "right",
    marginRight: spacing.sm,
  },
  lineText: {
    color: colors.fg,
    fontSize: fontSize.xs,
    fontFamily: "monospace",
    flexShrink: 1,
  },
  lineTextAdd: { color: colors.success },
  lineTextDel: { color: colors.critical },
});
