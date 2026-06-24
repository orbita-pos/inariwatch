import { addBreadcrumb } from "./scope.js";
import { type Transport } from "./transport.js";
import type { Config, ErrorEvent } from "./types.js";
export declare function init(cfg?: Config): void;
export declare function setTransportForTesting(t: Transport): void;
export declare function resetForTesting(): void;
export declare function captureException(err: unknown, extra?: Record<string, unknown>): Promise<void>;
export declare function captureMessage(message: string, severity?: ErrorEvent["severity"]): Promise<void>;
export declare function captureLog(message: string, level: string, metadata?: Record<string, unknown>): Promise<void>;
export declare function flush(timeoutMs?: number): Promise<void>;
export { addBreadcrumb };
//# sourceMappingURL=client.d.ts.map