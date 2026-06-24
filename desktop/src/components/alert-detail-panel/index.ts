/**
 * Barrel — AlertDetailPanel + its store. Other components import from
 * this index, not the individual files, so refactors don't break.
 */
export { AlertDetailPanel } from "./AlertDetailPanel"
export type { AlertDetailPanelProps } from "./AlertDetailPanel"
export { useAlertDetailPanel, useAlertDetailPanelKeyboard } from "./useAlertDetailPanel"
