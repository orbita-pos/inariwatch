"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Users, Loader2 } from "lucide-react";
import { acceptInvite } from "@/app/(dashboard)/workspace-actions";

interface AcceptInviteCardProps {
  token:   string;
  orgName: string;
  role:    string;
  email:   string;
}

export function AcceptInviteCard({ token, orgName, role, email }: AcceptInviteCardProps) {
  const router = useRouter();
  const [error, setError]     = useState("");
  const [pending, startTransition] = useTransition();

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptInvite(token);
      if (result.error) {
        setError(result.error);
      } else {
        router.push("/dashboard");
      }
    });
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 text-center">
      <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-inari-accent/10">
        <Users className="h-6 w-6 text-inari-accent" />
      </div>

      <h1 className="text-xl font-bold text-fg-strong mb-2">
        Join {orgName}
      </h1>
      <p className="text-sm text-fg-base mb-1">
        You've been invited to join <strong className="text-fg-strong">{orgName}</strong> as a <strong className="text-fg-strong">{role}</strong>.
      </p>
      <p className="text-xs text-zinc-500 mb-6">
        Invite sent to {email}
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      <Button variant="primary" className="w-full" onClick={handleAccept} disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Accept invitation"}
      </Button>

      <a href="/dashboard" className="mt-4 block text-xs text-zinc-500 hover:text-fg-base transition-colors">
        Skip for now
      </a>
    </div>
  );
}
