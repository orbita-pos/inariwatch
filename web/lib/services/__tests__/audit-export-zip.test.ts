/**
 * Smoke tests for the hand-rolled STORE-only ZIP writer used by the
 * compliance audit export. We don't want to ship a buggy archiver, so we
 * verify the byte-level structure (magic numbers, CRC, EOCD layout) and
 * round-trip with Node's built-in `zlib.inflateRawSync`-free inflate
 * isn't needed (STORE = no compression) — instead we walk the central
 * directory and re-extract each entry by offset.
 */

import { describe, it, expect } from "vitest";
import { buildStoreZip, crc32 } from "@/lib/services/audit-export-zip";

const TEXT = new TextEncoder();

function decodeUtf8(buf: Uint8Array, start: number, end: number): string {
  return new TextDecoder("utf-8").decode(buf.subarray(start, end));
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, true);
}

function readUint16LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset + offset, 2).getUint16(0, true);
}

function findEocd(zip: Uint8Array): number {
  // EOCD is 22 bytes (no comment) — last 22 bytes.
  for (let i = zip.byteLength - 22; i >= 0; i--) {
    if (readUint32LE(zip, i) === 0x06054b50) return i;
  }
  throw new Error("EOCD not found");
}

interface ParsedEntry {
  path: string;
  data: Uint8Array;
  crc: number;
}

function parseZip(zip: Uint8Array): ParsedEntry[] {
  const eocdOffset = findEocd(zip);
  const totalEntries = readUint16LE(zip, eocdOffset + 10);
  const centralOffset = readUint32LE(zip, eocdOffset + 16);

  const out: ParsedEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    expect(readUint32LE(zip, cursor)).toBe(0x02014b50);
    const compMethod = readUint16LE(zip, cursor + 10);
    const crc = readUint32LE(zip, cursor + 16);
    const compSize = readUint32LE(zip, cursor + 20);
    const uncompSize = readUint32LE(zip, cursor + 24);
    const nameLen = readUint16LE(zip, cursor + 28);
    const extraLen = readUint16LE(zip, cursor + 30);
    const commentLen = readUint16LE(zip, cursor + 32);
    const localHeaderOff = readUint32LE(zip, cursor + 42);
    const path = decodeUtf8(zip, cursor + 46, cursor + 46 + nameLen);

    expect(compMethod).toBe(0); // STORE
    expect(compSize).toBe(uncompSize);

    // Walk to the local header, skip past it, read the payload.
    expect(readUint32LE(zip, localHeaderOff)).toBe(0x04034b50);
    const localNameLen = readUint16LE(zip, localHeaderOff + 26);
    const localExtraLen = readUint16LE(zip, localHeaderOff + 28);
    const dataStart = localHeaderOff + 30 + localNameLen + localExtraLen;
    const data = zip.slice(dataStart, dataStart + uncompSize);

    out.push({ path, data, crc });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("buildStoreZip", () => {
  it("emits a valid PKZIP archive with PK\\x03\\x04 magic", () => {
    const zip = buildStoreZip(
      [{ path: "hello.txt", data: TEXT.encode("world") }],
      new Date("2026-04-25T12:00:00Z"),
    );
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it("round-trips one file: path, payload, and CRC", () => {
    const payload = TEXT.encode("the quick brown fox jumps over the lazy dog");
    const zip = buildStoreZip(
      [{ path: "fox.txt", data: payload }],
      new Date("2026-04-25T12:00:00Z"),
    );

    const parsed = parseZip(zip);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.path).toBe("fox.txt");
    expect(Buffer.from(parsed[0]!.data).equals(Buffer.from(payload))).toBe(true);
    expect(parsed[0]!.crc).toBe(crc32(payload));
  });

  it("preserves order and contents of multiple entries", () => {
    const files = [
      { path: "manifest.json", data: TEXT.encode('{"v":1}') },
      { path: "summary.pdf", data: TEXT.encode("%PDF-1.4\n") },
      { path: "receipts/aaaa.json", data: TEXT.encode('{"id":"aaaa"}') },
      { path: "receipts/bbbb.json", data: TEXT.encode('{"id":"bbbb"}') },
    ];
    const zip = buildStoreZip(files, new Date("2026-04-25T12:00:00Z"));

    const parsed = parseZip(zip);
    expect(parsed.map((p) => p.path)).toEqual([
      "manifest.json",
      "summary.pdf",
      "receipts/aaaa.json",
      "receipts/bbbb.json",
    ]);
    for (let i = 0; i < files.length; i++) {
      expect(Buffer.from(parsed[i]!.data).equals(Buffer.from(files[i]!.data))).toBe(true);
      expect(parsed[i]!.crc).toBe(crc32(files[i]!.data));
    }
  });

  it("handles an empty file list cleanly", () => {
    const zip = buildStoreZip([], new Date("2026-04-25T12:00:00Z"));
    // No local headers; just an EOCD with 0 entries.
    expect(zip.byteLength).toBe(22);
    expect(readUint32LE(zip, 0)).toBe(0x06054b50);
    expect(readUint16LE(zip, 10)).toBe(0); // total entries
  });

  it("matches the canonical CRC-32 reference vector", () => {
    // Standard IEEE 802.3 CRC-32 reference: "123456789" → 0xCBF43926.
    // Used as the check value in every implementation (Python zlib,
    // Boost, RFC 1952). If this passes, our table + accumulator are
    // correct.
    expect(crc32(TEXT.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
