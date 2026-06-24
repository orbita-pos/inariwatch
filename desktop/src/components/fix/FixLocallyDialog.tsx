/**
 * Fix Locally dialog.
 *
 * Two states:
 *   1. No local path configured → shows a folder picker so the user can
 *      point Inari at their local clone of the project.
 *   2. Local path known → shows the path + a "Start fix session" button
 *      that activates the workspace and opens a pre-seeded conversation.
 *
 * The dialog is triggered from the Alerts widget in CloudDashboard.
 * It stores the local path keyed by `alert.projectName` so the choice
 * survives across sessions without requiring a wizard re-run.
 */

import { FolderOpen, MessageSquareCode, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, Dialog } from "@/components/ui";
import type { CloudAlert } from "@/lib/cloud-ipc";
import {
  activateLocalPath,
  pickLocalFolder,
  projectGetLocalPath,
  projectSetLocalPath,
} from "@/lib/ipc/project-local";
import { useChat } from "@/lib/store/chat";

interface Props {
  alert: CloudAlert | null;
  onClose: () => void;
}

export function FixLocallyDialog({ alert, onClose }: Props) {
  const open = alert !== null;
  const startLocalFixSession = useChat((s) => s.startLocalFixSession);

  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [starting, setStarting]   = useState(false);

  // Load the stored path when the dialog opens.
  useEffect(() => {
    if (!alert) return;
    setLocalPath(null);
    setError(null);
    let cancelled = false;
    projectGetLocalPath(alert.projectName)
      .then((p) => { if (!cancelled) setLocalPath(p ?? null); })
      .catch(() => { if (!cancelled) setLocalPath(null); });
    return () => { cancelled = true; };
  }, [alert?.projectName]);

  const handlePickFolder = useCallback(async () => {
    if (!alert) return;
    setLoading(true);
    setError(null);
    try {
      const picked = await pickLocalFolder();
      if (!picked) return;
      await projectSetLocalPath(alert.projectName, picked);
      setLocalPath(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [alert]);

  const handleChangePath = useCallback(async () => {
    if (!alert) return;
    setLoading(true);
    setError(null);
    try {
      const picked = await pickLocalFolder();
      if (!picked) return;
      await projectSetLocalPath(alert.projectName, picked);
      setLocalPath(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [alert]);

  const handleStartSession = useCallback(async () => {
    if (!alert || !localPath) return;
    setStarting(true);
    setError(null);
    try {
      await activateLocalPath(localPath);
      startLocalFixSession(alert, localPath);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }, [alert, localPath, startLocalFixSession, onClose]);

  const handleShowCode = useCallback(() => {
    if (!alert) return;
    startLocalFixSession(alert, null);
    onClose();
  }, [alert, startLocalFixSession, onClose]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={
        <span className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-[var(--accent)]" aria-hidden />
          Fix locally
        </span>
      }
      description={alert ? `${alert.title} · ${alert.projectName}` : undefined}
    >
      <div className="flex flex-col gap-4 mt-2">
        {localPath === null ? (
          /* ── No path configured ── */
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              Point Inari at your local clone of{" "}
              <strong className="text-[var(--text)]">{alert?.projectName}</strong> so the
              AI agent can read your files and write the fix directly to disk — no PR, no
              branch, instant apply.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={handlePickFolder}
                disabled={loading}
                className="inline-flex items-center gap-2"
              >
                <FolderOpen className="h-4 w-4" aria-hidden />
                {loading ? "Opening…" : "Choose local folder"}
              </Button>
              <button
                type="button"
                onClick={handleShowCode}
                className="text-xs text-[var(--muted)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-1"
              >
                <MessageSquareCode className="h-3.5 w-3.5" aria-hidden />
                Show fix in chat instead
              </button>
            </div>
          </div>
        ) : (
          /* ── Path configured ── */
          <div className="flex flex-col gap-3">
            <div className="rounded-[var(--radius)] bg-[var(--surface)] border border-[var(--border)] px-3 py-2">
              <p className="text-[0.7rem] text-[var(--muted)] mb-0.5">Local path</p>
              <p className="text-xs font-mono text-[var(--text)] break-all">{localPath}</p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button
                onClick={handleStartSession}
                disabled={starting}
                className="inline-flex items-center gap-2"
              >
                <Wrench className="h-4 w-4" aria-hidden />
                {starting ? "Starting…" : "Start fix session"}
              </Button>
              <button
                type="button"
                onClick={handleChangePath}
                disabled={loading}
                className="text-xs text-[var(--muted)] hover:text-[var(--accent)] transition-colors"
              >
                Change folder
              </button>
            </div>
          </div>
        )}

        {error ? (
          <p className="text-xs text-[var(--danger)] flex items-center gap-1.5">
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
