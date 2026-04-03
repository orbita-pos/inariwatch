import * as Haptics from "expo-haptics";

/** Light tap — alert card press, filter change */
export const hapticLight = () =>
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

/** Medium tap — Fix It, Rollback, destructive actions */
export const hapticMedium = () =>
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

/** Heavy tap — confirm dangerous action */
export const hapticHeavy = () =>
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});

/** Success — resolve, feedback positive */
export const hapticSuccess = () =>
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

/** Error — failed action, error state */
export const hapticError = () =>
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
