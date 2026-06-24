/**
 * In-tree stub for optional capture peer deps that the SDK references but
 * isn't installed in this test harness's node_modules tree.
 *
 * The SDK's causal-hook code paths catch import errors at runtime and
 * treat the absence as "feature disabled", but Vite's dependency scanner
 * doesn't know that — it walks every static import and fails the dev
 * server boot when any unresolved id remains. The vite.config.ts alias
 * routes those ids here so resolution succeeds with a no-op shim.
 *
 * If the visual-report SDK code path ever calls something defined in
 * one of the shimmed modules (it shouldn't — those paths are causal-
 * tracing only), the consumer would get `undefined` and crash. That
 * crash is informative: it means visual-report grew an unintended
 * dependency.
 */
export default {};
export {};
