// Builders for synthetic CorelDRAW-style files used by the tests. They write
// the same structures the reader decodes, so every layout assumption in the
// reader is pinned by a test that does not depend on third-party samples.
//
// Note: because these builders encode the reader's own beliefs about the
// format, they prove consistency and catch regressions; correctness against
// CorelDRAW itself is established only by the real-file fixtures.

import { deflateSync, deflateRawSync } from 'node:zlib';

export class Bytes {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  push(u8: Uint8Array): this {
    this.parts.push(u8);
    this.length += u8.length;
    return this;
  }
  u8(v: number): this {
    return this.push(Uint8Array.of(v & 0xff));
  }
  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return this.push(b);
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    return this.push(b);
  }
  s32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return this.push(b);
  }
  f64(v: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.push(b);
  }
  zeros(n: number): this {
    return this.push(new Uint8Array(n));
  }
  ascii(s: string): this {
    return this.push(new TextEncoder().encode(s));
  }
  utf16z(s: string): this {
    for (const ch of s) this.u16(ch.charCodeAt(0));
    return this.u16(0);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export interface LeafNode {
  readonly id: string;
  readonly data: Uint8Array;
}
export interface ListNode {
  readonly id: 'LIST';
  readonly type: string;
  readonly children: readonly RiffNode[];
  readonly compress?: true;
}
export type RiffNode = LeafNode | ListNode;

/** Leaf chunk */
export const chunk = (id: string, data: Uint8Array | Bytes): LeafNode => ({
  id,
  data: data instanceof Bytes ? data.bytes() : data,
});
/** LIST chunk */
export const list = (type: string, children: readonly RiffNode[]): ListNode => ({ id: 'LIST', type, children });
/** Compressed LIST 'cmpr' wrapper */
export const cmpr = (children: readonly RiffNode[]): ListNode => ({
  id: 'LIST',
  type: 'cmpr',
  children,
  compress: true,
});

const isList = (n: RiffNode): n is ListNode => 'children' in n;

/** Serialize nodes; when `table` is given, sizes are written as indices into it. */
function serialize(nodes: readonly RiffNode[], table?: number[]): Uint8Array {
  const out = new Bytes();
  for (const n of nodes) {
    if (isList(n) && n.compress) {
      out.push(serializeCmpr(n.children));
      continue;
    }
    const body = isList(n) ? new Bytes().ascii(n.type).push(serialize(n.children, table)).bytes() : n.data;
    out.ascii(n.id);
    if (table) {
      table.push(body.length);
      out.u32(table.length - 1);
    } else {
      out.u32(body.length);
    }
    out.push(body);
    if (!table && body.length & 1) out.u8(0);
  }
  return out.bytes();
}

function serializeCmpr(children: readonly RiffNode[]): Uint8Array {
  const table: number[] = [];
  const payload = serialize(children, table);
  const tableBytes = new Bytes();
  for (const v of table) tableBytes.u32(v);
  const z1 = deflateSync(payload);
  const z2 = deflateSync(tableBytes.bytes());
  const cpng = (z: Uint8Array): Uint8Array => new Bytes().ascii('CPng').u16(1).u16(4).push(z).bytes();
  const p1 = cpng(z1),
    p2 = cpng(z2);
  const body = new Bytes()
    .ascii('cmpr')
    .u32(p1.length)
    .u32(payload.length)
    .u32(p2.length)
    .u32(tableBytes.length)
    .push(p1)
    .push(p2)
    .bytes();
  const out = new Bytes().ascii('LIST').u32(body.length).push(body);
  if (body.length & 1) out.u8(0);
  return out.bytes();
}

export function riff(form: string, children: readonly RiffNode[]): Uint8Array {
  const body = new Bytes().ascii(form).push(serialize(children)).bytes();
  return new Bytes().ascii('RIFF').u32(body.length).push(body).bytes();
}

/** [entry name, contents, deflate?] */
export type ZipInput = readonly [string, Uint8Array, boolean];

/** Minimal ZIP writer (stored or deflated entries). */
export function zip(entries: readonly ZipInput[]): Uint8Array {
  const local = new Bytes();
  const central = new Bytes();
  let count = 0;
  for (const [name, data, deflate] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const stored = deflate ? deflateRawSync(data) : data;
    const offset = local.length;
    local
      .u32(0x04034b50)
      .u16(20)
      .u16(0)
      .u16(deflate ? 8 : 0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(stored.length)
      .u32(data.length)
      .u16(nameBytes.length)
      .u16(0)
      .push(nameBytes)
      .push(stored);
    central
      .u32(0x02014b50)
      .u16(20)
      .u16(20)
      .u16(0)
      .u16(deflate ? 8 : 0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(stored.length)
      .u32(data.length)
      .u16(nameBytes.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(offset)
      .push(nameBytes);
    count++;
  }
  const cd = central.bytes();
  return new Bytes()
    .push(local.bytes())
    .push(cd)
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(count)
    .u16(count)
    .u32(cd.length)
    .u32(local.length)
    .u16(0)
    .bytes();
}

// ---- CorelDRAW X5 (version 1500) record builders --------------------------

const MM = 10000; // raw units per millimetre

/** A loda argument: [type code, body]. */
export type LodaArg = readonly [number, Uint8Array];

/** loda record: args are stored with their type table reversed, as in real files. */
export function loda(kindCode: number, args: readonly LodaArg[]): LeafNode {
  const n = args.length;
  const headerLen = 20;
  let offset = headerLen;
  const offsets: number[] = [];
  const bodies = new Bytes();
  for (const [, data] of args) {
    offsets.push(offset);
    bodies.push(data);
    offset += data.length;
  }
  const argsStart = offset;
  const typesStart = argsStart + 4 * n;
  const total = typesStart + 4 * n;
  const b = new Bytes().u32(total).u32(n).u32(argsStart).u32(typesStart).u32(kindCode).push(bodies.bytes());
  for (const o of offsets) b.u32(o);
  for (let i = n - 1; i >= 0; i--) b.u32(args[i]?.[0] ?? 0);
  return chunk('loda', b);
}

export function rgbColor(r: number, g: number, b: number): Uint8Array {
  return new Bytes()
    .u16(0x05)
    .u16(0x05)
    .zeros(4)
    .u32((r << 16) | (g << 8) | b)
    .bytes();
}

export function cmykColor(c: number, m: number, y: number, k: number): Uint8Array {
  return new Bytes()
    .u16(0x02)
    .u16(0)
    .zeros(4)
    .u32((k << 24) | (y << 16) | (m << 8) | c)
    .bytes();
}

export function solidFill(id: number, color: Uint8Array): LeafNode {
  return chunk('fild', new Bytes().u32(id).zeros(8).u16(1).zeros(13).push(color));
}

export interface OutlineSpec {
  readonly widthMm?: number;
  readonly color?: Uint8Array;
  readonly flags?: number;
  readonly caps?: number;
  readonly join?: number;
}

export function outline(id: number, spec: OutlineSpec = {}): LeafNode {
  const { widthMm = 0.5, color = rgbColor(0, 0, 0), flags = 0x02, caps = 0, join = 0 } = spec;
  const b = new Bytes().u32(id);
  b.u32(1).u32(0); // block tag 1 = outline body
  b.u16(flags)
    .u16(caps)
    .u16(join)
    .s32(Math.round(widthMm * MM))
    .u16(100)
    .zeros(2)
    .s32(0)
    .zeros(46);
  b.push(color).zeros(16).u16(0).zeros(22).u32(0).u32(0);
  return chunk('outl', b);
}

export function rectGeometry(wMm: number, hMm: number): Uint8Array {
  const b = new Bytes()
    .f64(wMm * MM)
    .f64(hMm * MM)
    .f64(1)
    .f64(1)
    .u8(1)
    .zeros(7);
  b.f64(0).u8(0).zeros(15).f64(0).zeros(16).f64(0).zeros(16).f64(0);
  return b.bytes();
}

export function ellipseGeometry(wMm: number, hMm: number, a0 = 0, a1 = 0, pie = 0): Uint8Array {
  return new Bytes()
    .s32(Math.round(wMm * MM))
    .s32(Math.round(hMm * MM))
    .s32(a0)
    .s32(a1)
    .u32(pie)
    .bytes();
}

export function curveGeometry(points: readonly (readonly [number, number])[], types: readonly number[]): Uint8Array {
  const b = new Bytes().u16(points.length).u16(0);
  for (const [x, y] of points) b.s32(Math.round(x * MM)).s32(Math.round(y * MM));
  for (const t of types) b.u8(t);
  return b.bytes();
}

export function trfd(a: number, b: number, cMm: number, d: number, e: number, fMm: number): ListNode {
  const arg = new Bytes()
    .zeros(8)
    .u16(0x08)
    .zeros(6)
    .f64(a)
    .f64(b)
    .f64(cMm * MM)
    .f64(d)
    .f64(e)
    .f64(fMm * MM)
    .bytes();
  // header (length, count, argsStart) + the single argument + offsets table
  const body = new Bytes()
    .u32(12 + arg.length + 4)
    .u32(1)
    .u32(12 + arg.length)
    .push(arg)
    .u32(12)
    .bytes();
  return list('trfl', [chunk('trfd', body)]);
}

export function object(id: number, lodaChunk: LeafNode, transform?: ListNode): ListNode {
  const lgob: RiffNode[] = transform ? [lodaChunk, transform] : [lodaChunk];
  const children: RiffNode[] = [
    chunk('flgs', new Bytes().u32(0x08000200)),
    chunk('usdn', new Bytes().u32(id)),
    list('lgob', lgob),
  ];
  return list('obj ', children);
}

export function mcfg(wMm: number, hMm: number): LeafNode {
  return chunk(
    'mcfg',
    new Bytes()
      .zeros(12)
      .s32(Math.round(wMm * MM))
      .s32(Math.round(hMm * MM))
      .zeros(64),
  );
}

export function layer(name: string, flags: number, objects: readonly RiffNode[]): ListNode {
  const props = loda(0, [[0x3e8, new Bytes().utf16z(name).bytes()]]);
  return list('layr', [chunk('flgs', new Bytes().u32(flags)), list('lgob', [props]), ...objects]);
}

export function page(flags: number, layers: readonly RiffNode[]): ListNode {
  return list('page', [chunk('flgs', new Bytes().u32(flags)), list('gobj', layers)]);
}

export const ARG = { FILL: 0x14, OUTLINE: 0x0a, GEOMETRY: 0x1e, STYLE: 0xc8, LENS: 0x1f40, NAME: 0x3e8 } as const;
export const u32 = (v: number): Uint8Array => new Bytes().u32(v).bytes();

/**
 * A one-page X5-style drawing: a red rectangle under a blue ellipse, plus a
 * triangle drawn with a curve record. Objects are stored top-most first.
 * Its bytes and decoded outputs are pinned by golden files in io-cdr.
 */
export function syntheticX5({ wrapInZip = true }: { readonly wrapInZip?: boolean } = {}): Uint8Array {
  const objects = [
    object(
      3,
      loda(3, [
        [ARG.FILL, u32(0x30)],
        [
          ARG.GEOMETRY,
          curveGeometry(
            [
              [0, 0],
              [10, 0],
              [5, 8],
            ],
            [0x00, 0x40, 0x48],
          ),
        ],
      ]),
      trfd(1, 0, -50, 0, 1, -50),
    ),
    object(
      2,
      loda(2, [
        [ARG.FILL, u32(0x20)],
        [ARG.OUTLINE, u32(0x100)],
        [ARG.GEOMETRY, ellipseGeometry(40, 20)],
      ]),
      trfd(1, 0, 10, 0, 1, 10),
    ),
    object(
      1,
      loda(1, [
        [ARG.FILL, u32(0x10)],
        [ARG.GEOMETRY, rectGeometry(60, -30)],
      ]),
      trfd(1, 0, -30, 0, 1, 15),
    ),
  ];
  const doc = list('doc ', [
    mcfg(200, 100),
    list('filt', [
      solidFill(0x10, rgbColor(255, 0, 0)),
      solidFill(0x20, rgbColor(0, 0, 255)),
      solidFill(0x30, cmykColor(0, 0, 0, 100)),
    ]),
    list('otlt', [outline(0x100, { widthMm: 0.5, color: rgbColor(0, 128, 0), caps: 1, join: 1 })]),
  ]);
  const pages = [
    page(0x90010000, [layer('Guides', 0x9801000a, [])]),
    page(0x90000040, [layer('Layer 1', 0x98000000, objects)]),
  ];
  const riffBytes = riff('CDRF', [chunk('vrsn', new Bytes().u16(1500)), cmpr([doc, ...pages])]);
  return wrapInZip
    ? zip([
        ['content/riffData.cdr', riffBytes, false],
        [
          'metadata/metadata.xml',
          new TextEncoder().encode('<x><ProductName>Synthetic</ProductName><Author>test</Author></x>'),
          true,
        ],
      ])
    : riffBytes;
}
