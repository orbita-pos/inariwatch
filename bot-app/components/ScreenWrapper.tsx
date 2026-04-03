import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../lib/theme";

/**
 * Wrapper for Stack screens pushed from More/navigation.
 * Handles safe area (top for notch, bottom for gesture bar).
 */
export function ScreenWrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["bottom"]}>
      {children}
    </SafeAreaView>
  );
}
