"use strict";
/**
 * InariWatch Worker Server — runs on Hetzner alongside the Go container server.
 * Accepts remediation jobs and runs the AI container agent loop locally.
 *
 * Endpoints:
 *   POST /worker/run     — start a new agent job
 *   GET  /worker/job/:id — check job status
 *   GET  /worker/health  — health check
 */
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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
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
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
var node_http_1 = require("node:http");
var container_agent_js_1 = require("./container-agent.js");
var PORT = Number((_a = process.env.WORKER_PORT) !== null && _a !== void 0 ? _a : 9401);
var SECRET = (_b = process.env.STAGING_API_SECRET) !== null && _b !== void 0 ? _b : "";
var MAX_CONCURRENT = Number((_c = process.env.MAX_CONCURRENT_JOBS) !== null && _c !== void 0 ? _c : 2);
var jobs = new Map();
// Cleanup completed jobs after 10 minutes
setInterval(function () {
    var cutoff = Date.now() - 10 * 60 * 1000;
    for (var _i = 0, jobs_1 = jobs; _i < jobs_1.length; _i++) {
        var _a = jobs_1[_i], id = _a[0], job = _a[1];
        if (job.status !== "running" && job.startedAt < cutoff)
            jobs.delete(id);
    }
}, 60000);
// ── Auth ────────────────────────────────────────────────────────────────────
function checkAuth(req) {
    var _a;
    if (!SECRET)
        return false;
    var auth = (_a = req.headers.authorization) !== null && _a !== void 0 ? _a : "";
    return auth === "Bearer ".concat(SECRET);
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
function readBody(req) {
    return __awaiter(this, void 0, void 0, function () {
        var chunks, size, chunk, e_1_1;
        var _a, req_1, req_1_1;
        var _b, e_1, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    chunks = [];
                    size = 0;
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 6, 7, 12]);
                    _a = true, req_1 = __asyncValues(req);
                    _e.label = 2;
                case 2: return [4 /*yield*/, req_1.next()];
                case 3:
                    if (!(req_1_1 = _e.sent(), _b = req_1_1.done, !_b)) return [3 /*break*/, 5];
                    _d = req_1_1.value;
                    _a = false;
                    chunk = _d;
                    size += chunk.length;
                    if (size > 1024 * 1024)
                        throw new Error("Request body too large");
                    chunks.push(chunk);
                    _e.label = 4;
                case 4:
                    _a = true;
                    return [3 /*break*/, 2];
                case 5: return [3 /*break*/, 12];
                case 6:
                    e_1_1 = _e.sent();
                    e_1 = { error: e_1_1 };
                    return [3 /*break*/, 12];
                case 7:
                    _e.trys.push([7, , 10, 11]);
                    if (!(!_a && !_b && (_c = req_1.return))) return [3 /*break*/, 9];
                    return [4 /*yield*/, _c.call(req_1)];
                case 8:
                    _e.sent();
                    _e.label = 9;
                case 9: return [3 /*break*/, 11];
                case 10:
                    if (e_1) throw e_1.error;
                    return [7 /*endfinally*/];
                case 11: return [7 /*endfinally*/];
                case 12: return [2 /*return*/, Buffer.concat(chunks).toString()];
            }
        });
    });
}
// ── Routes ──────────────────────────────────────────────────────────────────
function handleRun(req, res) {
    return __awaiter(this, void 0, void 0, function () {
        var running, body, _a, _b, jobId, job;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    running = __spreadArray([], jobs.values(), true).filter(function (j) { return j.status === "running"; }).length;
                    if (running >= MAX_CONCURRENT) {
                        json(res, 503, { error: "At capacity (".concat(running, "/").concat(MAX_CONCURRENT, " jobs running)") });
                        return [2 /*return*/];
                    }
                    _b = (_a = JSON).parse;
                    return [4 /*yield*/, readBody(req)];
                case 1:
                    body = _b.apply(_a, [_c.sent()]);
                    if (!body.sessionId || !body.repoUrl || !body.aiKey) {
                        json(res, 400, { error: "Missing required fields: sessionId, repoUrl, aiKey" });
                        return [2 /*return*/];
                    }
                    jobId = body.sessionId;
                    job = { id: jobId, status: "running", startedAt: Date.now() };
                    jobs.set(jobId, job);
                    // Run in background — respond immediately
                    (0, container_agent_js_1.runAgentJob)(body).then(function (result) {
                        job.status = "completed";
                        job.result = result;
                        console.log("[".concat(jobId, "] completed in ").concat(result.turns, " turns (verified: ").concat(result.verified, ")"));
                    }).catch(function (err) {
                        job.status = "failed";
                        job.error = err instanceof Error ? err.message : String(err);
                        console.error("[".concat(jobId, "] failed: ").concat(job.error));
                    });
                    json(res, 202, { jobId: jobId, status: "running" });
                    return [2 /*return*/];
            }
        });
    });
}
function handleJobStatus(res, jobId) {
    var job = jobs.get(jobId);
    if (!job) {
        json(res, 404, { error: "Job not found" });
        return;
    }
    var response = {
        jobId: job.id,
        status: job.status,
        elapsed: Date.now() - job.startedAt,
    };
    if (job.result)
        response.result = job.result;
    if (job.error)
        response.error = job.error;
    json(res, 200, response);
}
function handleHealth(res, authenticated) {
    if (!authenticated) {
        json(res, 200, { ok: true });
        return;
    }
    var running = __spreadArray([], jobs.values(), true).filter(function (j) { return j.status === "running"; }).length;
    json(res, 200, {
        ok: true,
        activeJobs: running,
        maxJobs: MAX_CONCURRENT,
        uptime: Math.round(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
}
// ── Server ──────────────────────────────────────────────────────────────────
var server = (0, node_http_1.createServer)(function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var url, path, jobId, err_1;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                url = new URL((_a = req.url) !== null && _a !== void 0 ? _a : "/", "http://localhost:".concat(PORT));
                path = url.pathname;
                // Health check — basic ok for unauthenticated, detailed for authenticated
                if (req.method === "GET" && path === "/worker/health") {
                    handleHealth(res, checkAuth(req));
                    return [2 /*return*/];
                }
                // Auth for all other endpoints
                if (!checkAuth(req)) {
                    json(res, 401, { error: "Unauthorized" });
                    return [2 /*return*/];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 5, , 6]);
                if (!(req.method === "POST" && path === "/worker/run")) return [3 /*break*/, 3];
                return [4 /*yield*/, handleRun(req, res)];
            case 2:
                _b.sent();
                return [3 /*break*/, 4];
            case 3:
                if (req.method === "GET" && path.startsWith("/worker/job/")) {
                    jobId = path.split("/worker/job/")[1];
                    handleJobStatus(res, jobId);
                }
                else {
                    json(res, 404, { error: "Not found" });
                }
                _b.label = 4;
            case 4: return [3 /*break*/, 6];
            case 5:
                err_1 = _b.sent();
                console.error("[server] error:", err_1 instanceof Error ? err_1.message : String(err_1));
                json(res, 500, { error: "Internal server error" });
                return [3 /*break*/, 6];
            case 6: return [2 /*return*/];
        }
    });
}); });
server.listen(PORT, "0.0.0.0", function () {
    var _a;
    console.log("InariWatch Worker listening on port ".concat(PORT));
    console.log("Max concurrent jobs: ".concat(MAX_CONCURRENT));
    console.log("Go server: ".concat((_a = process.env.GO_SERVER_URL) !== null && _a !== void 0 ? _a : "http://localhost:9400"));
});
