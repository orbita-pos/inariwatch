export type ProjectType = "nextjs" | "node" | "unknown";
export type ProjectInfo = {
    type: ProjectType;
    hasCapture: boolean;
    packageManager: "npm" | "yarn" | "pnpm" | "bun";
};
export declare function detectProject(cwd?: string): ProjectInfo | null;
export declare function installCapture(project: ProjectInfo, cwd?: string): {
    ok: boolean;
    error?: string;
};
/**
 * Prompt the user to enable Substrate I/O recording.
 * Returns true if enabled, false if skipped.
 */
export declare function promptSubstrate(cwd?: string): Promise<boolean>;
export declare function ask(question: string): Promise<string>;
