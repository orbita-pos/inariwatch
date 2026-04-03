import { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, TextInput, Pressable, FlatList,
  StyleSheet, ActivityIndicator,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { askInari } from "../../lib/api";
import { MarkdownText } from "../../components/MarkdownText";
import { colors, spacing, fontSize } from "../../lib/theme";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const STORAGE_KEY = "inari_chat_history";
const MAX_STORED_MESSAGES = 50;

const EXAMPLES: { category: string; questions: string[] }[] = [
  {
    category: "Diagnostico",
    questions: ["Que se rompio hoy?", "Por que falla el endpoint de pagos?"],
  },
  {
    category: "Estado",
    questions: ["Como esta produccion ahora?", "Hay algun servicio caido?"],
  },
  {
    category: "Tendencias",
    questions: ["Cuantas alertas criticas esta semana?", "Cual es el MTTR actual?"],
  },
  {
    category: "Acciones",
    questions: ["Resumeme los incidentes de anoche", "Que proyectos tienen mas errores?"],
  },
];

export default function AskScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // Load chat history
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored) {
        try { setMessages(JSON.parse(stored)); } catch {}
      }
    });
  }, []);

  // Persist chat history
  const persist = useCallback((msgs: Message[]) => {
    const toStore = msgs.slice(-MAX_STORED_MESSAGES);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toStore)).catch(() => {});
  }, []);

  const clearChat = () => {
    setMessages([]);
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  };

  const send = async (questionOverride?: string) => {
    const question = (questionOverride ?? input).trim();
    if (!question || loading) return;

    const userMsg: Message = { id: `u_${Date.now()}`, role: "user", content: question };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const response = await askInari(question);
      const aiMsg: Message = { id: `a_${Date.now()}`, role: "assistant", content: response };
      const final = [...updated, aiMsg];
      setMessages(final);
      persist(final);
    } catch (e) {
      const errMsg: Message = {
        id: `e_${Date.now()}`,
        role: "assistant",
        content: `Error: ${e instanceof Error ? e.message : "No se pudo obtener respuesta"}`,
      };
      const final = [...updated, errMsg];
      setMessages(final);
      persist(final);
    }
    setLoading(false);

    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    return (
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
        {!isUser && <Text style={styles.aiLabel}>Inari</Text>}
        {isUser ? (
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{item.content}</Text>
        ) : (
          <MarkdownText text={item.content} />
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Ask Inari</Text>
          <Text style={styles.emptyText}>
            Pregunta cualquier cosa sobre tu infraestructura.{"\n"}
            Inari tiene contexto completo — alertas, remediaciones, integraciones, uptime.
          </Text>
          <View style={styles.examples}>
            {EXAMPLES.map((group) => (
              <View key={group.category} style={styles.exampleGroup}>
                <Text style={styles.exampleCategory}>{group.category}</Text>
                {group.questions.map((q) => (
                  <Pressable key={q} onPress={() => send(q)} style={styles.example}>
                    <Text style={styles.exampleText}>{q}</Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.fgMuted} />
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        </View>
      ) : (
        <>
          {/* Clear chat button */}
          <Pressable onPress={clearChat} style={styles.clearBtn}>
            <Ionicons name="trash-outline" size={16} color={colors.fgMuted} />
            <Text style={styles.clearText}>Limpiar chat</Text>
          </Pressable>

          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            keyboardShouldPersistTaps="handled"
          />
        </>
      )}

      {loading && (
        <View style={styles.typingBar}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.typingText}>Inari esta pensando...</Text>
        </View>
      )}

      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Haz una pregunta..."
            placeholderTextColor={colors.fgMuted}
            multiline
            maxLength={500}
            onSubmitEditing={() => send()}
            returnKeyType="send"
          />
          <Pressable
            onPress={() => send()}
            disabled={!input.trim() || loading}
            style={[styles.sendBtn, (!input.trim() || loading) && styles.sendBtnDisabled]}
          >
            <Ionicons name="send" size={18} color={colors.fgStrong} />
          </Pressable>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  empty: { flex: 1, justifyContent: "center", padding: spacing.xl },
  emptyTitle: { color: colors.fgStrong, fontSize: fontSize.xxl, fontWeight: "700", marginBottom: spacing.sm, textAlign: "center" },
  emptyText: { color: colors.fgDim, fontSize: fontSize.md, textAlign: "center", lineHeight: 22, marginBottom: spacing.xl },
  examples: { gap: spacing.lg },
  exampleGroup: { gap: spacing.xs },
  exampleCategory: { color: colors.fgMuted, fontSize: fontSize.xs, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 },
  example: {
    backgroundColor: colors.surfaceInner, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
  },
  exampleText: { color: colors.fgDim, fontSize: fontSize.sm, flex: 1 },
  clearBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-end", paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
  clearText: { color: colors.fgMuted, fontSize: fontSize.xs },
  messageList: { padding: spacing.lg, paddingBottom: spacing.xxl },
  bubble: { maxWidth: "85%", borderRadius: 16, padding: spacing.md, marginBottom: spacing.sm },
  bubbleUser: { backgroundColor: colors.accent, alignSelf: "flex-end", borderBottomRightRadius: 4 },
  bubbleAI: { backgroundColor: colors.surface, alignSelf: "flex-start", borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border },
  aiLabel: { color: colors.fgMuted, fontSize: fontSize.xs, marginBottom: 4, fontWeight: "600" },
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
