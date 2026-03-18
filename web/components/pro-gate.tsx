import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ProGate({
  isPro,
  feature,
  children,
}: {
  isPro: boolean;
  feature: string;
  children: React.ReactNode;
}) {
  if (isPro) return <>{children}</>;

  return (
    <div className="rounded-xl border border-line bg-surface p-6 text-center">
      <Lock className="h-8 w-8 text-zinc-600 mx-auto mb-3" />
      <p className="text-sm font-medium text-fg-base mb-1">{feature} is a Pro feature</p>
      <p className="text-xs text-zinc-500 mb-4">
        Upgrade to unlock this and all Pro features.
      </p>
      <Link href="/settings">
        <Button variant="primary" size="sm">Upgrade to Pro</Button>
      </Link>
    </div>
  );
}
