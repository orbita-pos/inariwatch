/**
 * Minimal ZIP writer (STORE method, no compression).
 *
 * Used by the compliance audit export — bundles a small set of JSON +
 * PDF entries into a single archive without pulling in a 50 KB+ deps
 * tree. Files are stored uncompressed (compression method 0) so an
 * auditor can verify byte-level integrity without unzip wrapper magic.
 *
 * Supports the subset we need: small ASCII paths, no comments, no Zip64
 * (we cap total bytes well under 4 GB at the API boundary), no
 * encryption, no multi-disk. CRC-32 is computed from scratch — no
 * `node:zlib` dependency, deterministic output.
 *
 * Reference: APPNOTE.TXT 6.3.10 §4.3 + §4.4 (PKZIP local file header,
 * data descriptor disabled, central directory). General-purpose flag
 * bit 11 set so UTF-8 filenames are honoured.
 */

const SIGN_LOCAL_FILE = 0x04034b50;
const SIGN_CENTRAL_DIR = 0x02014b50;
const SIGN_END_OF_CENTRAL_DIR = 0x06054b50;

const VERSION_NEEDED = 20;       // 2.0 — STORE + standard header
const VERSION_MADE_BY = 0x0314;  // UNIX (0x03) << 8 | 2.0
const COMPRESSION_STORE = 0;
/** UTF-8 filename flag (bit 11). */
const GP_BIT_UTF8 = 0x0800;

interface ZipFileEntry {
  path: string;
  data: Uint8Array;
}

interface CentralEntry {
  path: string;
  crc32: number;
  size: number;
  /** Offset of the local file header inside the archive. */
  localHeaderOffset: number;
  /** DOS-format mtime/mdate from `now`. */
  dosTime: number;
  dosDate: number;
}

/**
 * Build the ZIP body. `now` is used for every entry's mtime — keeping a
 * single timestamp makes the output deterministic for a given input
 * (handy for tests + auditor diffs).
 */
export function buildStoreZip(
  files: ReadonlyArray<ZipFileEntry>,
  now: Date,
): Uint8Array {
  const { dosTime, dosDate } = toDos(now);
  const encoder = new TextEncoder();

  // Phase 1: lay out local headers + payloads back-to-back.
  const localChunks: Uint8Array[] = [];
  const central: CentralEntry[] = [];
  let cursor = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.path);
    const crc = crc32(f.data);
    const size = f.data.byteLength;

    const header = new Uint8Array(30 + nameBytes.byteLength);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, SIGN_LOCAL_FILE, true);
    dv.setUint16(4, VERSION_NEEDED, true);
    dv.setUint16(6, GP_BIT_UTF8, true);
    dv.setUint16(8, COMPRESSION_STORE, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.byteLength, true);
    dv.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    central.push({
      path: f.path,
      crc32: crc,
      size,
      localHeaderOffset: cursor,
      dosTime,
      dosDate,
    });

    localChunks.push(header, f.data);
    cursor += header.byteLength + size;
  }

  // Phase 2: central directory.
  const centralStart = cursor;
  const centralChunks: Uint8Array[] = [];
  for (const c of central) {
    const nameBytes = encoder.encode(c.path);
    const entry = new Uint8Array(46 + nameBytes.byteLength);
    const dv = new DataView(entry.buffer);
    dv.setUint32(0, SIGN_CENTRAL_DIR, true);
    dv.setUint16(4, VERSION_MADE_BY, true);
    dv.setUint16(6, VERSION_NEEDED, true);
    dv.setUint16(8, GP_BIT_UTF8, true);
    dv.setUint16(10, COMPRESSION_STORE, true);
    dv.setUint16(12, c.dosTime, true);
    dv.setUint16(14, c.dosDate, true);
    dv.setUint32(16, c.crc32, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, nameBytes.byteLength, true);
    dv.setUint16(30, 0, true); // extra field length
    dv.setUint16(32, 0, true); // file comment length
    dv.setUint16(34, 0, true); // disk number start
    dv.setUint16(36, 0, true); // internal file attrs
    dv.setUint32(38, 0o100644 << 16, true); // external file attrs (regular -rw-r--r--)
    dv.setUint32(42, c.localHeaderOffset, true);
    entry.set(nameBytes, 46);
    centralChunks.push(entry);
    cursor += entry.byteLength;
  }
  const centralSize = cursor - centralStart;

  // Phase 3: end-of-central-directory record.
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, SIGN_END_OF_CENTRAL_DIR, true);
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central dir
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);
  edv.setUint16(20, 0, true); // comment length

  // Concatenate.
  const total = cursor + eocd.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of localChunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  out.set(eocd, off);
  return out;
}

// ── CRC-32 (IEEE 802.3 polynomial, the one ZIP uses) ──────────────────────

let CRC_TABLE: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.byteLength; i++) {
    c = (table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── DOS date/time encoding (ZIP uses these in local + central headers) ────

function toDos(d: Date): { dosTime: number; dosDate: number } {
  const yr = d.getUTCFullYear();
  // DOS epoch is 1980; clamp anything earlier so we never emit a negative year.
  const year = yr < 1980 ? 0 : yr - 1980;
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const min = d.getUTCMinutes();
  // DOS time is 2-second resolution.
  const sec = Math.floor(d.getUTCSeconds() / 2);

  const dosDate = ((year & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  const dosTime = ((hour & 0x1f) << 11) | ((min & 0x3f) << 5) | (sec & 0x1f);
  return { dosTime, dosDate };
}
