/**
 * Nuxt 3 module — enables InariWatch capture in any Nuxt 3 app.
 *
 * Usage in nuxt.config.ts:
 *   export default defineNuxtConfig({
 *     modules: ["@inariwatch/capture/nuxt"],
 *   })
 *
 * What it does:
 *  1. Extracts git commit, branch, and message at build time.
 *  2. Exposes them via process.env.INARIWATCH_GIT_* and Nuxt runtime config.
 *  3. Marks @inariwatch/capture as a Nitro external so node: builtin imports
 *     don't get bundled into Nitro's edge build output.
 *
 * Shape: Nuxt's loader (`@nuxt/kit/dist/index.mjs` -> loadNuxtModuleInstance)
 * requires the default export to be a FUNCTION — objects are rejected with
 * "Nuxt module should be a function". @nuxt/kit's `defineNuxtModule` wraps
 * its object argument in a function internally; we do the same by hand to
 * avoid taking @nuxt/kit as a dependency.
 */
type NuxtRuntimeConfig = {
    public?: Record<string, unknown>;
    [key: string]: unknown;
};
type NuxtNitroConfig = {
    externals?: {
        external?: string[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
};
type NuxtOptions = {
    runtimeConfig?: NuxtRuntimeConfig;
    nitro?: NuxtNitroConfig;
    [key: string]: unknown;
};
type NuxtInstance = {
    options: NuxtOptions;
    [key: string]: unknown;
};
type NuxtModuleMeta = {
    name: string;
    configKey?: string;
    version?: string;
};
type NuxtModule = {
    (inlineOptions: Record<string, unknown> | undefined, nuxt: NuxtInstance): void | Promise<void>;
    getMeta?: () => Promise<NuxtModuleMeta>;
};
declare const inariwatchNuxt: NuxtModule;
export default inariwatchNuxt;
//# sourceMappingURL=nuxt.d.ts.map