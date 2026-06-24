/**
 * S9 — push-to-talk / hands-free mic button for the chat input.
 *
 * State machine:
 *
 *   ┌─ idle ───┐  press  ┌─ requesting-mic ─┐  granted  ┌─ recording ─┐
 *   │  click   │ ─────►  │  getUserMedia()   │ ─────►  │  MediaRec…   │
 *   └──────────┘         └───────────────────┘          └──────────────┘
 *           ▲                    │                            │
 *           │                    │ denied                     │ release
 *           │                    ▼                            ▼
 *           │                ┌─ error ─┐               ┌─ transcribing ─┐
 *           └────────────────┘         │               │  blob → backend │
 *                                       └ idle (timer) └──────────┬──────┘
 *                                                                 │ done
 *                                                                 ▼ (idle)
 *
 * Push-to-talk mode binds press/release to mousedown/mouseup +
 * keydown/keyup (Space). Hands-free mode toggles on click. Mode is
 * read from `voice_settings.push_to_talk` (S9 Voice settings tab).
 */

import { Mic, MicOff } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { cn } from "@/lib/cn";
import {
  blobToWavBytes,
  bytesToBase64,
  preferredRecorderMimeType,
  transcribeAudio,
} from "@/lib/voice-ipc";

export type MicButtonState =
  | "idle"
  | "requesting-mic"
  | "recording"
  | "transcribing"
  | "error";

export interface MicButtonProps {
  /** Push-to-talk (hold) vs hands-free (toggle). */
  pushToTalk: boolean;
  /** Called when the backend returns transcribed text. */
  onTranscribed: (text: string) => void;
  /** Called when something goes wrong; surface lives in the parent. */
  onError?: (message: string) => void;
  /** Whisper-cli language code, e.g. `en`. Empty = backend default. */
  language?: string;
  /** Maximum recording duration in ms. Default 30 s. */
  maxDurationMs?: number;
  /** Optional override for `getUserMedia` — tests inject mocks. */
  getUserMedia?: typeof navigator.mediaDevices.getUserMedia;
  /** Optional override for the transcribe call — tests inject mocks. */
  transcribe?: typeof transcribeAudio;
  /** Optional override for `blobToWavBytes` — tests bypass Web Audio. */
  toWav?: (blob: Blob) => Promise<ArrayBuffer>;
  className?: string;
}

const DEFAULT_MAX_DURATION_MS = 30_000;

export function MicButton({
  pushToTalk,
  onTranscribed,
  onError,
  language,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  getUserMedia,
  transcribe = transcribeAudio,
  toWav = blobToWavBytes,
  className,
}: MicButtonProps) {
  const [state, setState] = useState<MicButtonState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingMimeRef = useRef<string>("");

  const reportError = useCallback(
    (message: string) => {
      setState("error");
      onError?.(message);
      // Auto-recover to idle after a beat so the user can retry.
      window.setTimeout(() => setState("idle"), 1500);
    },
    [onError],
  );

  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const stream = streamRef.current;
    if (!recorder) return;

    setState("transcribing");

    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    // The "stop" event flushes pending chunks. We wait for it before
    // assembling the blob so we don't miss the tail of the recording.
    const stopped = new Promise<void>((resolve) => {
      const onStop = () => {
        recorder.removeEventListener("stop", onStop);
        resolve();
      };
      recorder.addEventListener("stop", onStop);
    });
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    await stopped;

    stream?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;

    try {
      const mime = recordingMimeRef.current || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mime });
      chunksRef.current = [];
      if (blob.size === 0) {
        reportError("No audio captured.");
        return;
      }
      const wavBuf = await toWav(blob);
      const b64 = bytesToBase64(wavBuf);
      const result = await transcribe(b64, "wav", language);
      if (!result.text) {
        reportError("Whisper returned an empty transcript.");
        return;
      }
      onTranscribed(result.text);
      setState("idle");
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  }, [language, onTranscribed, reportError, toWav, transcribe]);

  const startRecording = useCallback(async () => {
    if (state !== "idle" && state !== "error") return;

    setState("requesting-mic");
    chunksRef.current = [];

    const realGetUserMedia =
      getUserMedia ?? (navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices));
    if (!realGetUserMedia) {
      reportError("Microphone API is not available.");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await realGetUserMedia({ audio: true });
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
      return;
    }
    streamRef.current = stream;

    const mime = preferredRecorderMimeType();
    recordingMimeRef.current = mime;
    let recorder: MediaRecorder;
    try {
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onerror = (event: Event) => {
      const err =
        (event as unknown as { error?: { message?: string } }).error?.message ??
        "MediaRecorder error";
      reportError(err);
    };

    recorder.start(250); // chunk every 250 ms so partial state is preserved on stop
    setState("recording");

    stopTimerRef.current = setTimeout(() => {
      void finishRecording();
    }, maxDurationMs);
  }, [finishRecording, getUserMedia, maxDurationMs, reportError, state]);

  // Cleanup on unmount — never leak the mic stream.
  useEffect(() => {
    return () => {
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    };
  }, []);

  const handleClick = useCallback(() => {
    if (pushToTalk) return; // PTT uses press/release, not click
    if (state === "recording") {
      void finishRecording();
      return;
    }
    void startRecording();
  }, [finishRecording, pushToTalk, startRecording, state]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pushToTalk) return;
      e.preventDefault();
      void startRecording();
    },
    [pushToTalk, startRecording],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!pushToTalk) return;
      e.preventDefault();
      if (state === "recording") {
        void finishRecording();
      }
    },
    [finishRecording, pushToTalk, state],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!pushToTalk) return;
      if (e.key !== " " && e.key !== "Spacebar") return;
      if (e.repeat) return;
      e.preventDefault();
      void startRecording();
    },
    [pushToTalk, startRecording],
  );

  const handleKeyUp = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!pushToTalk) return;
      if (e.key !== " " && e.key !== "Spacebar") return;
      e.preventDefault();
      if (state === "recording") {
        void finishRecording();
      }
    },
    [finishRecording, pushToTalk, state],
  );

  const Icon = state === "error" ? MicOff : Mic;
  const labelByState: Record<MicButtonState, string> = {
    idle: pushToTalk ? "Hold to record voice" : "Start voice input",
    "requesting-mic": "Requesting microphone…",
    recording: pushToTalk ? "Recording — release to stop" : "Recording — click to stop",
    transcribing: "Transcribing…",
    error: "Voice input failed",
  };

  return (
    <button
      type="button"
      data-testid="mic-button"
      data-state={state}
      aria-label={labelByState[state]}
      title={labelByState[state]}
      disabled={state === "transcribing" || state === "requesting-mic"}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={(e) => {
        if (pushToTalk && state === "recording") handlePointerUp(e);
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className={cn(
        "h-7 w-7 inline-flex items-center justify-center rounded-[var(--radius-sm)]",
        "transition-colors duration-[var(--duration-fast)] outline-none cursor-pointer",
        "focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        state === "idle" && "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--card)]",
        state === "requesting-mic" && "text-[var(--text-muted)] animate-pulse",
        state === "recording" && "bg-[var(--accent)] text-[var(--accent-ink)] animate-pulse",
        state === "transcribing" && "text-[var(--accent)] animate-pulse",
        state === "error" && "text-[var(--danger)]",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
