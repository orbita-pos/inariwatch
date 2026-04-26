/**
 * Minimal MessagePack decoder matching the subset emitted by
 * `v8::internal::forensics::MsgpackEncoder` (see
 * `node-forensic-v8/src/forensics/msgpack-encoder.h`).
 *
 * Supported:
 *   nil, false, true,
 *   positive fixint, uint 8/16/32/64,
 *   negative fixint, int 8/16/32/64,
 *   fixstr, str 8/16/32,
 *   fixarr, array 16/32,
 *   fixmap, map 16/32.
 *
 * NOT supported:
 *   float, ext types, bin, timestamp. The encoder never emits these.
 *
 * ~2 KB minified; zero dependencies.
 */
class Reader {
    constructor(buf) {
        this.buf = buf;
        this.offset = 0;
    }
    need(n) {
        if (this.offset + n > this.buf.length) {
            throw new Error(`msgpack: truncated payload (need ${n} at ${this.offset}, have ${this.buf.length})`);
        }
    }
    readByte() {
        this.need(1);
        return this.buf[this.offset++];
    }
    readUint(bytes) {
        this.need(bytes);
        let out = 0;
        for (let i = 0; i < bytes; i++) {
            out = out * 256 + this.buf[this.offset++];
        }
        return out;
    }
    readInt(bytes) {
        const u = this.readUint(bytes);
        // `1 << 31` in JS is -2147483648 (signed 32-bit), and `1 << 32` wraps
        // to 1 because shift counts are masked to 5 bits. Use `2 ** n` so the
        // math stays on the Number side for all widths up to int64.
        const bits = bytes * 8;
        const sign = 2 ** (bits - 1);
        const max = 2 ** bits;
        return u >= sign ? u - max : u;
    }
    readString(n) {
        this.need(n);
        const sub = this.buf.subarray(this.offset, this.offset + n);
        this.offset += n;
        return new TextDecoder("utf-8", { fatal: false }).decode(sub);
    }
}
function readAny(r) {
    const b = r.readByte();
    // positive fixint  0xxxxxxx
    if ((b & 0x80) === 0)
        return b;
    // fixmap 1000xxxx, fixarray 1001xxxx, fixstr 101xxxxx
    if ((b & 0xf0) === 0x80)
        return readMap(r, b & 0x0f);
    if ((b & 0xf0) === 0x90)
        return readArray(r, b & 0x0f);
    if ((b & 0xe0) === 0xa0)
        return r.readString(b & 0x1f);
    // negative fixint 111xxxxx
    if ((b & 0xe0) === 0xe0)
        return b - 0x100;
    switch (b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xcc: return r.readUint(1);
        case 0xcd: return r.readUint(2);
        case 0xce: return r.readUint(4);
        case 0xcf: return r.readUint(8);
        case 0xd0: return r.readInt(1);
        case 0xd1: return r.readInt(2);
        case 0xd2: return r.readInt(4);
        case 0xd3: return r.readInt(8);
        case 0xd9: return r.readString(r.readUint(1));
        case 0xda: return r.readString(r.readUint(2));
        case 0xdb: return r.readString(r.readUint(4));
        case 0xdc: return readArray(r, r.readUint(2));
        case 0xdd: return readArray(r, r.readUint(4));
        case 0xde: return readMap(r, r.readUint(2));
        case 0xdf: return readMap(r, r.readUint(4));
        default:
            throw new Error(`msgpack: unsupported type byte 0x${b.toString(16)}`);
    }
}
function readArray(r, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++)
        out[i] = readAny(r);
    return out;
}
function readMap(r, n) {
    const out = {};
    for (let i = 0; i < n; i++) {
        const key = readAny(r);
        if (typeof key !== "string") {
            throw new Error(`msgpack: non-string map key at ${r.offset}`);
        }
        out[key] = readAny(r);
    }
    return out;
}
/** Decode a raw MessagePack payload into untyped JS. */
export function decode(buf) {
    const r = new Reader(buf);
    return readAny(r);
}
/** Decode a value snapshot. */
function toForensicValue(raw) {
    const out = {
        name: String(raw.name ?? ""),
        repr: String(raw.repr ?? ""),
        kind: String(raw.kind ?? "unknown"),
    };
    if (raw.truncated === true)
        out.truncated = true;
    return out;
}
/** Decode one frame snapshot from the C++ encoder shape. */
function toFrameSnapshot(raw) {
    const snap = {
        index: Number(raw.index ?? 0),
        functionName: String(raw.functionName ?? "<anonymous>"),
        locals: Array.isArray(raw.locals)
            ? raw.locals.map((v) => toForensicValue(v))
            : [],
        closure: Array.isArray(raw.closure)
            ? raw.closure.map((v) => toForensicValue(v))
            : [],
    };
    if (typeof raw.sourceUrl === "string" && raw.sourceUrl.length > 0) {
        snap.sourceUrl = raw.sourceUrl;
    }
    if (typeof raw.line === "number" && raw.line > 0)
        snap.line = raw.line;
    if (typeof raw.col === "number" && raw.col > 0)
        snap.column = raw.col;
    if (raw.partial === true)
        snap.partial = true;
    if (raw.receiver && typeof raw.receiver === "object") {
        snap.receiver = toForensicValue(raw.receiver);
    }
    return snap;
}
/**
 * Decode the payload the fork emits. Layout (see forensics.cc):
 *   map { "v": uint, "frames": [FrameSnapshot, ...] }
 */
export function decodeForensicPayload(buf) {
    const raw = decode(buf);
    if (!raw || typeof raw !== "object") {
        throw new Error("msgpack: forensic payload must be a map");
    }
    const version = Number(raw.v ?? 0);
    const rawFrames = Array.isArray(raw.frames) ? raw.frames : [];
    const frames = rawFrames.map((f) => toFrameSnapshot(f));
    return { version, frames };
}
//# sourceMappingURL=msgpack-decoder.js.map