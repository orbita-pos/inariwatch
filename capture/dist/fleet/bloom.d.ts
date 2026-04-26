/**
 * SDK-side fleet bloom — read-only deserialize + has().
 *
 * MUST stay byte-identical to web/lib/fleet-bloom/bloom.ts. Wire format
 * pinned by both sides' tests; a regression in either is caught locally.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Why a copy and not a shared package:
 *   - Server side uses node:crypto natively; SDK side must work in any
 *     Node 18+ environment (also browser via webcrypto, but bloom is
 *     server-process only for now).
 *   - Avoids an import cycle: web/lib/fleet-bloom imports bloom; SDK also
 *     imports bloom; if shared, the package would have to ship both for
 *     web and end users which adds friction.
 *   - The math is ~50 LoC and changes monthly at most.
 */
export interface BloomFilter {
    m: number;
    k: number;
    count: number;
    bits: Buffer;
}
export declare function deserialize(buf: Buffer): BloomFilter;
export declare function has(bloom: BloomFilter, item: string): boolean;
//# sourceMappingURL=bloom.d.ts.map