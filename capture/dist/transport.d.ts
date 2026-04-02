import type { CaptureConfig, ErrorEvent, ParsedDSN } from "./types.js";
export declare function parseDSN(dsn: string): ParsedDSN;
export interface Transport {
    send(event: ErrorEvent): void;
    flush(): Promise<void>;
}
export declare function createLocalTransport(_config: CaptureConfig): Transport;
export declare function createTransport(config: CaptureConfig, parsed: ParsedDSN): Transport;
//# sourceMappingURL=transport.d.ts.map