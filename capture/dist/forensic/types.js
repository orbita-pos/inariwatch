/**
 * Stable shape exposed to `@inariwatch/capture` and (later) to the
 * ForensicVM fork. The fork serializes frames to MessagePack, the peer
 * decodes into this same shape so core SDK code never knows which path
 * produced the capture.
 */
export const DEFAULT_OPTIONS = {
    maxFrames: 32,
    maxLocalsPerFrame: 50,
    maxValueDepth: 2,
    maxValueBytes: 1024,
    captureBudgetMs: 5,
    forceFallback: false,
    rethrowHookErrors: false,
};
//# sourceMappingURL=types.js.map