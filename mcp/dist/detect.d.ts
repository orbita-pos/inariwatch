export type Tool = {
    name: string;
    id: string;
    detected: boolean;
    version?: string;
};
export declare function detectTools(): Tool[];
export type GitHubAuth = {
    token: string;
    user: string;
};
/**
 * Detect if `gh` CLI is installed and authenticated.
 * Returns token + username, or null if not available.
 * Never throws — silent skip if gh is missing or not logged in.
 */
export declare function detectGitHub(): GitHubAuth | null;
