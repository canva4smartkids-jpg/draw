import { test } from 'vitest';
import assert from 'node:assert/strict';
import { openZip, FormatError } from '@draw/archive';
import { zip } from '@draw/testkit';

test('reads stored and deflated ZIP entries', async () => {
  const text = new TextEncoder().encode('hello hello hello hello');
  const archive = zip([
    ['a/stored.txt', text, false],
    ['b/deflated.txt', text, true],
  ]);
  const z = openZip(archive);
  assert.deepEqual([...z.entries.keys()], ['a/stored.txt', 'b/deflated.txt']);
  assert.equal(new TextDecoder().decode((await z.read('a/stored.txt'))!), 'hello hello hello hello');
  assert.equal(new TextDecoder().decode((await z.read('b/deflated.txt'))!), 'hello hello hello hello');
  assert.equal(await z.read('missing'), null);
});

test('rejects a ZIP without an end-of-central-directory record', () => {
  assert.throws(() => openZip(Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0, 0, 0)), FormatError);
});
