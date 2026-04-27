/**
 * Sink hooks — monkey-patch dangerous operations (database queries,
 * shell commands, file I/O) to detect when tainted user input reaches them.
 *
 * Each hook wraps the original function: inspect args → report if tainted → call original.
 * If in block mode, throws before the original executes.
 */
import { inspectSink } from "./detect.js";
const hooked = new Set();
/** Hook all available sinks. Only hooks modules that are already installed. */
export function hookSinks(config, report) {
    const disabled = new Set(config.disableSinks ?? []);
    if (!disabled.has("pg"))
        hookPg(config, report);
    if (!disabled.has("mysql2"))
        hookMysql2(config, report);
    if (!disabled.has("child_process"))
        hookChildProcess(config, report);
    if (!disabled.has("fs"))
        hookFs(config, report);
}
// ── PostgreSQL (pg) ─────────────────────────────────────────────────────────
function hookPg(config, report) {
    if (hooked.has("pg"))
        return;
    try {
        const pg = globalThis.require("pg");
        // Hook Client.query
        const origClientQuery = pg.Client.prototype.query;
        pg.Client.prototype.query = function (...args) {
            const threat = inspectSink("pg.query", args, config);
            if (threat) {
                report(threat);
                if (config.mode === "block")
                    throw new Error(`[shield] Blocked: ${threat.vulnerability} in pg.query`);
            }
            return origClientQuery.apply(this, args);
        };
        // Hook Pool.query
        const origPoolQuery = pg.Pool.prototype.query;
        pg.Pool.prototype.query = function (...args) {
            const threat = inspectSink("pg.Pool.query", args, config);
            if (threat) {
                report(threat);
                if (config.mode === "block")
                    throw new Error(`[shield] Blocked: ${threat.vulnerability} in pg.Pool.query`);
            }
            return origPoolQuery.apply(this, args);
        };
        hooked.add("pg");
    }
    catch {
        // pg not installed — skip
    }
}
// ── MySQL (mysql2) ──────────────────────────────────────────────────────────
function hookMysql2(config, report) {
    if (hooked.has("mysql2"))
        return;
    try {
        const mysql2 = globalThis.require("mysql2");
        const Connection = mysql2.Connection?.prototype ?? Object.getPrototypeOf(mysql2.createConnection({}));
        if (Connection.query) {
            const origQuery = Connection.query;
            Connection.query = function (...args) {
                const threat = inspectSink("mysql2.query", args, config);
                if (threat) {
                    report(threat);
                    if (config.mode === "block")
                        throw new Error(`[shield] Blocked: ${threat.vulnerability} in mysql2.query`);
                }
                return origQuery.apply(this, args);
            };
        }
        if (Connection.execute) {
            const origExecute = Connection.execute;
            Connection.execute = function (...args) {
                const threat = inspectSink("mysql2.execute", args, config);
                if (threat) {
                    report(threat);
                    if (config.mode === "block")
                        throw new Error(`[shield] Blocked: ${threat.vulnerability} in mysql2.execute`);
                }
                return origExecute.apply(this, args);
            };
        }
        hooked.add("mysql2");
    }
    catch {
        // mysql2 not installed — skip
    }
}
// ── child_process ───────────────────────────────────────────────────────────
function hookChildProcess(config, report) {
    if (hooked.has("child_process"))
        return;
    try {
        const cp = globalThis.require("child_process");
        for (const fn of ["exec", "execSync"]) {
            const orig = cp[fn];
            if (!orig)
                continue;
            cp[fn] = function (...args) {
                const threat = inspectSink(`child_process.${fn}`, args, config);
                if (threat) {
                    report(threat);
                    if (config.mode === "block")
                        throw new Error(`[shield] Blocked: ${threat.vulnerability} in child_process.${fn}`);
                }
                return orig.apply(this, args);
            };
        }
        for (const fn of ["spawn", "spawnSync"]) {
            const orig = cp[fn];
            if (!orig)
                continue;
            cp[fn] = function (cmd, cmdArgs, ...rest) {
                // For spawn, check the command + args concatenated
                const fullCmd = Array.isArray(cmdArgs) ? `${cmd} ${cmdArgs.join(" ")}` : cmd;
                const threat = inspectSink(`child_process.${fn}`, [fullCmd], config);
                if (threat) {
                    report(threat);
                    if (config.mode === "block")
                        throw new Error(`[shield] Blocked: ${threat.vulnerability} in child_process.${fn}`);
                }
                return orig.call(this, cmd, cmdArgs, ...rest);
            };
        }
        hooked.add("child_process");
    }
    catch {
        // Should never happen — child_process is built-in
    }
}
// ── fs (file system) ────────────────────────────────────────────────────────
function hookFs(config, report) {
    if (hooked.has("fs"))
        return;
    try {
        const fs = globalThis.require("fs");
        for (const fn of ["readFile", "readFileSync", "writeFile", "writeFileSync"]) {
            const orig = fs[fn];
            if (!orig)
                continue;
            fs[fn] = function (...args) {
                const threat = inspectSink(`fs.${fn}`, args, config);
                if (threat) {
                    report(threat);
                    if (config.mode === "block")
                        throw new Error(`[shield] Blocked: ${threat.vulnerability} in fs.${fn}`);
                }
                return orig.apply(this, args);
            };
        }
        hooked.add("fs");
    }
    catch {
        // Should never happen — fs is built-in
    }
}
//# sourceMappingURL=sinks.js.map