"use client";

import { useTransition } from "react";
import { Unplug } from "lucide-react";
import { toast } from "sonner";
import { disconnectIntegration } from "./actions";

type Props = {
  integrationId: string;
  serviceLabel: string;
};

export function DisconnectButton({ integrationId, serviceLabel }: Props) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      title="Disconnect"
      aria-label="Disconnect integration"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await disconnectIntegration(integrationId);
          if (res.ok) {
            toast.success(`${serviceLabel} disconnected`);
          } else {
            toast.error(res.error);
          }
        })
      }
      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/50 transition-colors hover:bg-red-400/[0.06] hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  );
}
