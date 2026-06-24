import type { FrameSnapshot } from "./types.js";
/** Decode a raw MessagePack payload into untyped JS. */
export declare function decode(buf: Uint8Array): unknown;
/**
 * Decode the payload the fork emits. Layout (see forensics.cc):
 *   map { "v": uint, "frames": [FrameSnapshot, ...] }
 */
export declare function decodeForensicPayload(buf: Uint8Array): {
    version: number;
    frames: FrameSnapshot[];
};
//# sourceMappingURL=msgpack-decoder.d.ts.map