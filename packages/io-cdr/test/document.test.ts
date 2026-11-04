import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FormatError } from '@draw/archive';
import { readCdr, toSvg, sniff, versionFromFormChar, productName, nodesToPath, toRgb } from '@draw/io-cdr';
import type { CdrObject, CdrNode } from '@draw/io-cdr';
import { Bytes, zip, syntheticX5 } from '@draw/testkit';

const asObject = (n: CdrNode | undefined): CdrObject => {
  assert.ok(n && n.kind !== 'group', 'expected an object, not a group');
  return n;
};

test('version detection from the RIFF form type', () => {
  assert.equal(versionFromFormChar('5'.charCodeAt(0)), 500);
  assert.equal(versionFromFormChar('C'.charCodeAt(0)), 1200);
  assert.equal(versionFromFormChar('F'.charCodeAt(0)), 1500);
  assert.equal(versionFromFormChar(0x20), 300);
  assert.equal(productName(1500), 'CorelDRAW X5');
  assert.equal(productName(1700), 'CorelDRAW X7');
});

test('sniff classifies containers', () => {
  assert.equal(sniff(syntheticX5({ wrapInZip: false })).kind, 'cdr-riff');
  assert.equal(sniff(syntheticX5()).kind, 'zip');
  assert.equal(sniff(new Bytes().ascii('RIFF').u32(4).ascii('CMX1').bytes()).kind, 'cmx');
  assert.equal(sniff(new Uint8Array(32)).kind, 'unknown');
});

test('reads an X5 package: pages, layers, geometry, fills, outlines', async () => {
  const doc = await readCdr(syntheticX5());
  assert.equal(doc.format.version, 1500);
  assert.equal(doc.format.product, 'CorelDRAW X5');
  assert.equal(doc.format.container, 'zip-riffData');
  assert.deepEqual(doc.warnings, []);
  assert.equal(doc.pageSize.width, 200);
  assert.equal(doc.pageSize.height, 100);
  assert.equal(doc.metadata?.ProductName, 'Synthetic');

  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0]!.master, true);
  const [content] = doc.pages.filter((p) => !p.master);
  const l = content!.layers[0]!;
  assert.equal(l.name, 'Layer 1');
  assert.deepEqual(
    l.objects.map((o) => o.kind),
    ['curve', 'ellipse', 'rectangle'],
  );

  const rect = asObject(l.objects[2]);
  assert.ok(rect.fill?.type === 'solid');
  assert.deepEqual(rect.fill.color.rgb, [255, 0, 0]);
  assert.equal(rect.outline, null);
  assert.ok(rect.geometry && 'type' in rect.geometry && rect.geometry.type === 'rectangle');
  assert.equal(rect.geometry.width, 60);
  assert.equal(rect.geometry.height, -30);
  // rectangle corners after the transform (translate -30, 15)
  const pts = rect.path!.flatMap((c) => (c.op === 'Z' ? [] : [[c.x, c.y]]));
  assert.deepEqual(pts, [
    [-30, 15],
    [-30, -15],
    [30, -15],
    [30, 15],
  ]);

  const ell = asObject(l.objects[1]);
  assert.ok(ell.fill?.type === 'solid');
  assert.deepEqual(ell.fill.color.rgb, [0, 0, 255]);
  assert.equal(ell.outline?.width, 0.5);
  assert.deepEqual(ell.outline.color.rgb, [0, 128, 0]);
  assert.equal(ell.outline.caps, 'round');
  assert.equal(ell.outline.join, 'round');

  const tri = asObject(l.objects[0]);
  assert.ok(tri.fill?.type === 'solid');
  assert.deepEqual(tri.fill.color.rgb, [0, 0, 0]); // CMYK 0/0/0/100
  assert.deepEqual(
    tri.path!.map((c) => c.op),
    ['M', 'L', 'L', 'Z'],
  );
});

test('the same drawing as a bare RIFF stream decodes identically', async () => {
  const a = await readCdr(syntheticX5());
  const b = await readCdr(syntheticX5({ wrapInZip: false }));
  assert.equal(b.format.container, 'riff');
  assert.deepEqual(b.pages, a.pages);
});

test('SVG output paints bottom-most first and flips to y-down page space', async () => {
  const svg = toSvg(await readCdr(syntheticX5()));
  assert.match(svg, /viewBox="0 0 200 100"/);
  const kinds = [...svg.matchAll(/data-kind="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ['rectangle', 'ellipse', 'curve']);
  // rectangle (-30..30, -15..15) in page-centre space -> (70..130, 35..65) in SVG space
  assert.match(svg, /d="M70 35L70 65L130 65L130 35Z"[^>]*fill="#ff0000"/);
  assert.match(
    svg,
    /fill="#0000ff" stroke="#008000" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"/,
  );
  assert.doesNotMatch(svg, /Guides/); // master layer is not rendered
});

test('ellipse geometry is a closed four-segment cubic path through the bbox extremes', async () => {
  const doc = await readCdr(syntheticX5());
  const ell = asObject(doc.pages[1]!.layers[0]!.objects[1]);
  const path = ell.path!;
  assert.deepEqual(
    path.map((c) => c.op),
    ['M', 'C', 'C', 'C', 'C', 'Z'],
  );
  const xs = path.flatMap((c) => (c.op === 'Z' ? [] : [c.x]));
  const ys = path.flatMap((c) => (c.op === 'Z' ? [] : [c.y]));
  assert.ok(Math.abs(Math.min(...xs) - 10) < 1e-9 && Math.abs(Math.max(...xs) - 50) < 1e-9);
  assert.ok(Math.abs(Math.min(...ys) - 10) < 1e-9 && Math.abs(Math.max(...ys) - 30) < 1e-9);
});

test('node types: move, line, Bézier controls, close flag', () => {
  const path = nodesToPath(
    [
      [0, 0],
      [1, 0],
      [2, 1],
      [2, 2],
      [0, 2],
    ],
    [0x00, 0x40, 0xc0, 0xc0, 0x88],
  );
  assert.deepEqual(path, [
    { op: 'M', x: 0, y: 0 },
    { op: 'L', x: 1, y: 0 },
    { op: 'C', x1: 2, y1: 1, x2: 2, y2: 2, x: 0, y: 2 },
    { op: 'Z' },
  ]);
});

test('colour models', () => {
  assert.deepEqual(toRgb({ model: 0x05, value: 0x00336699 }).rgb, [0x33, 0x66, 0x99]);
  assert.deepEqual(toRgb({ model: 0x02, value: 0 }).rgb, [255, 255, 255]);
  assert.deepEqual(toRgb({ model: 0x02, value: 100 }).rgb, [0, 255, 255]); // 100% cyan
  assert.deepEqual(toRgb({ model: 0x09, value: 0x80 }).rgb, [128, 128, 128]);
  assert.deepEqual(toRgb({ model: 0x04, value: 0x0000ff }).rgb, [0, 255, 255]);
  assert.deepEqual(toRgb({ model: 0x06, value: (255 << 24) | (255 << 16) | 120 }).rgb, [0, 255, 0]); // HSB 120°
});

test('rejects unrelated and CMX files with explicit errors', async () => {
  await assert.rejects(
    readCdr(new Uint8Array(1024).fill(0x5a)),
    (e: unknown) => e instanceof FormatError && e.message.includes('not a CorelDRAW file'),
  );
  await assert.rejects(readCdr(new Bytes().ascii('RIFF').u32(4).ascii('CMX1').bytes()), /CMX/);
  await assert.rejects(readCdr(zip([['other.txt', new Uint8Array(4), false]])), /riffData/);
});
