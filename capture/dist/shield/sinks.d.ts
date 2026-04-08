/**
 * Sink hooks — monkey-patch dangerous operations (database queries,
 * shell commands, file I/O) to detect when tainted user input reaches them.
 *
 * Each hook wraps the original function: inspect args → report if tainted → call original.
 * If in block mode, throws before the original executes.
 */
import type { ShieldConfig, SecurityContext } from "../types.js";
type ReportFn = (ctx: SecurityContext) => void;
/** Hook all available sinks. Only hooks modules that are already installed. */
export declare function hookSinks(config: ShieldConfig, report: ReportFn): void;
export {};
//# sourceMappingURL=sinks.d.ts.map