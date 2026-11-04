import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRiff, walk, openZip, FormatError } from '../src/index.js';
import { Bytes, chunk, list, cmpr, riff, zip } from './helpers/build.js';

test('parses a plain RIFF tree and skips pad bytes', async () => {
  const bytes = riff('CDR9', [chunk('vrsn', new Bytes().u16(900)), list('doc ', [chunk('odd1', Uint8Array.of(1, 2, 3)), chunk('next', Uint8Array.of(4))])]);
  const root = await parseRiff(bytes);
  assert.equal(root.type, 'CDR9');
  const ids = [...walk(root)].map(({ chunk: c }) => c.type ?? c.id);
  assert.deepEqual(ids, ['CDR9', 'vrsn', 'doc ', 'odd1', 'next']);
  const odd = [...walk(root)].find(({ chunk: c }) => c.id === 'odd1').chunk;
  assert.deepEqual([...odd.data], [1, 2, 3]);
});

test('cmpr lists: inflates payload and resolves size indices through the block table', async () => {
  const bytes = riff('CDRF', [cmpr([list('doc ', [chunk('aaaa', Uint8Array.of(9, 9, 9)), chunk('bbbb', new Uint8Array(300).fill(7))])])]);
  const root = await parseRiff(bytes);
  const found = [...walk(root)].map(({ chunk: c }) => c);
  const a = found.find((c) => c.id === 'aaaa');
  const b = found.find((c) => c.id === 'bbbb');
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

test('reads stored and deflated ZIP entries', async () => {
  const text = new TextEncoder().encode('hello hello hello hello');
  const archive = zip([['a/stored.txt', text, false], ['b/deflated.txt', text, true]]);
  const z = openZip(archive);
  assert.deepEqual([...z.entries.keys()], ['a/stored.txt', 'b/deflated.txt']);
  assert.equal(new TextDecoder().decode(await z.read('a/stored.txt')), 'hello hello hello hello');
  assert.equal(new TextDecoder().decode(await z.read('b/deflated.txt')), 'hello hello hello hello');
  assert.equal(await z.read('missing'), null);
});

test('rejects a ZIP without an end-of-central-directory record', () => {
  assert.throws(() => openZip(Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0, 0, 0)), FormatError);
});
