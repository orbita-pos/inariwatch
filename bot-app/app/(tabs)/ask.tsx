import { useState, useRef } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, KeyboardAvoidingView,
  Platform, StyleSheet, ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { askInari } from "../../lib/api";
import { colors, spacing, fontSize } from "../../lib/theme";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export default function AskScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const send = async () => {
    const question = input.trim();
    if (!question || loading) return;

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const response = await askInari(question);
      const aiMsg: Message = { id: `a_${Date.now()}`, role: "assistant", content: response };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (e) {
      const errMsg: Message = {
        id: `e_${Date.now()}`,
        role: "assistant",
        content: `Error: ${e instanceof Error ? e.message : "Failed to get response"}`,
      };
      setMessages((prev) => [...prev, errMsg]);
    }
    setLoading(false);

    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    return (
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
        {!isUser && <Text style={styles.aiLabel}>🦊 Inari</Text>}
        <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
          {item.content}
        </Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>🧠</Text>
          <Text style={styles.emptyTitle}>Ask Inari</Text>
          <Text style={styles.emptyText}>
            Ask anything about your infrastructure.{"\n"}
            Inari has full context — alerts, remediations, integrations, uptime.
          </Text>
          <View style={styles.examples}>
            {[
              "What broke today?",
              "How many critical alerts this week?",
              "Summarize last night's incidents",
              "Why does the payment endpoint fail?",
            ].map((q) => (
              <Pressable key={q} onPress={() => { setInput(q); }} style={styles.example}>
                <Text style={styles.exampleText}>{q}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.messageList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        />
      )}

      {loading && (
        <View style={styles.typingBar}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.typingText}>Inari is thinking...</Text>
        </View>
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask a question..."
          placeholderTextColor={colors.fgMuted}
          multiline
          maxLength={500}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Pressable
          onPress={send}
          disabled={!input.trim() || loading}
          style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
        >
          <Ionicons name="send" size={18} color={colors.fgStrong} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl },
  emptyEmoji: { fontSize: 48, marginBottom: spacing.md },
  emptyTitle: { color: colors.fgStrong, fontSize: fontSize.xxl, fontWeight: "700", marginBottom: spacing.sm },
  emptyText: { color: colors.fgDim, fontSize: fontSize.md, textAlign: "center", lineHeight: 22, marginBottom: spacing.xl },
  examples: { gap: spacing.sm, width: "100%" },
  example: {
    backgroundColor: colors.surfaceInner, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  exampleText: { color: colors.fgDim, fontSize: fontSize.sm },
  messageList: { padding: spacing.lg, paddingBottom: spacing.xxl },
  bubble: { maxWidth: "85%", borderRadius: 16, padding: spacing.md, marginBottom: spacing.sm },
  bubbleUser: { backgroundColor: colors.accent, alignSelf: "flex-end", borderBottomRightRadius: 4 },
  bubbleAI: { backgroundColor: colors.surface, alignSelf: "flex-start", borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border },
  aiLabel: { color: colors.fgMuted, fontSize: fontSize.xs, marginBottom: 4 },
  bubbleText: { color: colors.fg, fontSize: fontSize.md, lineHeight: 22 },
  bubbleTextUser: { color: colors.fgStrong },
  typingBar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  typingText: { color: colors.fgMuted, fontSize: fontSize.sm },
  inputBar: {
    flexDirection: "row", alignItems: "flex-end", gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface,
  },
  input: {
    flex: 1, backgroundColor: colors.surfaceInner, borderRadius: 20,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    color: colors.fg, fontSize: fontSize.md, maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: colors.accent, borderRadius: 20,
    width: 36, height: 36, justifyContent: "center", alignItems: "center",
  },
  sendBtnDisabled: { opacity: 0.4 },
});
