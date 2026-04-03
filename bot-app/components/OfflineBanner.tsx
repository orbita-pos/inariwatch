import { useState, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { colors, spacing, fontSize } from "../lib/theme";

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOffline(!(state.isConnected && state.isInternetReachable !== false));
    });
    return () => unsubscribe();
  }, []);

  if (!isOffline) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>Sin conexion — mostrando datos anteriores</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.warningDim,
    borderBottomWidth: 1,
    borderBottomColor: colors.warning,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
  },
  text: {
    color: colors.warning,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
});
