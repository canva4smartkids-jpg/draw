import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCdr, toSvg, sniff, versionFromFormChar, productName, nodesToPath, FormatError, toRgb } from '../src/index.js';
import {
  Bytes, chunk, list, cmpr, riff, zip, loda, rgbColor, cmykColor, solidFill, outline, rectGeometry,
  ellipseGeometry, curveGeometry, trfd, object, mcfg, layer, page, ARG, u32,
} from './helpers/build.js';

// A one-page X5-style drawing: a red rectangle under a blue ellipse, plus a
// triangle drawn with a curve record. Objects are stored top-most first.
function sampleX5({ wrapInZip = true } = {}) {
  const objects = [
    object(3, loda(3, [[ARG.FILL, u32(0x30)], [ARG.GEOMETRY, curveGeometry([[0, 0], [10, 0], [5, 8]], [0x00, 0x40, 0x48])]]), trfd(1, 0, -50, 0, 1, -50)),
    object(2, loda(2, [[ARG.FILL, u32(0x20)], [ARG.OUTLINE, u32(0x100)], [ARG.GEOMETRY, ellipseGeometry(40, 20)]]), trfd(1, 0, 10, 0, 1, 10)),
    object(1, loda(1, [[ARG.FILL, u32(0x10)], [ARG.GEOMETRY, rectGeometry(60, -30)]]), trfd(1, 0, -30, 0, 1, 15)),
  ];
  const doc = list('doc ', [
    mcfg(200, 100),
    list('filt', [solidFill(0x10, rgbColor(255, 0, 0)), solidFill(0x20, rgbColor(0, 0, 255)), solidFill(0x30, cmykColor(0, 0, 0, 100))]),
    list('otlt', [outline(0x100, { widthMm: 0.5, color: rgbColor(0, 128, 0), caps: 1, join: 1 })]),
  ]);
  const pages = [
    page(0x90010000, [layer('Guides', 0x9801000a, [])]),
    page(0x90000040, [layer('Layer 1', 0x98000000, objects)]),
  ];
  const riffBytes = riff('CDRF', [chunk('vrsn', new Bytes().u16(1500)), cmpr([doc, ...pages])]);
  return wrapInZip ? zip([['content/riffData.cdr', riffBytes, false], ['metadata/metadata.xml', new TextEncoder().encode('<x><ProductName>Synthetic</ProductName><Author>test</Author></x>'), true]]) : riffBytes;
}

test('version detection from the RIFF form type', () => {
  assert.equal(versionFromFormChar('5'.charCodeAt(0)), 500);
  assert.equal(versionFromFormChar('C'.charCodeAt(0)), 1200);
  assert.equal(versionFromFormChar('F'.charCodeAt(0)), 1500);
  assert.equal(versionFromFormChar(0x20), 300);
  assert.equal(productName(1500), 'CorelDRAW X5');
  assert.equal(productName(1700), 'CorelDRAW X7');
});

test('sniff classifies containers', () => {
  assert.equal(sniff(sampleX5({ wrapInZip: false })).kind, 'cdr-riff');
  assert.equal(sniff(sampleX5()).kind, 'zip');
  assert.equal(sniff(new Bytes().ascii('RIFF').u32(4).ascii('CMX1').bytes()).kind, 'cmx');
  assert.equal(sniff(new Uint8Array(32)).kind, 'unknown');
});

test('reads an X5 package: pages, layers, geometry, fills, outlines', async () => {
  const doc = await readCdr(sampleX5());
  assert.equal(doc.format.version, 1500);
  assert.equal(doc.format.product, 'CorelDRAW X5');
  assert.equal(doc.format.container, 'zip-riffData');
  assert.deepEqual(doc.warnings, []);
  assert.equal(doc.pageSize.width, 200);
  assert.equal(doc.pageSize.height, 100);
  assert.equal(doc.metadata.ProductName, 'Synthetic');

  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0].master, true);
  const [content] = doc.pages.filter((p) => !p.master);
  const l = content.layers[0];
  assert.equal(l.name, 'Layer 1');
  assert.deepEqual(l.objects.map((o) => o.kind), ['curve', 'ellipse', 'rectangle']);

  const rect = l.objects[2];
  assert.deepEqual(rect.fill.color.rgb, [255, 0, 0]);
  assert.equal(rect.outline, null);
  assert.equal(rect.geometry.width, 60);
  assert.equal(rect.geometry.height, -30);
  // rectangle corners after the transform (translate -30, 15)
  const pts = rect.path.filter((c) => c.op !== 'Z').map((c) => [c.x, c.y]);
  assert.deepEqual(pts, [[-30, 15], [-30, -15], [30, -15], [30, 15]]);

  const ell = l.objects[1];
  assert.deepEqual(ell.fill.color.rgb, [0, 0, 255]);
  assert.equal(ell.outline.width, 0.5);
  assert.deepEqual(ell.outline.color.rgb, [0, 128, 0]);
  assert.equal(ell.outline.caps, 'round');
  assert.equal(ell.outline.join, 'round');

  const tri = l.objects[0];
  assert.deepEqual(tri.fill.color.rgb, [0, 0, 0]); // CMYK 0/0/0/100
  assert.deepEqual(tri.path.map((c) => c.op), ['M', 'L', 'L', 'Z']);
});

test('the same drawing as a bare RIFF stream decodes identically', async () => {
  const a = await readCdr(sampleX5());
  const b = await readCdr(sampleX5({ wrapInZip: false }));
  assert.equal(b.format.container, 'riff');
  assert.deepEqual(b.pages, a.pages);
});

test('SVG output paints bottom-most first and flips to y-down page space', async () => {
  const svg = toSvg(await readCdr(sampleX5()));
  assert.match(svg, /viewBox="0 0 200 100"/);
  const kinds = [...svg.matchAll(/data-kind="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ['rectangle', 'ellipse', 'curve']);
  // rectangle (-30..30, -15..15) in page-centre space -> (70..130, 35..65) in SVG space
  assert.match(svg, /d="M70 35L70 65L130 65L130 35Z"[^>]*fill="#ff0000"/);
  assert.match(svg, /fill="#0000ff" stroke="#008000" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round"/);
  assert.doesNotMatch(svg, /Guides/); // master layer is not rendered
});

test('ellipse geometry is a closed four-segment cubic path through the bbox extremes', async () => {
  const doc = await readCdr(sampleX5());
  const ell = doc.pages[1].layers[0].objects[1];
  assert.deepEqual(ell.path.map((c) => c.op), ['M', 'C', 'C', 'C', 'C', 'Z']);
  const xs = ell.path.filter((c) => c.op !== 'Z').map((c) => c.x);
  const ys = ell.path.filter((c) => c.op !== 'Z').map((c) => c.y);
  assert.ok(Math.abs(Math.min(...xs) - 10) < 1e-9 && Math.abs(Math.max(...xs) - 50) < 1e-9);
  assert.ok(Math.abs(Math.min(...ys) - 10) < 1e-9 && Math.abs(Math.max(...ys) - 30) < 1e-9);
});

test('node types: move, line, Bézier controls, close flag', () => {
  const path = nodesToPath(
    [[0, 0], [1, 0], [2, 1], [2, 2], [0, 2]],
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
  await assert.rejects(readCdr(new Uint8Array(1024).fill(0x5a)), (e) => e instanceof FormatError && /not a CorelDRAW file/.test(e.message));
  await assert.rejects(readCdr(new Bytes().ascii('RIFF').u32(4).ascii('CMX1').bytes()), /CMX/);
  await assert.rejects(readCdr(zip([['other.txt', new Uint8Array(4), false]])), /riffData/);
});
