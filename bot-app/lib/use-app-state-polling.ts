import { useState, useEffect } from "react";
import { AppState } from "react-native";

/**
 * Returns the polling interval when the app is in the foreground,
 * and `false` when backgrounded (stops polling to save battery).
 */
export function useAppStatePolling(activeIntervalMs: number): number | false {
  const [isActive, setIsActive] = useState(AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      setIsActive(state === "active");
    });
    return () => sub.remove();
  }, []);

  return isActive ? activeIntervalMs : false;
}
