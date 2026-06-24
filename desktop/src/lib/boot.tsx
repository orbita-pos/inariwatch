import { useEffect } from "react";

import { ToastBusProvider, TooltipProvider } from "@/components/ui";
import { useAppState } from "@/lib/store/useAppState";
import { applyTheme, detectSystemTheme, subscribeSystemTheme } from "@/lib/theme";

/**
 * Wrap every window's React tree with the same provider stack +
 * theme initializer. Keeps the per-entry boilerplate to a single
 * import + one tag.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  const themeMode = useAppState((s) => s.themeMode);
  const setSystemTheme = useAppState((s) => s.setSystemTheme);

  useEffect(() => {
    const sys = detectSystemTheme();
    setSystemTheme(sys);
    applyTheme(themeMode, sys);
    return subscribeSystemTheme((next) => {
      setSystemTheme(next);
      applyTheme(themeMode, next);
    });
  }, [themeMode, setSystemTheme]);

  return (
    <TooltipProvider>
      <ToastBusProvider>{children}</ToastBusProvider>
    </TooltipProvider>
  );
}
