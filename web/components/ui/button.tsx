"use client";

import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "primary";
  size?: "sm" | "md" | "lg";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50 disabled:opacity-50 disabled:cursor-not-allowed",
          {
            "bg-surface border border-line text-fg-strong hover:bg-surface-inner":           variant === "default",
            "border border-line bg-transparent text-fg-strong hover:bg-surface-inner hover:border-line-medium": variant === "outline",
            "text-zinc-500 hover:text-fg-strong hover:bg-black/[0.06] dark:hover:bg-white/[0.06]": variant === "ghost",
            "bg-inari-accent text-white font-semibold hover:bg-[#6D28D9] active:bg-[#5B21B6]": variant === "primary",
          },
          {
            "h-8 px-3 text-sm":    size === "sm",
            "h-10 px-4 text-sm":   size === "md",
            "h-12 px-6 text-base": size === "lg",
          },
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
