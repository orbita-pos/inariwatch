import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  children,
  footer,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-surface overflow-hidden flex flex-col ${className}`}>
      <div className="flex items-baseline justify-between px-5 py-3 border-b border-line">
        <h2 className="text-sm font-semibold text-fg-strong">{title}</h2>
        {subtitle ? (
          <span className="text-[11px] text-fg-base/50">{subtitle}</span>
        ) : null}
      </div>
      <div className="flex-1 p-5 text-sm">{children}</div>
      {footer ? (
        <div className="border-t border-line bg-black/[0.02] dark:bg-white/[0.02] px-5 py-2 text-[11px] text-fg-base/60">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="text-fg-base/60 italic">
      Unavailable: <span className="font-mono text-[12px]">{message}</span>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="text-fg-base/60">{message}</div>;
}
