export declare const init: (..._args: unknown[]) => void;
export declare const captureException: (..._args: unknown[]) => void;
export declare const captureMessage: (..._args: unknown[]) => void;
export declare const captureLog: (..._args: unknown[]) => void;
export declare const flush: (..._args: unknown[]) => Promise<void>;
export declare const addBreadcrumb: (..._args: unknown[]) => void;
export declare const setUser: (..._args: unknown[]) => void;
export declare const setTag: (..._args: unknown[]) => void;
export declare const setRequestContext: (..._args: unknown[]) => void;
export declare const runWithScope: <T>(_arg: unknown, fn: () => T) => T;
export declare const initFullTrace: (..._args: unknown[]) => void;
export declare const getSessionId: () => null;
export declare const setSessionId: (..._args: unknown[]) => void;
export declare const injectSessionHeader: (..._args: unknown[]) => Record<string, never>;
export type { CaptureConfig, ErrorEvent, Breadcrumb, Integration, FullTraceConfig, SessionConfig, SubstrateConfig, } from "../types.js";
//# sourceMappingURL=client-entry.d.ts.map