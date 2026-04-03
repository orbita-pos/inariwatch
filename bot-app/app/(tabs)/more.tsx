import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { clearToken } from "../../lib/auth";
import { queryClient } from "../../lib/query-client";
import { colors, spacing, fontSize } from "../../lib/theme";

type MenuItem = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route?: string;
  color?: string;
  onPress?: () => void;
};

const MENU_ITEMS: MenuItem[] = [
  { label: "Status", icon: "pulse", route: "/status" },
  { label: "Buscar alertas", icon: "search", route: "/search" },
  { label: "Analytics", icon: "bar-chart", route: "/analytics" },
  { label: "Buscar codigo", icon: "code-slash", route: "/code-search" },
  { label: "Riesgo de PR", icon: "git-pull-request", route: "/pr-risk" },
  { label: "Crear monitor", icon: "globe", route: "/create-monitor" },
  { label: "Configuracion", icon: "settings", route: "/settings" },
];

export default function MoreScreen() {
  const handleSignOut = async () => {
    queryClient.clear();
    await clearToken();
    router.replace("/login");
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        {MENU_ITEMS.map((item) => (
          <Pressable
            key={item.label}
            style={styles.row}
            onPress={() => {
              if (item.onPress) item.onPress();
              else if (item.route) router.push(item.route as never);
            }}
          >
            <Ionicons name={item.icon} size={20} color={item.color ?? colors.fgDim} />
            <Text style={[styles.rowLabel, item.color ? { color: item.color } : null]}>
              {item.label}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.fgMuted} />
          </Pressable>
        ))}
      </View>

      {/* Sign out */}
      <View style={styles.section}>
        <Pressable style={styles.row} onPress={handleSignOut}>
          <Ionicons name="log-out" size={20} color={colors.critical} />
          <Text style={[styles.rowLabel, { color: colors.critical }]}>Cerrar sesion</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.fgMuted} />
        </Pressable>
      </View>

      {/* About */}
      <View style={styles.about}>
        <Text style={styles.aboutText}>InariWatch Bot v1.0.0</Text>
        <Text style={styles.aboutSubtext}>Hecho con amor en Mexico</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  section: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, overflow: "hidden", marginBottom: spacing.lg,
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowLabel: { flex: 1, color: colors.fg, fontSize: fontSize.md },
  about: { alignItems: "center", marginTop: spacing.xl },
  aboutText: { color: colors.fgMuted, fontSize: fontSize.sm },
  aboutSubtext: { color: colors.fgMuted, fontSize: fontSize.xs, marginTop: 4 },
});
