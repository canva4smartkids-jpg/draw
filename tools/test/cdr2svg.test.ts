// End-to-end tests of the cdr2svg developer CLI against the golden outputs
// captured from the original JavaScript implementation.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticX5, hasFixture, fixturePath, sha256 } from '@draw/testkit';

const CLI = fileURLToPath(new URL('../cdr2svg.ts', import.meta.url));
const GOLDEN = fileURLToPath(new URL('../../packages/io-cdr/test/golden/', import.meta.url));
const hashes = JSON.parse(readFileSync(join(GOLDEN, 'hashes.json'), 'utf8')) as {
  real: Record<
    string,
    { svg?: string; json?: string; tree?: string; info?: string; exitCode?: number; stderr?: string }
  >;
};
const run = (...args: string[]): string => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('converts, dumps and summarises a synthetic drawing exactly as before the port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdr2svg-'));
  try {
    const input = join(dir, 'drawing.cdr');
    writeFileSync(input, syntheticX5());
    assert.equal(run(input, '-o', '-'), readFileSync(join(GOLDEN, 'synthetic-x5-zip.svg'), 'utf8'));
    assert.equal(run(input, '--json'), readFileSync(join(GOLDEN, 'synthetic-x5-zip.json'), 'utf8'));
    assert.equal(run(input, '--tree'), readFileSync(join(GOLDEN, 'synthetic-x5-zip.tree.txt'), 'utf8'));
    assert.match(
      run(input, '--info'),
      /CorelDRAW X5 \(version 1500, zip-riffData\)\npage size: 200\.00 x 100\.00 mm\npage 1: Layer 1 \(3 objects\)/,
    );
    // default output path: next to the input
    spawnSync(process.execPath, [CLI, input]);
    assert.equal(
      readFileSync(join(dir, 'drawing.svg'), 'utf8'),
      readFileSync(join(GOLDEN, 'synthetic-x5-zip.svg'), 'utf8'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!hasFixture('fdo65220-2.cdr'))('real X5 file: every output matches its pre-port hash', () => {
  const f = fixturePath('fdo65220-2.cdr');
  const expected = hashes.real['fdo65220-2.cdr']!;
  assert.equal(sha256(run(f, '-o', '-')), expected.svg);
  assert.equal(sha256(run(f, '--json')), expected.json);
  assert.equal(sha256(run(f, '--tree')), expected.tree);
  assert.equal(sha256(run(f, '--info').replaceAll(f, '<input>')), expected.info);
});

for (const name of ['EDB-35217-2.cdr', 'fdo63782-1.cmx']) {
  test.skipIf(!hasFixture(name))(`${name}: same exit code and error message as before the port`, () => {
    const r = spawnSync(process.execPath, [CLI, fixturePath(name), '--info'], { encoding: 'utf8' });
    assert.equal(r.status, hashes.real[name]!.exitCode);
    assert.equal(r.stderr.trim(), hashes.real[name]!.stderr);
  });
}
