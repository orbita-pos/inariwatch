import type { ForensicHook, ForensicOptions } from "./types.js";
export declare function install(hook: ForensicHook, options?: ForensicOptions): Promise<void>;
export declare function uninstall(): Promise<void>;
/** Escape hatch for tests that need to know whether the fallback is live. */
export declare function __isInstalled(): boolean;
//# sourceMappingURL=fallback-inspector.d.ts.map