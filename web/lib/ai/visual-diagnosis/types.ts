/**
 * Bundle shape mirrored from `@inariwatch/capture/visual-report`'s
 * `CaptureBundle`. Re-declared here so the server doesn't take a
 * runtime dependency on the SDK package (which is browser-targeted).
 * Keep these two definitions in sync — a mismatch would only surface
 * at runtime as missing fields, never a compile error.
 */

export interface CaptureBundle {
  url:        string;
  userAgent:  string;
  viewport:   { width: number; height: number; dpr: number };
  buildId:    string | null;
  capturedAt: number;
  focused:    FocusedElementInfo | null;
  console:    ConsoleEntry[];
  network:    NetworkEntry[];
  webVitals?: WebVitalsSnapshot;
  memory?:    MemorySnapshot;
  captureMs:  number;
}

export interface FocusedElementInfo {
  outerHtml: string;
  selector:  string;
  styles:    Record<string, string>;
  ax:        { tag: string; role: string | null; name: string | null; disabled: boolean };
  rect:      { x: number; y: number; w: number; h: number };
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  ts:    number;
  args:  unknown[];
  site:  string | null;
}

export interface NetworkEntry {
  url:    string;
  method: string;
  status: number | null;
  ts:     number;
  durMs:  number | null;
  size:   number | null;
  source: "fetch" | "xhr" | "performance";
}

export interface WebVitalsSnapshot {
  lcp?: number; cls?: number; inp?: number; fcp?: number; ttfb?: number;
}

export interface MemorySnapshot {
  used:  number;
  total: number;
  limit: number;
}
