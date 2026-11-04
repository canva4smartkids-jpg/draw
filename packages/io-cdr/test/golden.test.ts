// Golden tests: the TypeScript port must reproduce, byte for byte, what the
// original JavaScript reader produced (captured before the port into
// test/golden/). Any intentional output change must update these files in
// the same commit, with the reason in the commit message.

import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openZip } from '@draw/archive';
import { readCdr, toSvg, parseRiff, formatTree, cdrDocumentToJson } from '@draw/io-cdr';
import { syntheticX5, hasFixture, loadFixture, sha256 } from '@draw/testkit';

interface Hashes {
  synthetic: Record<string, { input: string; svg: string; json: string; tree: string }>;
  real: Record<string, { input: string; svg?: string; json?: string; tree?: string }>;
}

const golden = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');
const hashes = JSON.parse(golden('hashes.json')) as Hashes;

async function outputs(bytes: Uint8Array): Promise<{ svg: string; json: string; tree: string }> {
  const doc = await readCdr(bytes);
  const riffBytes = (await openZip(bytes).read('content/riffData.cdr')) ?? bytes;
  return {
    svg: toSvg(doc),
    json: cdrDocumentToJson(doc) + '\n',
    tree: formatTree(await parseRiff(riffBytes), { hex: 16 }) + '\n',
  };
}

describe('synthetic X5 drawing', () => {
  for (const [name, wrapInZip] of [
    ['synthetic-x5-zip', true],
    ['synthetic-x5-riff', false],
  ] as const) {
    test(`${name}: builder bytes and decoded outputs are unchanged`, async () => {
      const expected = hashes.synthetic[name]!;
      const bytes = syntheticX5({ wrapInZip });
      assert.equal(sha256(bytes), expected.input, 'testkit builder output changed');
      const riffBytes = wrapInZip ? (await openZip(bytes).read('content/riffData.cdr'))! : bytes;
      const doc = await readCdr(bytes);
      assert.equal(toSvg(doc), golden(`${name}.svg`));
      assert.equal(cdrDocumentToJson(doc) + '\n', golden(`${name}.json`));
      assert.equal(formatTree(await parseRiff(riffBytes), { hex: 16 }) + '\n', golden(`${name}.tree.txt`));
    });
  }
});

test.skipIf(!hasFixture('fdo65220-2.cdr'))('real X5 file: SVG, JSON and tree hashes are unchanged', async () => {
  const expected = hashes.real['fdo65220-2.cdr']!;
  const out = await outputs(loadFixture('fdo65220-2.cdr'));
  assert.equal(sha256(out.svg), expected.svg);
  assert.equal(sha256(out.json), expected.json);
  assert.equal(sha256(out.tree), expected.tree);
});
