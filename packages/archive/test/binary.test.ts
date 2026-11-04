import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Reader, FormatError, fourccAt, toHex, inflate } from '@draw/archive';
import { deflateSync } from 'node:zlib';

test('Reader reads little-endian values and refuses to read past its window', () => {
  const bytes = Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f);
  const r = new Reader(bytes);
  assert.equal(r.u16(), 0x0201);
  assert.equal(r.u16(), 0x0403);
  assert.equal(r.s16(), -1);
  assert.equal(r.f64(), 1);
  assert.equal(r.remaining, 0);
  assert.throws(() => r.u8(), FormatError);
  assert.throws(() => new Reader(bytes, 2, 4).seek(3), FormatError);
});

test('fourccAt and toHex', () => {
  const bytes = new TextEncoder().encode('RIFFxyz');
  assert.equal(fourccAt(bytes, 0), 'RIFF');
  assert.equal(fourccAt(bytes, 5), '');
  assert.equal(toHex(Uint8Array.of(0, 1, 254, 255)), '0001feff');
  assert.equal(toHex(new Uint8Array(40), 2), '0000…');
});

test('inflate decodes zlib streams and enforces the output cap', async () => {
  const data = new Uint8Array(10000).fill(42);
  const z = deflateSync(data);
  const out = await inflate(z, 'deflate');
  assert.equal(out.length, 10000);
  assert.equal(out[9999], 42);
  await assert.rejects(inflate(z, 'deflate', 100), /exceeds 100 bytes/);
  await assert.rejects(inflate(Uint8Array.of(1, 2, 3, 4), 'deflate'), FormatError);
});
