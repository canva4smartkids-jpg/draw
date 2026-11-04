// Regression tests against real CorelDRAW output. Run `npm run fixtures`
// first; without the files these tests are skipped, not failed.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FormatError } from '@draw/archive';
import { readCdr, toSvg } from '@draw/io-cdr';
import type { CdrObject } from '@draw/io-cdr';
import { hasFixture, loadFixture } from '@draw/testkit';

const X5 = 'fdo65220-2.cdr';
const FUZZED = 'EDB-35217-2.cdr';
const CMX = 'fdo63782-1.cmx';

test.skipIf(!hasFixture(X5))('CorelDRAW X5 file fdo65220-2.cdr: five rectangles under an invert lens', async () => {
  const doc = await readCdr(loadFixture(X5));
  assert.equal(doc.format.version, 1500);
  assert.equal(doc.format.container, 'zip-riffData');
  assert.deepEqual(doc.warnings, []);
  assert.equal(doc.metadata?.ProductName, 'CorelDRAW X5');
  assert.equal(doc.metadata.BuildNumber, '686');
  assert.deepEqual([doc.pageSize.width, doc.pageSize.height], [210, 297]);

  // metadata.xml says: 1 page, 1 layer, 5 rectangles, 5 uniform fills
  const pages = doc.pages.filter((p) => !p.master);
  assert.equal(pages.length, 1);
  const layers = pages[0]!.layers.filter((l) => l.objects.length);
  assert.equal(layers.length, 1);
  assert.equal(layers[0]!.name, 'Ebene 1');
  const objs = layers[0]!.objects as readonly CdrObject[];
  assert.deepEqual(
    objs.map((o) => o.kind),
    Array<string>(5).fill('rectangle'),
  );
  assert.ok(objs.every((o) => o.fill?.type === 'solid'));

  // top-most object is the lens; the rest use the document palette colours
  assert.equal(objs[0]!.lens?.type, 'invert');
  assert.deepEqual(
    objs.slice(1).map((o) => (o.fill?.type === 'solid' ? o.fill.color.rgb : null)),
    [
      [0, 102, 51], // Waldgrün
      [102, 153, 255], // Babyblau
      [255, 0, 0], // Rot
      [0, 0, 255], // Blau
    ],
  );

  // no object carries its own outline; all inherit 0.2 mm black from style CorelDefaultID_5008
  for (const o of objs) {
    assert.equal(o.outlineSource, 'style');
    assert.equal(o.outline?.id, '0x0aeb39e8');
    assert.equal(o.outline.width, 0.2);
    assert.deepEqual(o.outline.color.rgb, [0, 0, 0]);
  }
  assert.equal(doc.styles['0x0b11efc8']?.name, 'CorelDefaultID_5008');

  // the lens rectangle is 139.07 x 162.25 mm before a horizontal scale of ~0.838
  const lens = objs[0]!;
  assert.ok(lens.geometry && 'type' in lens.geometry && lens.geometry.type === 'rectangle');
  assert.ok(Math.abs(lens.geometry.width - 139.0714) < 1e-3);
  assert.ok(Math.abs(lens.transform[0] - 0.838) < 1e-3);

  const svg = toSvg(doc);
  assert.match(svg, /mix-blend-mode:difference/);
  assert.equal((svg.match(/data-kind="rectangle"/g) ?? []).length, 5);
});

test.skipIf(!hasFixture(FUZZED))('EDB-35217-2.cdr (fuzzed, high-entropy) is rejected cleanly', async () => {
  await assert.rejects(readCdr(loadFixture(FUZZED)), FormatError);
});

test.skipIf(!hasFixture(CMX))('fdo63782-1.cmx is identified as CMX and refused', async () => {
  await assert.rejects(readCdr(loadFixture(CMX)), /CMX/);
});
