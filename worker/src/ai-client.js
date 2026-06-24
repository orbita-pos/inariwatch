"use strict";
/**
 * AI client for the worker — extracted from web/lib/ai/client.ts.
 * Supports Claude, OpenAI, Grok, DeepSeek, Groq (tool use).
 * Zero dependencies — uses native fetch.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.callAIWithTools = callAIWithTools;
// ── Main dispatcher ─────────────────────────────────────────────────────────
function callAIWithTools(apiKey_1, systemPrompt_1, messages_1, tools_1) {
    return __awaiter(this, arguments, void 0, function (apiKey, systemPrompt, messages, tools, opts) {
        var provider;
        var _a;
        if (opts === void 0) { opts = {}; }
        return __generator(this, function (_b) {
            provider = (_a = opts.provider) !== null && _a !== void 0 ? _a : detectProvider(apiKey);
            switch (provider) {
                case "claude":
                    return [2 /*return*/, callClaudeWithTools(apiKey, systemPrompt, messages, tools, opts)];
                case "openai":
                    return [2 /*return*/, callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.openai.com/v1")];
                case "grok":
                    return [2 /*return*/, callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.x.ai/v1")];
                case "deepseek":
                    return [2 /*return*/, callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.deepseek.com/v1")];
                case "groq":
                    return [2 /*return*/, callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, "https://api.groq.com/openai/v1")];
                case "gemini":
                    // Gemini doesn't support tool use in this format — return empty
                    return [2 /*return*/, { stopReason: "end_turn", text: "Gemini does not support tool use" }];
            }
            return [2 /*return*/];
        });
    });
}
function detectProvider(key) {
    if (key.startsWith("sk-ant-"))
        return "claude";
    if (key.startsWith("xai-"))
        return "grok";
    if (key.startsWith("gsk_"))
        return "groq";
    if (key.startsWith("AIza"))
        return "gemini";
    return "openai";
}
// ── Claude ───────────────────────────────────────────────────────────────────
function callClaudeWithTools(apiKey, systemPrompt, messages, tools, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var res, _a, _b, _c, data, stopReason, content, textBlock;
        var _d, _e, _f, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0: return [4 /*yield*/, fetch("https://api.anthropic.com/v1/messages", {
                        method: "POST",
                        headers: {
                            "x-api-key": apiKey,
                            "anthropic-version": "2023-06-01",
                            "anthropic-beta": "prompt-caching-2024-07-31",
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            model: (_d = opts.model) !== null && _d !== void 0 ? _d : "claude-sonnet-4-6",
                            max_tokens: (_e = opts.maxTokens) !== null && _e !== void 0 ? _e : 4096,
                            system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
                            tools: tools.map(function (t) { return ({ name: t.name, description: t.description, input_schema: t.input_schema }); }),
                            messages: messages.map(function (m) { return ({ role: m.role, content: m.content }); }),
                        }),
                        signal: AbortSignal.timeout((_f = opts.timeout) !== null && _f !== void 0 ? _f : 90000),
                    })];
                case 1:
                    res = _h.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    _a = Error.bind;
                    _c = (_b = "Claude API error (".concat(res.status, "): ")).concat;
                    return [4 /*yield*/, res.text()];
                case 2: throw new (_a.apply(Error, [void 0, _c.apply(_b, [(_h.sent()).slice(0, 200)])]))();
                case 3: return [4 /*yield*/, safeJson(res)];
                case 4:
                    data = _h.sent();
                    stopReason = data.stop_reason;
                    content = data.content;
                    if (stopReason === "tool_use") {
                        return [2 /*return*/, { stopReason: "tool_use", content: content }];
                    }
                    textBlock = content.find(function (c) { return c.type === "text"; });
                    return [2 /*return*/, { stopReason: "end_turn", text: (_g = textBlock === null || textBlock === void 0 ? void 0 : textBlock.text) !== null && _g !== void 0 ? _g : "" }];
            }
        });
    });
}
// ── OpenAI-Compatible (OpenAI, Grok, DeepSeek, Groq) ────────────────────────
function translateMessagesForOpenAI(systemPrompt, messages) {
    var result = [
        { role: "system", content: systemPrompt },
    ];
    for (var _i = 0, messages_1 = messages; _i < messages_1.length; _i++) {
        var msg = messages_1[_i];
        if (typeof msg.content === "string") {
            result.push({ role: msg.role, content: msg.content });
            continue;
        }
        var blocks = msg.content;
        var toolUses = blocks.filter(function (b) { return b.type === "tool_use"; });
        var toolResults = blocks.filter(function (b) { return b.type === "tool_result"; });
        var textBlocks = blocks.filter(function (b) { return b.type === "text"; });
        if (toolUses.length > 0) {
            result.push({
                role: "assistant",
                content: textBlocks.map(function (b) { return b.text; }).join("\n") || null,
                tool_calls: toolUses.map(function (tu) { return ({
                    id: tu.id,
                    type: "function",
                    function: { name: tu.name, arguments: JSON.stringify(tu.input) },
                }); }),
            });
        }
        else if (toolResults.length > 0) {
            for (var _a = 0, toolResults_1 = toolResults; _a < toolResults_1.length; _a++) {
                var tr = toolResults_1[_a];
                result.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content });
            }
        }
        else if (textBlocks.length > 0) {
            result.push({ role: msg.role, content: textBlocks.map(function (b) { return b.text; }).join("\n") });
        }
    }
    return result;
}
function callOpenAICompatWithTools(apiKey, systemPrompt, messages, tools, opts, baseUrl) {
    return __awaiter(this, void 0, void 0, function () {
        var openaiTools, res, _a, _b, _c, data, choice, toolCalls, content, _i, toolCalls_1, tc, parsedInput;
        var _d, _e, _f, _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    openaiTools = tools.map(function (t) { return ({
                        type: "function",
                        function: { name: t.name, description: t.description, parameters: t.input_schema },
                    }); });
                    return [4 /*yield*/, fetch("".concat(baseUrl, "/chat/completions"), {
                            method: "POST",
                            headers: {
                                Authorization: "Bearer ".concat(apiKey),
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                model: (_d = opts.model) !== null && _d !== void 0 ? _d : "gpt-4o",
                                max_tokens: (_e = opts.maxTokens) !== null && _e !== void 0 ? _e : 4096,
                                tools: openaiTools,
                                messages: translateMessagesForOpenAI(systemPrompt, messages),
                            }),
                            signal: AbortSignal.timeout((_f = opts.timeout) !== null && _f !== void 0 ? _f : 90000),
                        })];
                case 1:
                    res = _j.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    _a = Error.bind;
                    _c = (_b = "API error (".concat(res.status, "): ")).concat;
                    return [4 /*yield*/, res.text()];
                case 2: throw new (_a.apply(Error, [void 0, _c.apply(_b, [(_j.sent()).slice(0, 200)])]))();
                case 3: return [4 /*yield*/, safeJson(res)];
                case 4:
                    data = _j.sent();
                    choice = (_g = data.choices) === null || _g === void 0 ? void 0 : _g[0];
                    if (!choice)
                        throw new Error("No response from API");
                    toolCalls = choice.message.tool_calls;
                    if (toolCalls && toolCalls.length > 0) {
                        content = [];
                        if (choice.message.content)
                            content.push({ type: "text", text: choice.message.content });
                        for (_i = 0, toolCalls_1 = toolCalls; _i < toolCalls_1.length; _i++) {
                            tc = toolCalls_1[_i];
                            parsedInput = void 0;
                            try {
                                parsedInput = JSON.parse(tc.function.arguments);
                            }
                            catch (_k) {
                                parsedInput = { raw: tc.function.arguments };
                            }
                            content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsedInput });
                        }
                        return [2 /*return*/, { stopReason: "tool_use", content: content }];
                    }
                    return [2 /*return*/, { stopReason: "end_turn", text: (_h = choice.message.content) !== null && _h !== void 0 ? _h : "" }];
            }
        });
    });
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function safeJson(res) {
    return __awaiter(this, void 0, void 0, function () {
        var text;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, res.text()];
                case 1:
                    text = _a.sent();
                    try {
                        return [2 /*return*/, JSON.parse(text)];
                    }
                    catch (_b) {
                        throw new Error("API returned non-JSON (".concat(res.status, "): ").concat(text.slice(0, 200)));
                    }
                    return [2 /*return*/];
            }
        });
    });
}
