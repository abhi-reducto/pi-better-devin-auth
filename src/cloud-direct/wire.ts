/**
 * Minimal, dependency-free protobuf + Connect-RPC streaming wire helpers.
 *
 * Connect-RPC streaming frame layout:
 *   [flags: 1B][length: 4B BE][payload: length B]
 *     flags & 0x01 => payload is gzip-compressed
 *     flags & 0x02 => end-of-stream trailer (JSON {} or {"error":{code,message}})
 */

import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const FRAME_HEADER_BYTES = 5;
const FLAG_COMPRESSED = 0x01;
const FLAG_END_STREAM = 0x02;

/** Upper bound for one inflated frame (decompression-bomb guard). */
const MAX_GUNZIP_BYTES = 32 * 1024 * 1024;
/** Upper bound for one frame on the wire; a larger length prefix means a corrupt stream. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Only gzip request payloads above 2 KiB; smaller bodies aren't worth the CPU. */
const GZIP_THRESHOLD_BYTES = 2048;

// ---------------------------------------------------------------------------
// Protobuf encoding
// ---------------------------------------------------------------------------

export function encodeVarint(value: number | bigint): Buffer {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError(`encodeVarint: negative input not supported (got ${value})`);
  const bytes: number[] = [];
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeTag(fieldNum: number, wire: number): Buffer {
  return encodeVarint((fieldNum << 3) | wire);
}

/** Length-delimited field: a nested message or raw bytes. */
export function encodeMessage(fieldNum: number, body: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNum, WIRE_BYTES), encodeVarint(body.length), body]);
}

export function encodeString(fieldNum: number, s: string): Buffer {
  return encodeMessage(fieldNum, Buffer.from(s, 'utf8'));
}

export function encodeVarintField(fieldNum: number, v: number | bigint): Buffer {
  return Buffer.concat([encodeTag(fieldNum, WIRE_VARINT), encodeVarint(v)]);
}

export function encodeDoubleField(fieldNum: number, v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v, 0);
  return Buffer.concat([encodeTag(fieldNum, WIRE_FIXED64), b]);
}

/** Body of a `google.protobuf.Timestamp` for the current time. */
export function encodeTimestampBody(): Buffer {
  const now = Date.now();
  const nanos = (now % 1000) * 1_000_000;
  return Buffer.concat([
    encodeVarintField(1, Math.floor(now / 1000)),
    nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0),
  ]);
}

// ---------------------------------------------------------------------------
// Protobuf decoding
// ---------------------------------------------------------------------------

export function decodeVarint(buf: Buffer, offset: number): [bigint, number] {
  let res = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    if (shift > 63n) throw new RangeError('varint overflow (>64 bits)');
    const b = buf[i++];
    res |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [res, i];
    shift += 7n;
  }
  throw new Error('truncated varint');
}

export type ProtoField =
  { num: number; wire: 0; value: bigint } | { num: number; wire: 1 | 2 | 5; value: Buffer };

/**
 * Walk the top-level fields of a message. Stops quietly at the first
 * malformed or unknown-wire-type field, so a partially understood message
 * still yields everything before the damage.
 */
export function* iterFields(buf: Buffer): Generator<ProtoField> {
  let i = 0;
  try {
    while (i < buf.length) {
      const [tagBig, afterTag] = decodeVarint(buf, i);
      i = afterTag;
      const tag = Number(tagBig);
      const num = tag >>> 3;
      const wire = tag & 0x07;
      if (num <= 0) return;

      if (wire === WIRE_VARINT) {
        const [value, afterVal] = decodeVarint(buf, i);
        i = afterVal;
        yield { num, wire, value };
        continue;
      }

      let len: number;
      if (wire === WIRE_FIXED64) len = 8;
      else if (wire === WIRE_FIXED32) len = 4;
      else if (wire === WIRE_BYTES) {
        const [lenBig, afterLen] = decodeVarint(buf, i);
        i = afterLen;
        len = Number(lenBig);
      } else return; // deprecated group markers (3/4) or unknown wire type

      if (!Number.isSafeInteger(len) || i + len > buf.length) return;
      yield { num, wire, value: buf.subarray(i, i + len) };
      i += len;
    }
  } catch {
    // truncated / overflowing varint — treat like any other malformed tail
  }
}

/** UTF-8 value of a length-delimited field, or undefined for any other field. */
export function fieldString(f: ProtoField, num: number): string | undefined {
  return f.num === num && f.wire === WIRE_BYTES ? f.value.toString('utf8') : undefined;
}

/** Sub-message bytes of a length-delimited field, or undefined for any other field. */
export function fieldBytes(f: ProtoField, num: number): Buffer | undefined {
  return f.num === num && f.wire === WIRE_BYTES ? f.value : undefined;
}

/** Value of a varint field as a JS number, or undefined for any other field. */
export function fieldVarint(f: ProtoField, num: number): number | undefined {
  return f.num === num && f.wire === WIRE_VARINT ? Number(f.value) : undefined;
}

/** Value of a fixed32 field read as an IEEE-754 float, or undefined for any other field. */
export function fieldFloat(f: ProtoField, num: number): number | undefined {
  return f.num === num && f.wire === WIRE_FIXED32 ? f.value.readFloatLE(0) : undefined;
}

// ---------------------------------------------------------------------------
// Connect streaming envelope
// ---------------------------------------------------------------------------

/** Wrap one message in a Connect streaming envelope, gzipping it when worthwhile. */
export async function frameConnectMessage(body: Buffer): Promise<{ frame: Buffer; compressed: boolean }> {
  const compressed = body.length >= GZIP_THRESHOLD_BYTES;
  const payload = compressed ? await gzip(body) : body;
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header[0] = compressed ? FLAG_COMPRESSED : 0;
  header.writeUInt32BE(payload.length, 1);
  return { frame: Buffer.concat([header, payload]), compressed };
}

export interface ConnectFrame {
  payload: Buffer;
  /** True for the end-of-stream trailer frame. */
  endStream: boolean;
}

/**
 * Incremental Connect frame decoder. Feed it network chunks as they arrive;
 * it returns every frame completed so far and buffers the remainder. Chunks
 * are queued, not concatenated, so long streams stay linear in total bytes.
 */
export class ConnectFrameDecoder {
  #chunks: Buffer[] = [];
  #buffered = 0;

  /** Bytes received that do not yet form a complete frame. */
  get pendingBytes(): number {
    return this.#buffered;
  }

  /** Throws on a corrupt stream: an oversized frame or a payload that fails to inflate. */
  push(chunk: Uint8Array): ConnectFrame[] {
    const frames: ConnectFrame[] = [];
    if (chunk.length === 0) return frames;
    this.#chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.#buffered += chunk.length;

    while (this.#buffered >= FRAME_HEADER_BYTES) {
      const header = this.#peek(FRAME_HEADER_BYTES);
      const flags = header[0];
      const len = header.readUInt32BE(1);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`Connect frame of ${len} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`);
      }
      if (this.#buffered < FRAME_HEADER_BYTES + len) break; // frame still arriving

      this.#drop(FRAME_HEADER_BYTES);
      const raw = this.#peek(len);
      this.#drop(len);
      frames.push({
        payload: flags & FLAG_COMPRESSED ? zlib.gunzipSync(raw, { maxOutputLength: MAX_GUNZIP_BYTES }) : raw,
        endStream: (flags & FLAG_END_STREAM) !== 0,
      });
    }
    return frames;
  }

  /** The first `n` buffered bytes, without consuming them. Requires `n <= pendingBytes`. */
  #peek(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const head = this.#chunks[0];
    if (head.length >= n) return head.subarray(0, n);
    const parts: Buffer[] = [];
    let remaining = n;
    for (const c of this.#chunks) {
      if (remaining <= 0) break;
      parts.push(c.length <= remaining ? c : c.subarray(0, remaining));
      remaining -= c.length;
    }
    return Buffer.concat(parts, n);
  }

  #drop(n: number): void {
    this.#buffered -= n;
    let remaining = n;
    while (remaining > 0) {
      const head = this.#chunks[0];
      if (head.length <= remaining) {
        this.#chunks.shift();
        remaining -= head.length;
      } else {
        this.#chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
  }
}
