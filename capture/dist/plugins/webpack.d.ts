/**
 * Webpack config wrapper — enables InariWatch capture in any webpack project.
 * Covers Create React App, Vue CLI, Angular, raw webpack, Craco, and legacy
 * Next.js (before the App Router).
 *
 * Usage in webpack.config.js:
 *   const { withInariWatchWebpack } = require("@inariwatch/capture/webpack")
 *   module.exports = withInariWatchWebpack({
 *     // your existing webpack config
 *   })
 *
 * What it does:
 *  1. Extracts git commit, branch, and message at build time.
 *  2. Exposes them via process.env.INARIWATCH_GIT_* so DefinePlugin users,
 *     and any code that reads process.env at build time, pick them up.
 *  3. If the target is Node (server-side build), marks @inariwatch/capture as
 *     an external so its node: builtin imports don't get bundled.
 */
type WebpackConfig = {
    externals?: unknown;
    target?: string | string[] | false;
    [key: string]: unknown;
};
export declare function withInariWatchWebpack<T extends WebpackConfig>(config?: T): T;
export default withInariWatchWebpack;
//# sourceMappingURL=webpack.d.ts.map