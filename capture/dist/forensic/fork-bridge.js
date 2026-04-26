function getBinding() {
    const versions = process.versions;
    if (!versions.iw_forensic)
        return null;
    // Not wired on stock Node. Real implementation lands with the fork patch.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const binding = process.binding?.("iw_forensic");
    return binding ?? null;
}
export function isAvailable() {
    return getBinding() !== null;
}
export async function install(_hook, _options) {
    if (!isAvailable()) {
        throw new Error("@inariwatch/node-forensic: fork bridge not available on this runtime");
    }
    // Placeholder. Fork integration lands in a follow-up once the V8 patch
    // compiles and the N-API shim is published.
    throw new Error("@inariwatch/node-forensic: fork bridge not yet implemented — use fallback");
}
export async function uninstall() {
    // No-op until the fork bridge is wired.
}
//# sourceMappingURL=fork-bridge.js.map