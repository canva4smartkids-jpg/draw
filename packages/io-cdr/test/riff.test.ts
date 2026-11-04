import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FormatError } from '@draw/archive';
import { parseRiff, walk } from '@draw/io-cdr';
import { Bytes, chunk, list, cmpr, riff } from '@draw/testkit';

test('parses a plain RIFF tree and skips pad bytes', async () => {
  const bytes = riff('CDR9', [
    chunk('vrsn', new Bytes().u16(900)),
    list('doc ', [chunk('odd1', Uint8Array.of(1, 2, 3)), chunk('next', Uint8Array.of(4))]),
  ]);
  const root = await parseRiff(bytes);
  assert.equal(root.type, 'CDR9');
  const ids = [...walk(root)].map(({ chunk: c }) => c.type ?? c.id);
  assert.deepEqual(ids, ['CDR9', 'vrsn', 'doc ', 'odd1', 'next']);
  const odd = [...walk(root)].find(({ chunk: c }) => c.id === 'odd1')!.chunk;
  assert.deepEqual([...odd.data], [1, 2, 3]);
});

test('cmpr lists: inflates payload and resolves size indices through the block table', async () => {
  const bytes = riff('CDRF', [
    cmpr([list('doc ', [chunk('aaaa', Uint8Array.of(9, 9, 9)), chunk('bbbb', new Uint8Array(300).fill(7))])]),
  ]);
  const root = await parseRiff(bytes);
  const found = [...walk(root)].map(({ chunk: c }) => c);
  const a = found.find((c) => c.id === 'aaaa')!;
  const b = found.find((c) => c.id === 'bbbb')!;
  assert.ok(a.compressed && b.compressed);
  assert.equal(a.size, 3);
  assert.equal(b.size, 300);
  assert.equal(b.data[299], 7);
});

test('rejects a chunk that overruns its parent', async () => {
  const bad = new Bytes().ascii('RIFF').u32(20).ascii('CDRF').ascii('loda').u32(1000).zeros(8).bytes();
  await assert.rejects(parseRiff(bad), FormatError);
});

test('rejects non-RIFF input', async () => {
  await assert.rejects(parseRiff(new Uint8Array(64).fill(0xab)), FormatError);
});
