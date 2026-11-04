// Builders for synthetic CorelDRAW-style files used by the tests. They write
// the same structures the reader decodes, so every layout assumption in the
// reader is pinned by a test that does not depend on third-party samples.

import { deflateSync, deflateRawSync } from 'node:zlib';

export class Bytes {
  constructor() { this.parts = []; this.length = 0; }
  push(u8) { this.parts.push(u8); this.length += u8.length; return this; }
  u8(v) { return this.push(Uint8Array.of(v & 0xff)); }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return this.push(b); }
  s32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return this.push(b); }
  f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return this.push(b); }
  zeros(n) { return this.push(new Uint8Array(n)); }
  ascii(s) { return this.push(new TextEncoder().encode(s)); }
  utf16z(s) { for (const ch of s) this.u16(ch.charCodeAt(0)); return this.u16(0); }
  bytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** Leaf chunk */
export const chunk = (id, data) => ({ id, data: data instanceof Bytes ? data.bytes() : data });
/** LIST chunk */
export const list = (type, children) => ({ id: 'LIST', type, children });
/** Compressed LIST 'cmpr' wrapper */
export const cmpr = (children) => ({ id: 'LIST', type: 'cmpr', children, compress: true });

/** Serialize nodes; when `table` is given, sizes are written as indices into it. */
function serialize(nodes, table) {
  const out = new Bytes();
  for (const n of nodes) {
    if (n.compress) {
      out.push(serializeCmpr(n.children));
      continue;
    }
    const body = n.children ? new Bytes().ascii(n.type).push(serialize(n.children, table)).bytes() : n.data;
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

function serializeCmpr(children) {
  const table = [];
  const payload = serialize(children, table);
  const tableBytes = new Bytes();
  for (const v of table) tableBytes.u32(v);
  const z1 = deflateSync(payload);
  const z2 = deflateSync(tableBytes.bytes());
  const cpng = (z) => new Bytes().ascii('CPng').u16(1).u16(4).push(z).bytes();
  const p1 = cpng(z1), p2 = cpng(z2);
  const body = new Bytes().ascii('cmpr').u32(p1.length).u32(payload.length).u32(p2.length).u32(tableBytes.length).push(p1).push(p2).bytes();
  const out = new Bytes().ascii('LIST').u32(body.length).push(body);
  if (body.length & 1) out.u8(0);
  return out.bytes();
}

export function riff(form, children) {
  const body = new Bytes().ascii(form).push(serialize(children)).bytes();
  return new Bytes().ascii('RIFF').u32(body.length).push(body).bytes();
}

/** Minimal ZIP writer (stored or deflated entries). */
export function zip(entries) {
  const local = new Bytes();
  const central = new Bytes();
  let count = 0;
  for (const [name, data, deflate] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const stored = deflate ? deflateRawSync(data) : data;
    const offset = local.length;
    local.u32(0x04034b50).u16(20).u16(0).u16(deflate ? 8 : 0).u16(0).u16(0).u32(0)
      .u32(stored.length).u32(data.length).u16(nameBytes.length).u16(0).push(nameBytes).push(stored);
    central.u32(0x02014b50).u16(20).u16(20).u16(0).u16(deflate ? 8 : 0).u16(0).u16(0).u32(0)
      .u32(stored.length).u32(data.length).u16(nameBytes.length).u16(0).u16(0).u16(0).u16(0).u32(0)
      .u32(offset).push(nameBytes);
    count++;
  }
  const cd = central.bytes();
  return new Bytes().push(local.bytes()).push(cd)
    .u32(0x06054b50).u16(0).u16(0).u16(count).u16(count).u32(cd.length).u32(local.length).u16(0).bytes();
}

// ---- CorelDRAW X5 (version 1500) record builders --------------------------

const MM = 10000; // raw units per millimetre

/** loda record: args = [[type, Uint8Array], ...]; types are stored reversed. */
export function loda(kindCode, args) {
  const n = args.length;
  const headerLen = 20;
  let offset = headerLen;
  const offsets = [];
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
  for (let i = n - 1; i >= 0; i--) b.u32(args[i][0]);
  return chunk('loda', b);
}

export function rgbColor(r, g, b) {
  return new Bytes().u16(0x05).u16(0x05).zeros(4).u32((r << 16) | (g << 8) | b).bytes();
}

export function cmykColor(c, m, y, k) {
  return new Bytes().u16(0x02).u16(0).zeros(4).u32((k << 24) | (y << 16) | (m << 8) | c).bytes();
}

export function solidFill(id, color) {
  return chunk('fild', new Bytes().u32(id).zeros(8).u16(1).zeros(13).push(color));
}

export function outline(id, { widthMm = 0.5, color = rgbColor(0, 0, 0), flags = 0x02, caps = 0, join = 0 } = {}) {
  const b = new Bytes().u32(id);
  b.u32(1).u32(0); // block tag 1 = outline body
  b.u16(flags).u16(caps).u16(join).s32(Math.round(widthMm * MM)).u16(100).zeros(2).s32(0).zeros(46);
  b.push(color).zeros(16).u16(0).zeros(22).u32(0).u32(0);
  return chunk('outl', b);
}

export function rectGeometry(wMm, hMm) {
  const b = new Bytes().f64(wMm * MM).f64(hMm * MM).f64(1).f64(1).u8(1).zeros(7);
  b.f64(0).u8(0).zeros(15).f64(0).zeros(16).f64(0).zeros(16).f64(0);
  return b.bytes();
}

export function ellipseGeometry(wMm, hMm, a0 = 0, a1 = 0, pie = 0) {
  return new Bytes().s32(Math.round(wMm * MM)).s32(Math.round(hMm * MM)).s32(a0).s32(a1).u32(pie).bytes();
}

export function curveGeometry(points, types) {
  const b = new Bytes().u16(points.length).u16(0);
  for (const [x, y] of points) b.s32(Math.round(x * MM)).s32(Math.round(y * MM));
  for (const t of types) b.u8(t);
  return b.bytes();
}

export function trfd(a, b, cMm, d, e, fMm) {
  const arg = new Bytes().zeros(8).u16(0x08).zeros(6).f64(a).f64(b).f64(cMm * MM).f64(d).f64(e).f64(fMm * MM).bytes();
  // header (length, count, argsStart) + the single argument + offsets table
  const body = new Bytes().u32(12 + arg.length + 4).u32(1).u32(12 + arg.length).push(arg).u32(12).bytes();
  return list('trfl', [chunk('trfd', body)]);
}

export function object(id, lodaChunk, transform) {
  const children = [chunk('flgs', new Bytes().u32(0x08000200)), chunk('usdn', new Bytes().u32(id)), list('lgob', [lodaChunk, transform].filter(Boolean))];
  return list('obj ', children);
}

export function mcfg(wMm, hMm) {
  return chunk('mcfg', new Bytes().zeros(12).s32(Math.round(wMm * MM)).s32(Math.round(hMm * MM)).zeros(64));
}

export function layer(name, flags, objects) {
  const props = loda(0, [[0x3e8, new Bytes().utf16z(name).bytes()]]);
  return list('layr', [chunk('flgs', new Bytes().u32(flags)), list('lgob', [props]), ...objects]);
}

export function page(flags, layers) {
  return list('page', [chunk('flgs', new Bytes().u32(flags)), list('gobj', layers)]);
}

export const ARG = { FILL: 0x14, OUTLINE: 0x0a, GEOMETRY: 0x1e, STYLE: 0xc8, LENS: 0x1f40, NAME: 0x3e8 };
export const u32 = (v) => new Bytes().u32(v).bytes();
