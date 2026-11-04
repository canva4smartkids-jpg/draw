// Regression tests against real CorelDRAW output. Run `npm run fixtures`
// first; without the files these tests are skipped, not failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readCdr, toSvg, FormatError } from '../src/index.js';

const dir = fileURLToPath(new URL('./fixtures/external/', import.meta.url));
const load = (name) => new Uint8Array(readFileSync(dir + name));
const has = (name) => existsSync(dir + name);
const skip = (name) => (has(name) ? false : `run "npm run fixtures" to fetch ${name}`);

test('CorelDRAW X5 file fdo65220-2.cdr: five rectangles under an invert lens', { skip: skip('fdo65220-2.cdr') }, async () => {
  const doc = await readCdr(load('fdo65220-2.cdr'));
  assert.equal(doc.format.version, 1500);
  assert.equal(doc.format.container, 'zip-riffData');
  assert.deepEqual(doc.warnings, []);
  assert.equal(doc.metadata.ProductName, 'CorelDRAW X5');
  assert.equal(doc.metadata.BuildNumber, '686');
  assert.deepEqual([doc.pageSize.width, doc.pageSize.height], [210, 297]);

  // metadata.xml says: 1 page, 1 layer, 5 rectangles, 5 uniform fills
  const pages = doc.pages.filter((p) => !p.master);
  assert.equal(pages.length, 1);
  const layers = pages[0].layers.filter((l) => l.objects.length);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].name, 'Ebene 1');
  const objs = layers[0].objects;
  assert.deepEqual(objs.map((o) => o.kind), Array(5).fill('rectangle'));
  assert.ok(objs.every((o) => o.fill.type === 'solid'));

  // top-most object is the lens; the rest use the document palette colours
  assert.equal(objs[0].lens.type, 'invert');
  assert.deepEqual(objs.slice(1).map((o) => o.fill.color.rgb), [
    [0, 102, 51], // Waldgrün
    [102, 153, 255], // Babyblau
    [255, 0, 0], // Rot
    [0, 0, 255], // Blau
  ]);

  // no object carries its own outline; all inherit 0.2 mm black from style CorelDefaultID_5008
  for (const o of objs) {
    assert.equal(o.outlineSource, 'style');
    assert.equal(o.outline.id, '0x0aeb39e8');
    assert.equal(o.outline.width, 0.2);
    assert.deepEqual(o.outline.color.rgb, [0, 0, 0]);
  }
  assert.equal(doc.styles['0x0b11efc8'].name, 'CorelDefaultID_5008');

  // the lens rectangle is 139.07 x 162.25 mm before a horizontal scale of ~0.838
  assert.ok(Math.abs(objs[0].geometry.width - 139.0714) < 1e-3);
  assert.ok(Math.abs(objs[0].transform[0] - 0.838) < 1e-3);

  const svg = toSvg(doc);
  assert.match(svg, /mix-blend-mode:difference/);
  assert.equal((svg.match(/data-kind="rectangle"/g) || []).length, 5);
});

test('EDB-35217-2.cdr (fuzzed, high-entropy) is rejected cleanly', { skip: skip('EDB-35217-2.cdr') }, async () => {
  await assert.rejects(readCdr(load('EDB-35217-2.cdr')), FormatError);
});

test('fdo63782-1.cmx is identified as CMX and refused', { skip: skip('fdo63782-1.cmx') }, async () => {
  await assert.rejects(readCdr(load('fdo63782-1.cmx')), /CMX/);
});
