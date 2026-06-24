import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "critical" | "warning" | "info" | "outline";
  className?: string;
}

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        {
          "border-zinc-700 bg-zinc-800 text-zinc-300":              variant === "default",
          "border-red-500/30 bg-red-500/10 text-red-400":           variant === "critical",
          "border-yellow-500/30 bg-yellow-500/10 text-yellow-400":  variant === "warning",
          "border-blue-500/30 bg-blue-500/10 text-blue-400":        variant === "info",
          "border-inari-border bg-transparent text-zinc-400":       variant === "outline",
        },
        className
      )}
    >
      {children}
    </span>
  );
}
