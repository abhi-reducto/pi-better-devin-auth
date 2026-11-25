import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import {
  ConnectFrameDecoder,
  decodeVarint,
  encodeMessage,
  encodeString,
  encodeVarint,
  encodeVarintField,
  fieldString,
  fieldVarint,
  frameConnectMessage,
  iterFields,
} from '../src/cloud-direct/wire.js';

test('varints round-trip, including 64-bit values', () => {
  for (const n of [0n, 1n, 127n, 128n, 300n, 2n ** 32n, 2n ** 63n]) {
    assert.deepEqual(decodeVarint(encodeVarint(n), 0), [n, encodeVarint(n).length]);
  }
  assert.throws(() => encodeVarint(-1), RangeError);
});

test('iterFields reads fields and stops at a malformed tail', () => {
  const good = Buffer.concat([encodeString(1, 'héllo'), encodeVarintField(2, 42)]);
  const fields = [...iterFields(Buffer.concat([good, Buffer.from([0x1a, 0x7f, 0x01])]))];
  assert.equal(fields.length, 2);
  assert.equal(fieldString(fields[0], 1), 'héllo');
  assert.equal(fieldVarint(fields[1], 2), 42);
  assert.equal(fieldString(fields[1], 2), undefined);
  assert.deepEqual([...iterFields(Buffer.from([0x08, 0xff]))], []);
});

test('frames decode identically however the bytes are chunked', async () => {
  const big = encodeMessage(1, Buffer.alloc(5000, 'x'));
  const { frame: gzipped, compressed } = await frameConnectMessage(big);
  const { frame: plain } = await frameConnectMessage(Buffer.from('small'));
  assert.equal(compressed, true);
  const empty = Buffer.from([0, 0, 0, 0, 0]);
  const end = Buffer.from([2, 0, 0, 0, 2, 0x7b, 0x7d]);
  const wire = Buffer.concat([gzipped, plain, empty, end]);

  for (const chunkSize of [1, 3, 7, wire.length]) {
    const decoder = new ConnectFrameDecoder();
    const frames = [];
    for (let i = 0; i < wire.length; i += chunkSize) {
      frames.push(...decoder.push(wire.subarray(i, i + chunkSize)));
    }
    assert.deepEqual(
      frames.map((f) => [f.payload.toString('latin1'), f.endStream]),
      [
        [big.toString('latin1'), false],
        ['small', false],
        ['', false],
        ['{}', true],
      ],
      `chunk size ${chunkSize}`,
    );
    assert.equal(decoder.pendingBytes, 0);
  }
});

test('a corrupt stream throws instead of buffering without bound', () => {
  const oversized = Buffer.from([0, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => new ConnectFrameDecoder().push(oversized), /exceeds/);

  const notGzip = Buffer.concat([Buffer.from([1, 0, 0, 0, 4]), Buffer.from('nope')]);
  assert.throws(() => new ConnectFrameDecoder().push(notGzip));

  const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024));
  const header = Buffer.alloc(5);
  header[0] = 1;
  header.writeUInt32BE(bomb.length, 1);
  assert.throws(() => new ConnectFrameDecoder().push(Buffer.concat([header, bomb])));
});
