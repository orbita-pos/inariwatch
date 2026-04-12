"use strict";
/**
 * Container agent — runs the AI loop on Hetzner.
 * Same logic as web/lib/ai/container-agent.ts but calls Docker containers
 * on localhost via the Go server (~1ms vs 80-120ms from Vercel).
 *
 * Writes progress to Neon DB for Vercel SSE to poll.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContainer = createContainer;
exports.destroyContainer = destroyContainer;
exports.runAgentJob = runAgentJob;
var ai_client_js_1 = require("./ai-client.js");
var db_js_1 = require("./db.js");
var drizzle_orm_1 = require("drizzle-orm");
var MAX_TURNS = 40; // More turns than Vercel (was 15)
var MAX_FILE_SIZE = 15000;
var MAX_OUTPUT_SIZE = 10000;
var EXEC_TIMEOUT = 120;
var READ_TIMEOUT = 10;
// ── Blocked files/commands (same as web version) ────────────────────────────
var BLOCKED_FILE_PATTERNS = [
    /^\.env/, /\.env$/, /secrets?\./i, /credentials?\./i, /private[_-]?key/i,
    /\.pem$/, /\.key$/, /\.cert$/, /\.p12$/, /\.pfx$/, /serviceaccount/i, /token\.json$/i,
];
var BLOCKED_WRITE_PATTERNS = __spreadArray(__spreadArray([], BLOCKED_FILE_PATTERNS, true), [
    /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /bun\.lockb$/,
    /^node_modules\//, /\/node_modules\//,
], false);
var ALLOWED_COMMANDS = [
    "npm", "npx", "node", "tsc", "git", "cat", "ls", "grep", "find",
    "mkdir", "cp", "head", "tail", "wc", "diff", "echo", "pwd", "which",
    "pnpm", "yarn", "bun",
];
var BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+\//, /\bsudo\b/, /\bchmod\b/, /\bchown\b/, /\bkill\b/, /\bpkill\b/,
    /\bcurl\b/, /\bwget\b/, /\bnc\b/, /\bdd\b/, /\bmkfs\b/, /\bfdisk\b/,
    />\s*\/dev\//, /\|.*\bsh\b/, /\|.*\bbash\b/, /\bsh\s+-c\b/, /\bbash\s+-c\b/, /\bsh\s+[<>|]/,
    /\$\(/, /`[^']*`/, /;\s*\w/, // subshell $(), backticks, semicolon chaining
];
function isBlockedFile(path) {
    var _a;
    var filename = (_a = path.split("/").pop()) !== null && _a !== void 0 ? _a : path;
    return BLOCKED_FILE_PATTERNS.some(function (p) { return p.test(filename) || p.test(path); });
}
function isBlockedWrite(path) {
    var _a;
    var filename = (_a = path.split("/").pop()) !== null && _a !== void 0 ? _a : path;
    return BLOCKED_WRITE_PATTERNS.some(function (p) { return p.test(filename) || p.test(path); });
}
function isCommandAllowed(command) {
    for (var _i = 0, BLOCKED_PATTERNS_1 = BLOCKED_PATTERNS; _i < BLOCKED_PATTERNS_1.length; _i++) {
        var pattern = BLOCKED_PATTERNS_1[_i];
        if (pattern.test(command))
            return { allowed: false, reason: "Command blocked: matches dangerous pattern" };
    }
    var baseCommand = command.trim().split(/\s+/)[0].replace(/^\.\//, "");
    if (!ALLOWED_COMMANDS.includes(baseCommand)) {
        return { allowed: false, reason: "Command \"".concat(baseCommand, "\" is not in the allowed list") };
    }
    return { allowed: true };
}
function shellEscape(s) {
    return "'".concat(s.replace(/'/g, "'\\''"), "'");
}
// ── Tool definitions ────────────────────────────────────────────────────────
var CONTAINER_TOOLS = [
    { name: "read_file", description: "Read a file from the repository (up to 15K chars).", input_schema: { type: "object", properties: { path: { type: "string", description: "File path relative to repo root" } }, required: ["path"] } },
    { name: "search_code", description: "Search the codebase for patterns using grep.", input_schema: { type: "object", properties: { query: { type: "string", description: "Search string or regex" } }, required: ["query"] } },
    { name: "list_directory", description: "List directory contents. Excludes node_modules and .git.", input_schema: { type: "object", properties: { prefix: { type: "string", description: "Directory path (e.g. 'src/')" } } } },
    { name: "write_file", description: "Write complete file contents. Always provide COMPLETE content.", input_schema: { type: "object", properties: { path: { type: "string", description: "File path" }, content: { type: "string", description: "Complete file content" } }, required: ["path", "content"] } },
    { name: "run_command", description: "Run a shell command for verification: 'npx tsc --noEmit', 'npm run build', 'npm test'.", input_schema: { type: "object", properties: { command: { type: "string", description: "Shell command" } }, required: ["command"] } },
    { name: "submit_fix", description: "Signal fix is complete. ONLY call after tsc and build pass.", input_schema: { type: "object", properties: { explanation: { type: "string" }, files_changed: { type: "array", items: { type: "string" } } }, required: ["explanation", "files_changed"] } },
];
// ── Container API (localhost Go server) ──────────────────────────────────────
var GO_SERVER = (_a = process.env.GO_SERVER_URL) !== null && _a !== void 0 ? _a : "http://localhost:9400";
var STAGING_SECRET = (_b = process.env.STAGING_API_SECRET) !== null && _b !== void 0 ? _b : "";
function containerFetch(containerId_1, path_1, body_1) {
    return __awaiter(this, arguments, void 0, function (containerId, path, body, timeoutMs) {
        var res, text;
        if (timeoutMs === void 0) { timeoutMs = 30000; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fetch("".concat(GO_SERVER, "/container/").concat(containerId).concat(path), {
                        method: "POST",
                        headers: { "Authorization": "Bearer ".concat(STAGING_SECRET), "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(timeoutMs),
                    })];
                case 1:
                    res = _a.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.text().catch(function () { return ""; })];
                case 2:
                    text = _a.sent();
                    throw new Error("Container API error (".concat(res.status, "): ").concat(text.slice(0, 200)));
                case 3: return [2 /*return*/, res.json()];
            }
        });
    });
}
function containerExec(containerId_1, command_1) {
    return __awaiter(this, arguments, void 0, function (containerId, command, timeoutSeconds) {
        var data;
        var _a, _b, _c;
        if (timeoutSeconds === void 0) { timeoutSeconds = EXEC_TIMEOUT; }
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, containerFetch(containerId, "/exec", {
                        command: command,
                        timeout_seconds: timeoutSeconds, workdir: "/workspace/repo",
                    }, (timeoutSeconds + 10) * 1000)];
                case 1:
                    data = _d.sent();
                    return [2 /*return*/, {
                            exitCode: data.exit_code,
                            stdout: ((_a = data.stdout) !== null && _a !== void 0 ? _a : "").slice(0, MAX_OUTPUT_SIZE),
                            stderr: ((_b = data.stderr) !== null && _b !== void 0 ? _b : "").slice(0, MAX_OUTPUT_SIZE),
                            durationMs: (_c = data.duration_ms) !== null && _c !== void 0 ? _c : 0,
                        }];
            }
        });
    });
}
function containerWrite(containerId, filePath, content) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, containerFetch(containerId, "/write", { path: filePath, content: content })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// ── Tool executor ───────────────────────────────────────────────────────────
function executeContainerTool(tool, containerId) {
    return __awaiter(this, void 0, void 0, function () {
        var input, _a, result, result, prefix, result, check, result;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    input = tool.input;
                    _a = tool.name;
                    switch (_a) {
                        case "read_file": return [3 /*break*/, 1];
                        case "search_code": return [3 /*break*/, 3];
                        case "list_directory": return [3 /*break*/, 5];
                        case "write_file": return [3 /*break*/, 7];
                        case "run_command": return [3 /*break*/, 9];
                        case "submit_fix": return [3 /*break*/, 11];
                    }
                    return [3 /*break*/, 12];
                case 1:
                    if (isBlockedFile(input.path))
                        return [2 /*return*/, "Error: Access to this file is blocked for security."];
                    return [4 /*yield*/, containerExec(containerId, "cat ".concat(shellEscape(input.path)), READ_TIMEOUT)];
                case 2:
                    result = _c.sent();
                    if (result.exitCode !== 0)
                        return [2 /*return*/, "Error: File not found or unreadable.\n".concat(result.stderr)];
                    return [2 /*return*/, result.stdout.slice(0, MAX_FILE_SIZE)];
                case 3: return [4 /*yield*/, containerExec(containerId, "grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' --include='*.mjs' --include='*.cjs' ".concat(shellEscape(input.query), " . 2>/dev/null | head -50"))];
                case 4:
                    result = _c.sent();
                    return [2 /*return*/, result.stdout || "No matches found."];
                case 5:
                    prefix = (_b = input.prefix) !== null && _b !== void 0 ? _b : ".";
                    return [4 /*yield*/, containerExec(containerId, "find ".concat(shellEscape(prefix), " -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' 2>/dev/null | head -200"))];
                case 6:
                    result = _c.sent();
                    return [2 /*return*/, result.stdout || "Empty directory or not found."];
                case 7:
                    if (isBlockedWrite(input.path))
                        return [2 /*return*/, "Error: Writing to this file is blocked for security."];
                    return [4 /*yield*/, containerWrite(containerId, input.path, input.content)];
                case 8:
                    _c.sent();
                    return [2 /*return*/, "Written ".concat(input.content.length, " chars to ").concat(input.path)];
                case 9:
                    check = isCommandAllowed(input.command);
                    if (!check.allowed)
                        return [2 /*return*/, "Error: ".concat(check.reason)];
                    return [4 /*yield*/, containerExec(containerId, input.command)];
                case 10:
                    result = _c.sent();
                    return [2 /*return*/, [
                            "Exit code: ".concat(result.exitCode),
                            result.stdout ? "Stdout:\n".concat(result.stdout) : null,
                            result.stderr ? "Stderr:\n".concat(result.stderr) : null,
                            "Duration: ".concat(result.durationMs, "ms"),
                        ].filter(Boolean).join("\n")];
                case 11: return [2 /*return*/, JSON.stringify({ explanation: input.explanation, files_changed: tool.input.files_changed })];
                case 12: return [2 /*return*/, "Unknown tool: ".concat(tool.name)];
            }
        });
    });
}
// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt() {
    return "You are an expert software engineer fixing a production bug.\nYou are working inside a container with the repository at /workspace/repo.\n\nYou have tools to explore, modify, and VERIFY code:\n- read_file: Read files from the repo\n- search_code: Search for patterns using grep\n- list_directory: List directory contents\n- write_file: Write/modify files (apply your fix)\n- run_command: Run shell commands (tsc, build, test)\n- submit_fix: Signal completion (ONLY after verification)\n\nWORKFLOW:\n1. Read the file(s) mentioned in the error/stack trace\n2. Check imports to understand what libraries the project uses\n3. Read package.json if you need to know the tech stack\n4. Apply your fix using write_file with COMPLETE file contents\n5. VERIFY: run_command \"npx tsc --noEmit\" \u2014 MUST pass\n6. VERIFY: run_command \"npm run build\" \u2014 MUST pass (if applicable)\n7. OPTIONAL: run_command \"npm test\" \u2014 non-blocking\n8. If tsc or build FAILS, read the error, fix it with write_file, and re-verify\n9. When ALL checks pass, call submit_fix with the list of files you changed\n\nCRITICAL RULES:\n- NEVER call submit_fix before tsc passes\n- Use the same libraries and APIs the project already uses (check imports)\n- If the project uses an ORM (Drizzle, Prisma), use its query builder \u2014 never raw SQL\n- Make MINIMUM changes to fix the bug \u2014 do not refactor unrelated code\n- Never modify .env files, lock files, migrations, or CI workflows\n- If tsc fails, DO NOT give up \u2014 read the error message and fix the issue\n\nRespond ONLY with tool calls. Do not output free text.";
}
// ── Progress tracking ───────────────────────────────────────────────────────
function updateProgress(sessionId, step) {
    return __awaiter(this, void 0, void 0, function () {
        var session, steps, _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, db_js_1.db.select({ steps: db_js_1.remediationSessions.steps })
                            .from(db_js_1.remediationSessions).where((0, drizzle_orm_1.eq)(db_js_1.remediationSessions.id, sessionId)).limit(1)];
                case 1:
                    session = (_d.sent())[0];
                    steps = ((_b = session === null || session === void 0 ? void 0 : session.steps) !== null && _b !== void 0 ? _b : []);
                    steps.push(__assign(__assign({}, step), { detail: (_c = step.detail) === null || _c === void 0 ? void 0 : _c.slice(0, 500) }));
                    return [4 /*yield*/, db_js_1.db.update(db_js_1.remediationSessions).set({ steps: steps }).where((0, drizzle_orm_1.eq)(db_js_1.remediationSessions.id, sessionId))];
                case 2:
                    _d.sent();
                    return [3 /*break*/, 4];
                case 3:
                    _a = _d.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ── Container lifecycle ─────────────────────────────────────────────────────
function createContainer(repoUrl, branch, githubToken, sessionId) {
    return __awaiter(this, void 0, void 0, function () {
        var containerId, res, text;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    containerId = "agent-".concat(sessionId.slice(0, 8), "-").concat(Date.now().toString(36));
                    return [4 /*yield*/, fetch("".concat(GO_SERVER, "/container"), {
                            method: "POST",
                            headers: { "Authorization": "Bearer ".concat(STAGING_SECRET), "Content-Type": "application/json" },
                            body: JSON.stringify({ id: containerId, repo_url: repoUrl, branch: branch, github_token: githubToken, ttl_seconds: 600 }),
                            signal: AbortSignal.timeout(120000),
                        })];
                case 1:
                    res = _a.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.text().catch(function () { return ""; })];
                case 2:
                    text = _a.sent();
                    throw new Error("Failed to create container (".concat(res.status, "): ").concat(text.slice(0, 200)));
                case 3: return [2 /*return*/, containerId];
            }
        });
    });
}
function destroyContainer(containerId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, fetch("".concat(GO_SERVER, "/container/").concat(containerId), {
                            method: "DELETE",
                            headers: { "Authorization": "Bearer ".concat(STAGING_SECRET) },
                            signal: AbortSignal.timeout(10000),
                        })];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function runAgentJob(params) {
    return __awaiter(this, void 0, void 0, function () {
        var sessionId, repoUrl, branch, githubToken, aiKey, aiProvider, exploreModel, fixModel, errorContext, maxTurns, containerId, systemPrompt, messages, tscPassed, buildPassed, testsPassed, turn, isNearEnd, currentModel, response, assistantContent, toolUses, toolResults, _i, toolUses_1, toolUse, result, cmd, exitCode, submission, files, _a, _b, filePath, readResult, err_1, errMsg;
        var _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    sessionId = params.sessionId, repoUrl = params.repoUrl, branch = params.branch, githubToken = params.githubToken, aiKey = params.aiKey, aiProvider = params.aiProvider, exploreModel = params.exploreModel, fixModel = params.fixModel, errorContext = params.errorContext;
                    maxTurns = (_c = params.maxTurns) !== null && _c !== void 0 ? _c : MAX_TURNS;
                    // 1. Create container (localhost — fast)
                    return [4 /*yield*/, updateProgress(sessionId, { name: "container_create", status: "in_progress", detail: "Creating Docker container..." })];
                case 1:
                    // 1. Create container (localhost — fast)
                    _e.sent();
                    return [4 /*yield*/, createContainer(repoUrl, branch, githubToken, sessionId)];
                case 2:
                    containerId = _e.sent();
                    return [4 /*yield*/, updateProgress(sessionId, { name: "container_create", status: "completed", detail: "Container ".concat(containerId, " ready") })];
                case 3:
                    _e.sent();
                    _e.label = 4;
                case 4:
                    _e.trys.push([4, , 24, 26]);
                    systemPrompt = buildSystemPrompt();
                    messages = [{ role: "user", content: errorContext }];
                    tscPassed = false, buildPassed = false, testsPassed = false;
                    turn = 1;
                    _e.label = 5;
                case 5:
                    if (!(turn <= maxTurns)) return [3 /*break*/, 23];
                    return [4 /*yield*/, updateProgress(sessionId, {
                            name: "container_turn",
                            status: "in_progress",
                            detail: "Turn ".concat(turn, "/").concat(maxTurns),
                        })];
                case 6:
                    _e.sent();
                    isNearEnd = turn > maxTurns - 3;
                    currentModel = isNearEnd ? fixModel : exploreModel;
                    return [4 /*yield*/, (0, ai_client_js_1.callAIWithTools)(aiKey, systemPrompt, messages, CONTAINER_TOOLS, {
                            maxTokens: 4096, model: currentModel, timeout: 90000, provider: aiProvider,
                        })];
                case 7:
                    response = _e.sent();
                    if (response.stopReason === "end_turn") {
                        messages.push({ role: "assistant", content: response.text });
                        messages.push({ role: "user", content: "You must use a tool. Write your fix with write_file, verify with run_command, then call submit_fix when tsc and build pass." });
                        return [3 /*break*/, 22];
                    }
                    assistantContent = response.content;
                    toolUses = assistantContent.filter(function (b) { return b.type === "tool_use"; });
                    messages.push({ role: "assistant", content: assistantContent });
                    toolResults = [];
                    _i = 0, toolUses_1 = toolUses;
                    _e.label = 8;
                case 8:
                    if (!(_i < toolUses_1.length)) return [3 /*break*/, 21];
                    toolUse = toolUses_1[_i];
                    _e.label = 9;
                case 9:
                    _e.trys.push([9, 19, , 20]);
                    return [4 /*yield*/, executeContainerTool(toolUse, containerId)];
                case 10:
                    result = _e.sent();
                    if (!(toolUse.name === "run_command")) return [3 /*break*/, 12];
                    cmd = toolUse.input.command;
                    exitCode = (_d = result.match(/^Exit code: (\d+)/)) === null || _d === void 0 ? void 0 : _d[1];
                    if (cmd.includes("tsc") && exitCode === "0")
                        tscPassed = true;
                    if (cmd.includes("tsc") && exitCode !== "0")
                        tscPassed = false;
                    if (cmd.includes("build") && exitCode === "0")
                        buildPassed = true;
                    if (cmd.includes("test") && exitCode === "0")
                        testsPassed = true;
                    return [4 /*yield*/, updateProgress(sessionId, {
                            name: "exec_".concat(cmd.split(/\s+/).slice(0, 2).join("_")),
                            status: exitCode === "0" ? "completed" : "failed",
                            detail: "".concat(cmd, " \u2192 exit ").concat(exitCode),
                        })];
                case 11:
                    _e.sent();
                    _e.label = 12;
                case 12:
                    if (!(toolUse.name === "submit_fix")) return [3 /*break*/, 18];
                    submission = JSON.parse(result);
                    files = [];
                    _a = 0, _b = submission.files_changed;
                    _e.label = 13;
                case 13:
                    if (!(_a < _b.length)) return [3 /*break*/, 16];
                    filePath = _b[_a];
                    return [4 /*yield*/, containerExec(containerId, "cat ".concat(shellEscape(filePath)), READ_TIMEOUT)];
                case 14:
                    readResult = _e.sent();
                    if (readResult.exitCode === 0 && readResult.stdout) {
                        files.push({ path: filePath, content: readResult.stdout });
                    }
                    _e.label = 15;
                case 15:
                    _a++;
                    return [3 /*break*/, 13];
                case 16: return [4 /*yield*/, updateProgress(sessionId, {
                        name: "container_done",
                        status: "completed",
                        detail: "Fixed in ".concat(turn, " turns. Verified: ").concat(tscPassed && buildPassed, ". Tests: ").concat(testsPassed),
                    })];
                case 17:
                    _e.sent();
                    return [2 /*return*/, { explanation: submission.explanation, files: files, turns: turn, verified: tscPassed && buildPassed, testsPassed: testsPassed }];
                case 18:
                    toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
                    return [3 /*break*/, 20];
                case 19:
                    err_1 = _e.sent();
                    errMsg = err_1 instanceof Error ? err_1.message : String(err_1);
                    toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Error: ".concat(errMsg), is_error: true });
                    return [3 /*break*/, 20];
                case 20:
                    _i++;
                    return [3 /*break*/, 8];
                case 21:
                    messages.push({ role: "user", content: toolResults });
                    _e.label = 22;
                case 22:
                    turn++;
                    return [3 /*break*/, 5];
                case 23: throw new Error("Agent did not submit fix after ".concat(maxTurns, " turns"));
                case 24: return [4 /*yield*/, destroyContainer(containerId)];
                case 25:
                    _e.sent();
                    return [7 /*endfinally*/];
                case 26: return [2 /*return*/];
            }
        });
    });
}
