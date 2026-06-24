import { useState, useEffect } from "react";
import { View, Text, ScrollView, Switch, Pressable, Linking, StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { isBiometricAvailable, isBiometricEnabled, setBiometricEnabled } from "../lib/biometric";
import { ScreenWrapper } from "../components/ScreenWrapper";
import { colors, spacing, fontSize } from "../lib/theme";

const PREFS_KEY = "inari_notification_prefs";

type NotifPrefs = { critical: boolean; warning: boolean; info: boolean };
const DEFAULT_PREFS: NotifPrefs = { critical: true, warning: true, info: false };

export default function SettingsScreen() {
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_PREFS);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY).then((stored) => {
      if (stored) try { setPrefs(JSON.parse(stored)); } catch {}
    });
    isBiometricAvailable().then(setBioAvailable);
    isBiometricEnabled().then(setBioEnabled);
  }, []);

  const toggle = (key: keyof NotifPrefs) => {
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    AsyncStorage.setItem(PREFS_KEY, JSON.stringify(updated)).catch(() => {});
  };

  return (
    <ScreenWrapper title="Configuracion">
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Notifications */}
      <Text style={styles.sectionTitle}>NOTIFICACIONES</Text>
      <View style={styles.section}>
        <SettingRow
          label="Criticas"
          description="Alertas de severidad critica"
          value={prefs.critical}
          onToggle={() => toggle("critical")}
          color={colors.critical}
        />
        <SettingRow
          label="Warnings"
          description="Alertas de severidad warning"
          value={prefs.warning}
          onToggle={() => toggle("warning")}
          color={colors.warning}
        />
        <SettingRow
          label="Info"
          description="Alertas informativas"
          value={prefs.info}
          onToggle={() => toggle("info")}
          color={colors.info}
        />
      </View>

      {/* Security */}
      <Text style={styles.sectionTitle}>SEGURIDAD</Text>
      <View style={styles.section}>
        <SettingRow
          label="Biometrico"
          description="Face ID / huella para acceder al app"
          value={bioEnabled}
          onToggle={() => {
            const next = !bioEnabled;
            setBioEnabled(next);
            setBiometricEnabled(next);
          }}
          disabled={!bioAvailable}
        />
      </View>

      {/* About */}
      <Text style={styles.sectionTitle}>ACERCA DE</Text>
      <View style={styles.section}>
        <InfoRow label="Version" value="1.0.1-beta" />
        <InfoRow label="Build" value={new Date().toISOString().slice(0, 10)} />
        <Pressable
          style={styles.row}
          onPress={() => Linking.openURL("https://app.inariwatch.com")}
        >
          <Text style={styles.rowLabel}>Abrir InariWatch Web</Text>
          <Text style={styles.rowValue}>app.inariwatch.com</Text>
        </Pressable>
      </View>
    </ScrollView>
    </ScreenWrapper>
  );
}

function SettingRow({ label, description, value, onToggle, color, disabled }: {
  label: string; description: string; value: boolean; onToggle: () => void; color?: string; disabled?: boolean;
}) {
  return (
    <View style={[styles.row, disabled && { opacity: 0.4 }]}>
      <View style={styles.rowInfo}>
        {color && <View style={[styles.colorDot, { backgroundColor: color }]} />}
        <View>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowDesc}>{description}</Text>
        </View>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        disabled={disabled}
        trackColor={{ true: colors.accent, false: colors.surfaceInner }}
        thumbColor={colors.fgStrong}
      />
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 100 },
  sectionTitle: { color: colors.fgMuted, fontSize: fontSize.xs, fontWeight: "600", letterSpacing: 1, marginBottom: spacing.sm, marginTop: spacing.lg },
  section: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, overflow: "hidden",
  },
  row: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowInfo: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1 },
  colorDot: { width: 8, height: 8, borderRadius: 4 },
  rowLabel: { color: colors.fg, fontSize: fontSize.md },
  rowDesc: { color: colors.fgMuted, fontSize: fontSize.xs, marginTop: 1 },
  rowValue: { color: colors.fgMuted, fontSize: fontSize.sm },
});
