export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { cliPendingCodes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Terminal, CheckCircle2 } from "lucide-react";
import { approveCliCode } from "./actions";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Authorize CLI — InariWatch" };

export default async function CliVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; success?: string }>;
}) {
  const params = await searchParams;
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;

  if (!userId) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/cli/verify?code=${params.code ?? ""}`)}`);

  }

  if (params.success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page">
        <div className="flex flex-col items-center gap-4 text-center px-4">
          <CheckCircle2 className="h-10 w-10 text-green-400" />
          <h1 className="text-xl font-semibold text-fg-strong">CLI authorized</h1>
          <p className="text-sm text-zinc-500">You can close this window and return to your terminal.</p>
        </div>
      </div>
    );
  }

  const code = params.code;
  if (!code) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page">
        <p className="text-sm text-zinc-500">Invalid link. Close this window and run <code className="text-zinc-300">npx @inariwatch/capture</code> again.</p>
      </div>
    );
  }

  const [pending] = await db
    .select()
    .from(cliPendingCodes)
    .where(eq(cliPendingCodes.code, code))
    .limit(1);

  if (!pending || pending.approved || new Date() > pending.expiresAt) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page">
        <div className="flex flex-col items-center gap-2 text-center px-4">
          <p className="text-sm font-medium text-zinc-400">This link has expired or already been used.</p>
          <p className="text-sm text-zinc-600">Run <code className="text-zinc-400">npx @inariwatch/capture</code> again to get a new link.</p>
        </div>
      </div>
    );
  }

  async function handleApprove(formData: FormData) {
    "use server";
    await approveCliCode(formData);
    redirect("/cli/verify?success=1");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface-inner">
            <Terminal className="h-5 w-5 text-cyan-400" />
          </div>
          <h1 className="text-lg font-semibold text-fg-strong">Authorize CLI access</h1>
          <p className="text-sm text-zinc-500 leading-relaxed">
            <code className="text-fg-base font-mono text-xs">@inariwatch/capture</code> wants to connect to your InariWatch account and create a project automatically.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border border-line bg-surface-dim px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-widest text-zinc-600">This will</p>
          <ul className="space-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <li>· Create a project linked to your account</li>
            <li>· Write <code className="text-fg-base">INARIWATCH_DSN</code> to your <code className="text-fg-base">.env</code></li>
            <li>· Start receiving errors from your app</li>
          </ul>
        </div>

        <form action={handleApprove} className="flex flex-col gap-3">
          <input type="hidden" name="code" value={code} />
          <button
            type="submit"
            className="w-full rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-500 transition-colors"
          >
            Authorize
          </button>
          <p className="text-center text-[11px] text-zinc-700">
            Logged in as <span className="text-zinc-500">{(session?.user as { email?: string })?.email}</span>
          </p>
        </form>
      </div>
    </div>
  );
}
