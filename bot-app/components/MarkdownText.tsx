import { Text, View, StyleSheet } from "react-native";
import { colors, fontSize as fs } from "../lib/theme";

/**
 * Simple markdown renderer for AI responses.
 * Supports: **bold**, `inline code`, ```code blocks```, ## headings, - lists
 */
export function MarkdownText({ text }: { text: string }) {
  const blocks = text.split(/```([\s\S]*?)```/);

  return (
    <View>
      {blocks.map((block, i) => {
        // Odd indices are code blocks
        if (i % 2 === 1) {
          return (
            <View key={i} style={styles.codeBlock}>
              <Text style={styles.codeText}>{block.trim()}</Text>
            </View>
          );
        }
        // Even indices are regular text
        return <InlineMarkdown key={i} text={block} />;
      })}
    </View>
  );
}

function InlineMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");

  return (
    <>
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <View key={i} style={styles.spacer} />;

        // ## Heading
        if (trimmed.startsWith("## ")) {
          return (
            <Text key={i} style={styles.heading}>
              {trimmed.slice(3)}
            </Text>
          );
        }

        // ### Subheading
        if (trimmed.startsWith("### ")) {
          return (
            <Text key={i} style={styles.subheading}>
              {trimmed.slice(4)}
            </Text>
          );
        }

        // - List item
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <View key={i} style={styles.listItem}>
              <Text style={styles.bullet}>{"  \u2022  "}</Text>
              <Text style={styles.text}>
                <InlineFormatting text={trimmed.slice(2)} />
              </Text>
            </View>
          );
        }

        // Regular paragraph
        return (
          <Text key={i} style={styles.text}>
            <InlineFormatting text={trimmed} />
          </Text>
        );
      })}
    </>
  );
}

function InlineFormatting({ text }: { text: string }) {
  // Split by **bold** and `code` patterns
  const parts = text.split(/(\*\*.*?\*\*|`[^`]+`)/);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <Text key={i} style={styles.bold}>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <Text key={i} style={styles.inlineCode}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        return <Text key={i}>{part}</Text>;
      })}
    </>
  );
}

const styles = StyleSheet.create({
  text: { color: colors.fg, fontSize: fs.md, lineHeight: 22, marginBottom: 2 },
  bold: { fontWeight: "700", color: colors.fgStrong },
  heading: { color: colors.fgStrong, fontSize: fs.lg, fontWeight: "700", marginTop: 12, marginBottom: 6 },
  subheading: { color: colors.fgStrong, fontSize: fs.md, fontWeight: "700", marginTop: 8, marginBottom: 4 },
  inlineCode: { fontFamily: "monospace", backgroundColor: colors.surfaceInner, color: colors.accent, fontSize: fs.sm },
  codeBlock: { backgroundColor: colors.surfaceInner, borderRadius: 8, padding: 10, marginVertical: 6 },
  codeText: { fontFamily: "monospace", color: colors.fg, fontSize: fs.sm, lineHeight: 18 },
  listItem: { flexDirection: "row", marginBottom: 2 },
  bullet: { color: colors.fgMuted, fontSize: fs.md },
  spacer: { height: 8 },
});
