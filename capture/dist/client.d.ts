import type { CaptureConfig } from "./types.js";
/** Flush all pending events — call this before process exit or serverless return. */
export declare function flush(): Promise<void>;
export declare function init(config?: CaptureConfig): void;
export declare function captureException(error: Error, context?: Record<string, unknown>): void;
export declare function captureMessage(message: string, level?: "info" | "warning" | "critical"): void;
export declare function captureLog(message: string, level?: "debug" | "info" | "warn" | "error" | "fatal", metadata?: Record<string, unknown>): void;
//# sourceMappingURL=client.d.ts.map