import type { Tool } from "./detect.js";
type ConfigResult = {
    tool: string;
    ok: boolean;
    error?: string;
};
export declare function configureTools(tools: Tool[], token: string): ConfigResult[];
export {};
