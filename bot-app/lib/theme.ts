export const colors = {
  bg: "#0a0a0a",
  surface: "#111111",
  surfaceInner: "#1a1a1a",
  border: "#222222",
  borderLight: "#333333",
  accent: "#7c3aed",
  accentDim: "rgba(124, 58, 237, 0.1)",
  fg: "#e5e5e5",
  fgStrong: "#ffffff",
  fgDim: "#a1a1aa",
  fgMuted: "#71717a",
  critical: "#ef4444",
  criticalDim: "rgba(239, 68, 68, 0.1)",
  warning: "#f59e0b",
  warningDim: "rgba(245, 158, 11, 0.1)",
  info: "#3b82f6",
  infoDim: "rgba(59, 130, 246, 0.1)",
  success: "#22c55e",
  successDim: "rgba(34, 197, 94, 0.1)",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 28,
};

export const severityColor = (severity: string) => {
  switch (severity) {
    case "critical": return colors.critical;
    case "warning": return colors.warning;
    case "info": return colors.info;
    default: return colors.fgMuted;
  }
};

export const severityBg = (severity: string) => {
  switch (severity) {
    case "critical": return colors.criticalDim;
    case "warning": return colors.warningDim;
    case "info": return colors.infoDim;
    default: return colors.surfaceInner;
  }
};
