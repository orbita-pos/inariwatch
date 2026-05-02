/**
 * Luhn checksum — used to filter out 13-19 digit sequences that look like
 * credit cards but aren't (timestamps, IDs, phone-number runs in logs, etc.).
 *
 * Operates on the digit-only string. Caller strips spaces/dashes first.
 */
export declare function isLuhnValid(digits: string): boolean;
//# sourceMappingURL=luhn.d.ts.map