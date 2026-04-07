import { spawnSync } from "child_process";
const API_BASE = "https://app.inariwatch.com";
/**
 * Device flow authentication:
 * 1. Start a device code flow → get code
 * 2. Open browser to verify page
 * 3. Poll until user approves
 * 4. Return MCP token
 */
export async function deviceAuth() {
    console.log("\n  Authenticating via browser...");
    try {
        // Start device flow
        const startResp = await fetch(`${API_BASE}/api/cli/auth/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
        });
        if (!startResp.ok) {
            console.log("  Failed to start auth flow. Use --token instead.");
            return null;
        }
        const { code } = (await startResp.json());
        const verifyUrl = `${API_BASE}/cli/verify?code=${code}`;
        console.log(`  Code: ${code}`);
        console.log(`  Opening: ${verifyUrl}\n`);
        // Open browser (use spawnSync with args array to prevent injection)
        try {
            const opener = process.platform === "win32" ? "cmd" :
                process.platform === "darwin" ? "open" : "xdg-open";
            const args = process.platform === "win32" ? ["/c", "start", "", verifyUrl] : [verifyUrl];
            spawnSync(opener, args, { stdio: "pipe" });
        }
        catch {
            console.log(`  Could not open browser. Visit: ${verifyUrl}`);
        }
        // Poll for approval (max 5 minutes)
        const maxAttempts = 60;
        for (let i = 0; i < maxAttempts; i++) {
            await sleep(5000);
            process.stdout.write("  Waiting for approval...\r");
            const pollResp = await fetch(`${API_BASE}/api/cli/auth/poll?code=${code}`);
            if (pollResp.ok) {
                const data = (await pollResp.json());
                if (data.status === "approved" && data.apiToken) {
                    return data.apiToken;
                }
            }
        }
        console.log("\n  Auth timed out. Try again or use --token.");
        return null;
    }
    catch (e) {
        console.log(`  Auth error: ${e instanceof Error ? e.message : "unknown"}`);
        return null;
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
