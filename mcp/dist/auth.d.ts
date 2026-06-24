/**
 * Device flow authentication:
 * 1. Start a device code flow → get code
 * 2. Open browser to verify page
 * 3. Poll until user approves
 * 4. Return MCP token
 */
export declare function deviceAuth(): Promise<string | null>;
