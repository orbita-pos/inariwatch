"use client";

import { useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Loader2, CheckCircle2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { inviteMember } from "./workspace-actions";

interface InviteMembersDialogProps {
  open:           boolean;
  onClose:        () => void;
  organizationId: string;
  orgName:        string;
}

export function InviteMembersDialog({ open, onClose, organizationId, orgName }: InviteMembersDialogProps) {
  const [email,   setEmail]   = useState("");
  const [role,    setRole]    = useState<"admin" | "member">("member");
  const [error,   setError]   = useState("");
  const [success, setSuccess] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    startTransition(async () => {
      const result = await inviteMember(organizationId, email, role);
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(`Invite sent to ${email}`);
        setEmail("");
      }
    });
  }

  function handleClose() {
    setEmail("");
    setError("");
    setSuccess("");
    onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface p-6 shadow-2xl">
          <Dialog.Title className="text-lg font-semibold text-fg-strong">
            Invite to {orgName}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-base">
            Send an email invite. They'll get access to all workspace projects.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="inv-email" className="text-sm font-medium text-fg-base">Email address</label>
              <div className="relative mt-1.5">
                <Mail className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  id="inv-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@company.com"
                  autoFocus
                  className="h-10 w-full rounded-lg border border-line bg-surface-inner pl-9 pr-3 text-sm text-fg-strong placeholder:text-zinc-500 outline-none focus:border-inari-accent/40 focus:ring-1 focus:ring-inari-accent/20 transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-fg-base">Role</label>
              <Select value={role} onValueChange={(v) => setRole(v as "admin" | "member")}>
                <SelectTrigger className="mt-1.5 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member — can view all projects and alerts</SelectItem>
                  <SelectItem value="admin">Admin — can manage projects and invite others</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">{error}</p>
            )}

            {success && (
              <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {success}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={handleClose}>Done</Button>
              <Button type="submit" variant="primary" disabled={pending || !email.trim()}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send invite"}
              </Button>
            </div>
          </form>

          <Dialog.Close asChild>
            <button className="absolute right-4 top-4 text-zinc-500 hover:text-fg-strong transition-colors" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
