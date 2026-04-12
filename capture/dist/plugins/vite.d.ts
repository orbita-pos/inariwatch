/**
 * Vite plugin — enables InariWatch capture in any Vite-based project.
 * Covers Vite, Nuxt (when used via vite build), Remix, SvelteKit, Astro,
 * SolidStart, Qwik, and any other framework that builds with Vite.
 *
 * Usage in vite.config.ts:
 *   import { inariwatchVite } from "@inariwatch/capture/vite"
 *   export default defineConfig({
 *     plugins: [inariwatchVite()],
 *   })
 *
 * What it does:
 *  1. Extracts git commit, branch, and message at build time.
 *  2. Exposes them as process.env.INARIWATCH_GIT_* both at build and runtime.
 *  3. Marks @inariwatch/capture as SSR-external so Node internals (node:crypto,
 *     etc.) don't get bundled into client code.
 */
type ViteUserConfig = {
    define?: Record<string, unknown>;
    ssr?: {
        external?: string[] | true;
        noExternal?: string[] | string | RegExp | Array<string | RegExp> | true;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};
type VitePlugin = {
    name: string;
    enforce?: "pre" | "post";
    config?: (config: ViteUserConfig, env: {
        command: string;
        mode: string;
    }) => ViteUserConfig | null | undefined | void;
};
export declare function inariwatchVite(): VitePlugin;
export default inariwatchVite;
//# sourceMappingURL=vite.d.ts.map