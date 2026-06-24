/**
 * S9 — voice-ipc utility tests.
 *
 * Covers the tiny in-tree helpers (base64 encoder + recorder mime
 * preference) without touching Tauri IPC. Browser-side WAV transcoding
 * needs a real AudioContext + OfflineAudioContext, which jsdom doesn't
 * implement; we test only the pieces that work without them.
 */

import { describe, expect, it, vi } from "vitest";

import { bytesToBase64, preferredRecorderMimeType } from "@/lib/voice-ipc";

describe("bytesToBase64", () => {
  it("round-trips a known payload", () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const out = bytesToBase64(data.buffer);
    // atob is provided by jsdom; round-trip via it.
    const decoded = atob(out);
    expect(decoded.length).toBe(data.length);
    for (let i = 0; i < data.length; i++) {
      expect(decoded.charCodeAt(i)).toBe(data[i]);
    }
  });

  it("pads correctly for non-3-aligned lengths", () => {
    expect(bytesToBase64(new Uint8Array([1]).buffer)).toMatch(/==$/);
    expect(bytesToBase64(new Uint8Array([1, 2]).buffer)).toMatch(/=$/);
    expect(bytesToBase64(new Uint8Array([1, 2, 3]).buffer)).not.toMatch(/=/);
  });

  it("handles empty input", () => {
    expect(bytesToBase64(new ArrayBuffer(0))).toBe("");
  });
});

describe("preferredRecorderMimeType", () => {
  it("returns empty string when MediaRecorder is missing", () => {
    const original = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    try {
      expect(preferredRecorderMimeType()).toBe("");
    } finally {
      (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = original;
    }
  });

  it("picks the first supported mime type", () => {
    const isTypeSupported = vi.fn((t: string) => t === "audio/wav");
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
      isTypeSupported,
    };
    expect(preferredRecorderMimeType()).toBe("audio/wav");
  });

  it("prefers webm/opus when both are supported", () => {
    const isTypeSupported = vi.fn(() => true);
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
      isTypeSupported,
    };
    expect(preferredRecorderMimeType()).toBe("audio/webm;codecs=opus");
  });
});
