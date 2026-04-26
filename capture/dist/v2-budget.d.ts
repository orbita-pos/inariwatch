import type { ErrorEvent } from "./types.js";
export declare const V2_FIELD_DROP_PRIORITY: readonly ["causalGraph", "expected", "sourceContext.after", "precursors[3..]", "breadcrumbs[15..]", "forensics.closureChains", "forensics.locals", "runtimeSnap", "hypotheses"];
export declare function estimateTokens(value: unknown): number;
export interface BudgetResult {
    /** True if any drops happened */
    dropped: boolean;
    /** Names of fields dropped (for telemetry) */
    droppedFields: string[];
    /** Final estimated token count after drops */
    finalTokens: number;
}
/**
 * Mutates `event` to fit under `budgetTokens`. Returns drop summary.
 *
 * Always-on policy: the v1 fields (title, body, fingerprint, stack via body)
 * are NEVER touched. Only v2 additive fields drop.
 *
 * The function does NOT write `event.tokensEstimated` — the caller decides
 * whether to attach it. (Writing it from inside makes the function's reported
 * `finalTokens` no longer match `estimateTokens(event)` after return.)
 */
export declare function applyTokenBudget(event: ErrorEvent, budgetTokens?: number): BudgetResult;
//# sourceMappingURL=v2-budget.d.ts.map