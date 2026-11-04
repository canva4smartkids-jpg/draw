// CorelDRAW document reader: container detection, version handling and the
// semantic layer (pages, layers, objects, fills, outlines, styles).
//
// The record layouts used here were established by dissecting real files
// (see docs/cdr-format.md for the evidence and confidence of each field) and
// cross-checked against the publicly documented behaviour of libcdr.

import { Reader, FormatError, fourccAt, toHex } from './binary.js';
import { isZip, openZip } from './zip.js';
import { parseRiff, walk } from './riff.js';
import { toRgb, modelName } from './color.js';
import { IDENTITY, then, arcToCubics, transformPath, rotation } from './path.js';

/** Map the 4th byte of the RIFF form type ('CDR?') to a version number. */
export function versionFromFormChar(code) {
  if (code === 0x20) return 300;
  if (code >= 0x31 && code <= 0x39) return 100 * (code - 0x30);
  if (code >= 0x41 && code <= 0x5a) return 100 * (code - 0x37);
  return 0;
}

const PRODUCT_NAMES = {
  300: 'CorelDRAW 3', 400: 'CorelDRAW 4', 500: 'CorelDRAW 5', 600: 'CorelDRAW 6', 700: 'CorelDRAW 7',
  800: 'CorelDRAW 8', 900: 'CorelDRAW 9', 1000: 'CorelDRAW 10', 1100: 'CorelDRAW 11', 1200: 'CorelDRAW 12',
  1300: 'CorelDRAW X3', 1400: 'CorelDRAW X4', 1500: 'CorelDRAW X5', 1600: 'CorelDRAW X6', 1700: 'CorelDRAW X7',
  1800: 'CorelDRAW X8', 1900: 'CorelDRAW 2017', 2000: 'CorelDRAW 2018', 2100: 'CorelDRAW 2019',
  2200: 'CorelDRAW 2020', 2300: 'CorelDRAW 2021', 2400: 'CorelDRAW 2022', 2500: 'CorelDRAW 2023',
  2600: 'CorelDRAW 2024', 2700: 'CorelDRAW 2025',
};

export function productName(version) {
  return PRODUCT_NAMES[Math.floor(version / 100) * 100] ?? `CorelDRAW (version ${version})`;
}

// loda argument type codes
const ARG = Object.freeze({
  OUTLINE: 0x0a,
  FILL: 0x14,
  GEOMETRY: 0x1e,
  OLD_TRANSFORM: 0x64,
  STYLE: 0xc8,
  NAME: 0x3e8,
  LENS: 0x1f40,
  POLYGON: 0x2af8,
  PAGE_SIZE: 0x4aba,
  GUID: 0x9c41,
});

// Leaf chunk ids that X6+ files may store out-of-line in content/data/*.dat
const REDIRECTABLE = new Set(['vrsn', 'mcfg', 'fild', 'fill', 'outl', 'loda', 'lobj', 'trfd', 'flgs', 'bbox', 'obbx', 'ftil', 'arrw', 'font', 'usdn', 'stlt']);

/**
 * Identify a file without fully parsing it.
 * @param {Uint8Array} bytes
 */
export function sniff(bytes) {
  if (fourccAt(bytes, 0) === 'RIFF') {
    const form = fourccAt(bytes, 8);
    if (/^cdr/i.test(form)) return { kind: 'cdr-riff', version: versionFromFormChar(bytes[11]) };
    if (/^CMX/.test(form)) return { kind: 'cmx', version: 0 };
    return { kind: 'riff', form };
  }
  if (isZip(bytes)) return { kind: 'zip' };
  return { kind: 'unknown' };
}

/**
 * Read a CorelDRAW document.
 * @param {Uint8Array} bytes
 * @returns {Promise<CdrDocument>}
 */
export async function readCdr(bytes, options = {}) {
  const warnings = [];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const info = sniff(bytes);
  let riffBytes;
  let container;
  let externalStreams = [];
  let sidecars = {};

  if (info.kind === 'cdr-riff') {
    riffBytes = bytes;
    container = 'riff';
  } else if (info.kind === 'zip') {
    const zip = openZip(bytes);
    if (zip.entries.has('content/riffData.cdr')) {
      riffBytes = await zip.read('content/riffData.cdr');
      container = 'zip-riffData';
    } else if (zip.entries.has('content/root.dat')) {
      riffBytes = await zip.read('content/root.dat');
      container = 'zip-root';
      const list = await zip.read('content/dataFileList.dat');
      const names = list ? new TextDecoder('latin1').decode(list).split('\n').map((s) => s.trim()).filter(Boolean) : [];
      for (const name of names) externalStreams.push((await zip.read(`content/data/${name}`)) ?? null);
    } else {
      throw new FormatError('ZIP package has no content/riffData.cdr or content/root.dat; not a CorelDRAW document');
    }
    for (const name of ['metadata/metadata.xml', 'color/docPalette.xml']) {
      const data = zip.entries.has(name) ? await zip.read(name) : null;
      if (data) sidecars[name] = new TextDecoder('utf-8').decode(data);
    }
    sidecars.entries = [...zip.entries.keys()];
  } else if (info.kind === 'cmx') {
    throw new FormatError('this is a Corel Presentation Exchange (CMX) file, not a CDR drawing; CMX is not supported yet');
  } else {
    throw new FormatError('not a CorelDRAW file (no RIFF "CDR" header and no ZIP package)');
  }

  const root = await parseRiff(riffBytes);
  if (!/^cdr/i.test(root.type ?? '')) throw new FormatError(`RIFF form type '${root.type}' is not a CDR drawing`);

  let version = versionFromFormChar(riffBytes[11]);
  const vrsn = root.children.find((c) => c.id === 'vrsn');
  if (vrsn && vrsn.data.length >= 2) {
    const v = new Reader(vrsn.data).u16();
    if (v >= 100 && v < 10000) version = v;
  }
  if (!version) throw new FormatError('could not determine CDR version');

  const ctx = new Context(version, warn, externalStreams);
  if (version < 400) warn(`version ${version} (pre-CorelDRAW 4) stores fills and outlines inline; only geometry is decoded`);
  if (version >= 1600) warn(`version ${version} uses the split-stream X6+ layout; decoding is implemented but has not been verified against a real file`);

  // Pass 1: document-level tables. Style definitions precede the pages in
  // every file seen so far, but collecting them first makes order irrelevant.
  const pageSize = { width: 210, height: 297, fromFile: false };
  for (const { chunk } of walk(root)) {
    try {
      switch (chunk.id) {
        case 'mcfg': {
          const s = ctx.readMcfg(ctx.payload(chunk));
          if (s) Object.assign(pageSize, s, { fromFile: true });
          break;
        }
        case 'fild':
        case 'fill': {
          const f = ctx.readFill(ctx.payload(chunk));
          if (f) ctx.fills.set(f._id, f);
          break;
        }
        case 'outl': {
          const o = ctx.readOutline(ctx.payload(chunk));
          if (o) ctx.outlines.set(o._id, o);
          break;
        }
        case 'font': {
          const f = ctx.readFont(ctx.payload(chunk));
          if (f) ctx.fonts.set(f.id, f);
          break;
        }
        default:
          if (chunk.type === 'stlt' && version >= 700) ctx.readStyleTable(ctx.payload(chunk));
      }
    } catch (err) {
      warn(`could not decode '${chunk.type ?? chunk.id}' record: ${err.message}`);
    }
  }

  // Pass 2: pages -> layers -> objects.
  const pages = [];
  for (const chunk of root.children) collectPages(chunk, ctx, pages);
  for (const page of pages) {
    if (!page.width) page.width = pageSize.width;
    if (!page.height) page.height = pageSize.height;
  }

  return {
    format: {
      container,
      version,
      product: productName(version),
      precision: ctx.precision,
      units: 'mm',
      // Page coordinates: origin at the page centre, y axis up.
      coordinateSystem: 'page-centre-y-up',
      // Layers and objects are listed as stored: top-most first.
      stackingOrder: 'top-first',
    },
    pageSize,
    pages,
    fills: Object.fromEntries([...ctx.fills].map(([k, v]) => [hexId(k), v])),
    outlines: Object.fromEntries([...ctx.outlines].map(([k, v]) => [hexId(k), v])),
    styles: Object.fromEntries([...ctx.styles].map(([k, v]) => [hexId(k), v])),
    fonts: Object.fromEntries([...ctx.fonts].map(([k, v]) => [k, v])),
    metadata: parseMetadata(sidecars['metadata/metadata.xml']),
    packageEntries: sidecars.entries ?? null,
    tree: options.keepTree ? root : undefined,
    warnings,
  };
}

const hexId = (id) => '0x' + (id >>> 0).toString(16).padStart(8, '0');

function collectPages(chunk, ctx, pages) {
  if (chunk.type === 'page') {
    const page = { index: pages.length, flags: 0, master: false, width: 0, height: 0, layers: [] };
    const flgs = chunk.children.find((c) => c.id === 'flgs');
    if (flgs) page.flags = ctx.u32Of(flgs);
    // Pages whose flags carry bits in 0x00ff0000 hold the master layers
    // (desktop, guides, grid) rather than printable content.
    page.master = (page.flags & 0x00ff0000) !== 0;
    for (const c of chunk.children) collectLayers(c, ctx, page);
    pages.push(page);
    return;
  }
  for (const c of chunk.children) collectPages(c, ctx, pages);
}

function collectLayers(chunk, ctx, page) {
  if (chunk.type === 'layr') {
    const layer = { flags: 0, master: false, kind: null, name: null, objects: [] };
    for (const c of chunk.children) {
      if (c.id === 'flgs') layer.flags = ctx.u32Of(c);
      else if (c.type === 'lgob') {
        const loda = c.children.find((x) => x.id === 'loda' || x.id === 'lobj');
        if (loda) {
          const props = ctx.readLoda(ctx.payload(loda));
          layer.kind = props.kind;
          if (props.name) layer.name = props.name;
        }
      } else collectObjects(c, ctx, layer.objects);
    }
    layer.master = (layer.flags & 0x00ff0000) !== 0;
    page.layers.push(layer);
    return;
  }
  for (const c of chunk.children) collectLayers(c, ctx, page);
}

function collectObjects(chunk, ctx, out) {
  if (chunk.type === 'obj ') {
    const obj = ctx.buildObject(chunk);
    if (obj) out.push(obj);
    return;
  }
  if (chunk.type === 'grp ' || chunk.type === 'lnkg' || chunk.type === 'vect' || chunk.type === 'clpt') {
    const group = { kind: 'group', container: chunk.type.trim(), children: [] };
    for (const c of chunk.children) collectObjects(c, ctx, group.children);
    if (group.children.length) out.push(group);
    return;
  }
  for (const c of chunk.children) collectObjects(c, ctx, out);
}

class Context {
  constructor(version, warn, externalStreams) {
    this.version = version;
    this.precision = version < 600 ? 16 : 32;
    this.warn = warn;
    this.externalStreams = externalStreams;
    this.fills = new Map();
    this.outlines = new Map();
    this.styles = new Map();
    this.fonts = new Map();
    // stlt indirection tables: style-local id -> fild/outl id
    this.styleFillRefs = new Map();
    this.styleOutlineRefs = new Map();
  }

  /** Chunk body, following an X6+ out-of-line reference when present. */
  payload(chunk) {
    const id = chunk.type === 'stlt' ? 'stlt' : chunk.id;
    if (this.version >= 1600 && REDIRECTABLE.has(id) && chunk.size === 16 && chunk.data.length >= 12) {
      const r = new Reader(chunk.data);
      const stream = r.u32();
      const length = r.u32();
      const offset = r.u32();
      if (stream === 0xffffffff) return chunk.data;
      const ext = this.externalStreams[stream];
      if (!ext) throw new FormatError(`'${id}' refers to missing data stream ${stream}`);
      if (offset + length > ext.length) throw new FormatError(`'${id}' reference overruns data stream ${stream}`);
      return ext.subarray(offset, offset + length);
    }
    return chunk.data;
  }

  u32Of(chunk) {
    const d = this.payload(chunk);
    return d.length >= 4 ? new Reader(d).u32() : 0;
  }

  // ---- primitive readers that depend on version ---------------------------

  /** Coordinate in millimetres. */
  coord(r) {
    return this.precision === 16 ? r.s16() * 0.0254 : r.s32() / 10000;
  }

  /** Raw double coordinate (X5+ rectangles, matrices) in millimetres. */
  dcoord(r) {
    return this.version < 600 ? r.f64() * 0.0254 : r.f64() / 10000;
  }

  angle(r) {
    return this.precision === 16 ? (Math.PI * r.s16()) / 1800 : (Math.PI * r.s32()) / 180000000;
  }

  unsigned(r) {
    return this.precision === 16 ? r.u16() : r.u32();
  }

  integer(r) {
    return this.precision === 16 ? r.s16() : r.s32();
  }

  color(r) {
    const v = this.version;
    let model, palette = 0, value;
    if (v >= 500) {
      model = r.u16();
      if (model === 0x01 && v >= 1300) model = 0x19;
      if (model === 0x1e) {
        model = 0x19;
        palette = 0x1e;
      } else {
        palette = r.u16();
        r.skip(4);
      }
      value = r.u32();
    } else if (v >= 400) {
      model = r.u16();
      const c = r.u16(), m = r.u16(), y = r.u16(), k = r.u16();
      value = ((k & 0xff) << 24 | (y & 0xff) << 16 | (m & 0xff) << 8 | (c & 0xff)) >>> 0;
      r.skip(2);
    } else {
      model = r.u8();
      value = r.u32();
    }
    const { rgb, exact } = toRgb({ model, value });
    if (!exact && (model === 0x19 || model === 0x00)) this.warn('spot/palette colors are approximated as gray (palette tables not implemented)');
    return { model: modelName(model), modelCode: model, palette, value: '0x' + value.toString(16).padStart(8, '0'), rgb };
  }

  // ---- document tables ----------------------------------------------------

  readMcfg(data) {
    const r = new Reader(data);
    const v = this.version;
    if (v >= 1300) r.skip(12);
    else if (v >= 900) r.skip(4);
    else if (v >= 600 && v < 700) r.skip(0x1c);
    if (v < 400) {
      r.skip(2);
      const x0 = this.coord(r), y0 = this.coord(r), x1 = this.coord(r), y1 = this.coord(r);
      return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }
    const width = this.coord(r);
    const height = this.coord(r);
    if (!(width > 0 && height > 0)) return null;
    return { width, height };
  }

  readFont(data) {
    const r = new Reader(data);
    const id = r.u16();
    const encoding = r.u16();
    r.skip(14);
    const rest = data.subarray(r.pos);
    const name = this.version >= 1200 ? decodeUtf16z(rest) : decodeLatin1z(rest);
    return { id, encoding, name };
  }

  readFill(data) {
    const r = new Reader(data);
    const v = this.version;
    const id = r.u32();
    if (v >= 1300) r.skip(8);
    const type = r.u16();
    const fill = { id: hexId(id), _id: id, type: 'none', typeCode: type };
    switch (type) {
      case 0:
        break;
      case 1:
        r.skip(v >= 1300 ? 13 : 2);
        fill.type = 'solid';
        fill.color = this.color(r);
        break;
      case 2: {
        r.skip(v >= 1300 ? 8 : 2);
        const g = { kind: r.u8() };
        if (v >= 1300) { r.skip(17); g.edgeOffset = r.s16(); }
        else if (v >= 600) { r.skip(19); g.edgeOffset = r.s32(); }
        else { r.skip(11); g.edgeOffset = r.s16(); }
        g.angle = this.angle(r);
        g.centerX = this.integer(r);
        g.centerY = this.integer(r);
        if (v >= 600) r.skip(2);
        g.mode = this.unsigned(r) & 0xff;
        g.midpoint = r.u8() / 100;
        r.skip(1);
        const count = this.unsigned(r) & 0xffff;
        if (v >= 1300) r.skip(3);
        g.stops = [];
        for (let i = 0; i < count && r.remaining > 4; i++) {
          const color = this.color(r);
          if (v >= 1500) r.skip(26);
          else if (v >= 1300) r.skip(5);
          const offset = (this.unsigned(r) & 0xffff) / 100;
          if (v >= 1300) r.skip(3);
          g.stops.push({ offset, color });
        }
        g.kind = ['linear', 'linear', 'radial', 'conical', 'square'][g.kind] ?? 'linear';
        fill.type = 'gradient';
        fill.gradient = g;
        break;
      }
      default:
        fill.type = { 7: 'pattern', 9: 'bitmap', 10: 'full-color-pattern', 11: 'texture', 14: 'postscript', 15: 'postscript' }[type] ?? `unknown-${type}`;
    }
    return fill;
  }

  readOutline(data) {
    const r = new Reader(data);
    const v = this.version;
    const id = r.u32();
    if (v >= 1300) {
      // A list of (tag u32, length u32, body) blocks; the outline proper is tag 1.
      let tag = 0, len = 0;
      while (tag !== 1) {
        r.skip(len);
        tag = r.u32();
        len = r.u32();
      }
    }
    const flags = r.u16();
    const caps = r.u16();
    const join = r.u16();
    if (v < 1300 && v >= 600) r.skip(2);
    const width = this.coord(r);
    const stretch = r.u16() / 100;
    if (v >= 600) r.skip(2);
    const angle = this.angle(r);
    if (v >= 1300) r.skip(46);
    else if (v >= 600) r.skip(52);
    const color = this.color(r);
    r.skip(v < 600 ? 10 : 16);
    const dashCount = r.u16();
    const dashes = [];
    for (let i = 0; i < dashCount && r.remaining >= 2; i++) dashes.push(r.u16());
    return {
      id: hexId(id),
      _id: id,
      flags,
      none: (flags & 0x1) !== 0,
      dashed: (flags & 0x4) !== 0 && dashes.length > 0,
      scaleWithObject: (flags & 0x20) !== 0,
      caps: ['butt', 'round', 'square'][caps] ?? 'butt',
      join: ['miter', 'round', 'bevel'][join] ?? 'miter',
      width,
      stretch: stretch || 1,
      angle,
      color,
      dashes,
    };
  }

  /** Style table: fill/outline indirection tables followed by style records. */
  readStyleTable(data) {
    const r = new Reader(data);
    const v = this.version;
    const count = r.u32();
    if (!count) return;
    const nFills = r.u32();
    for (let i = 0; i < nFills; i++) {
      const ref = r.u32();
      r.skip(4);
      this.styleFillRefs.set(ref, r.u32());
      if (v >= 1300) r.skip(48);
    }
    const nOutlines = r.u32();
    for (let i = 0; i < nOutlines; i++) {
      const ref = r.u32();
      r.skip(4);
      this.styleOutlineRefs.set(ref, r.u32());
    }
    const nFonts = r.u32();
    const fontRecord = 4 + 4 + 8 + (this.precision === 16 ? 2 : 4) + 2 * (v < 1000 ? 12 : 20);
    r.skip(nFonts * fontRecord);
    const nAligns = r.u32();
    r.skip(nAligns * 12);
    r.skip(r.u32() * 52); // intervals
    r.skip(r.u32() * 152); // "set5" paragraph records
    r.skip(r.u32() * 784); // tab tables
    const nBullets = r.u32();
    for (let i = 0; i < nBullets; i++) {
      r.skip(40);
      if (v > 1300) r.skip(4);
      if (v >= 1300) {
        r.skip(r.u32() ? 68 : 12);
      } else {
        r.skip(20);
        if (v >= 1000) r.skip(8);
        if (r.u32()) r.skip(8);
        r.skip(8);
      }
    }
    r.skip(r.u32() * (16 + 3 * (this.precision === 16 ? 2 : 4))); // indents: id, 12 bytes, right/first/left
    r.skip(r.u32() * (v >= 1300 ? 36 : 32)); // hyphenation
    r.skip(r.u32() * 28); // drop caps
    if (v > 800) r.skip(r.u32() * 12);
    for (let i = 0; i < count && r.remaining >= 32; i++) {
      const parts = r.u32();
      const id = r.u32();
      const parentId = r.u32();
      r.skip(8);
      const nameLen = r.u32();
      const nameBytes = r.bytesView(v >= 1200 ? nameLen * 2 : nameLen);
      const name = v >= 1200 ? decodeUtf16z(nameBytes) : decodeLatin1z(nameBytes);
      const fillRef = r.u32();
      const outlineRef = r.u32();
      if (parts > 1) r.skip(v > 800 ? 20 : 16);
      if (parts > 2) r.skip(20);
      this.styles.set(id, { id: hexId(id), name, parentId: parentId ? hexId(parentId) : null, fillRef, outlineRef, _parent: parentId });
    }
  }

  /** Resolve a style's fill/outline through the stlt tables and parent chain. */
  styleLookup(styleId, which) {
    const seen = new Set();
    let id = styleId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const s = this.styles.get(id);
      if (!s) return null;
      const ref = which === 'fill' ? s.fillRef : s.outlineRef;
      if (ref) {
        const target = (which === 'fill' ? this.styleFillRefs : this.styleOutlineRefs).get(ref);
        if (target !== undefined) return target;
      }
      id = s._parent;
    }
    return null;
  }

  // ---- objects ------------------------------------------------------------

  /** Decode a loda/lobj record into its typed arguments. */
  readLoda(data) {
    const r = new Reader(data);
    const length = Math.min(r.u32(), data.length);
    let numArgs = r.u32();
    const argsStart = r.u32();
    const typesStart = r.u32();
    const kindCode = r.u32();
    if (argsStart >= length || typesStart >= length) throw new FormatError('loda argument table out of range');
    numArgs = Math.min(numArgs, Math.floor((length - argsStart) / 4));
    const offsets = [];
    r.seek(argsStart);
    for (let i = 0; i < numArgs; i++) offsets.push(r.u32());
    // Observed: the type table is stored in reverse order relative to the offsets.
    const types = new Array(numArgs);
    r.seek(typesStart);
    for (let i = numArgs - 1; i >= 0; i--) types[i] = r.u32();

    const v = this.version;
    const kinds = v >= 400
      ? { 1: 'rectangle', 2: 'ellipse', 3: 'curve', 4: 'artistic-text', 5: 'bitmap', 6: 'paragraph-text', 0x14: 'polygon', 0x25: 'path', 0x26: 'spline' }
      : { 0: 'rectangle', 1: 'ellipse', 2: 'curve', 3: 'artistic-text', 4: 'bitmap', 5: 'paragraph-text' };
    const out = { kindCode, kind: kinds[kindCode] ?? null, args: [] };
    for (let i = 0; i < numArgs; i++) {
      const start = offsets[i];
      if (start >= length) continue;
      const ar = new Reader(data, start, length);
      const type = types[i];
      out.args.push({ type, offset: start });
      try {
        switch (type) {
          case ARG.GEOMETRY:
            out.geometry = this.readGeometry(out.kind, ar);
            break;
          case ARG.FILL:
            if (v >= 400) out.fillId = ar.u32();
            break;
          case ARG.OUTLINE:
            if (v >= 400) out.outlineId = ar.u32();
            break;
          case ARG.STYLE:
            out.styleId = this.unsigned(ar);
            break;
          case ARG.LENS:
            out.lens = this.readLens(ar);
            break;
          case ARG.POLYGON:
            out.polygon = this.readPolygonTransform(ar);
            break;
          case ARG.PAGE_SIZE:
            out.pageSize = { width: this.coord(ar), height: this.coord(ar) };
            break;
          case ARG.NAME:
            out.name = v >= 1200 ? decodeUtf16z(data.subarray(start, length)) : decodeLatin1z(data.subarray(start, length));
            break;
          default:
            break;
        }
      } catch (err) {
        this.warn(`loda argument 0x${type.toString(16)} of ${out.kind ?? 'object'}: ${err.message}`);
      }
    }
    return out;
  }

  readGeometry(kind, r) {
    switch (kind) {
      case 'rectangle': return this.readRectangle(r);
      case 'ellipse': return this.readEllipse(r);
      case 'curve': case 'polygon': return this.readPoints(r, false);
      case 'path': return this.readPoints(r, true);
      case 'artistic-text': case 'paragraph-text': case 'bitmap': case 'spline':
        return { unsupported: kind };
      default:
        return null;
    }
  }

  readRectangle(r) {
    const v = this.version;
    let w, h, sx = 1, sy = 1, corner = 0;
    let radii = [0, 0, 0, 0]; // at corners (0,0), (0,h), (w,h), (w,0)
    if (v < 1500) {
      w = this.coord(r);
      h = this.coord(r);
      const r3 = this.coord(r);
      const r2 = v < 900 ? r3 : this.coord(r);
      const r1 = v < 900 ? r3 : this.coord(r);
      const r0 = v < 900 ? r3 : this.coord(r);
      radii = [r0, r1, r2, r3];
    } else {
      w = this.dcoord(r);
      h = this.dcoord(r);
      const a = r.f64(), b = r.f64();
      if (Math.abs(a) > 1e-9) sx = a;
      if (Math.abs(b) > 1e-9) sy = b;
      const relative = r.u8() === 0;
      r.skip(7);
      const read = () => (relative ? r.f64() : this.dcoord(r));
      const r3 = read();
      corner = r.u8();
      r.skip(15);
      const r2 = read();
      r.skip(16);
      const r1 = read();
      r.skip(16);
      const r0 = read();
      radii = [r0, r1, r2, r3];
      if (relative) {
        const m = Math.min(Math.abs((w * sx) / 2), Math.abs((h * sy) / 2));
        radii = radii.map((x) => x * m);
      }
    }
    return { type: 'rectangle', width: w, height: h, scaleX: sx, scaleY: sy, cornerType: ['round', 'scallop', 'chamfer'][corner] ?? 'round', radii };
  }

  readEllipse(r) {
    const w = this.coord(r);
    const h = this.coord(r);
    const a0 = this.angle(r);
    const a1 = this.angle(r);
    const pie = this.unsigned(r) !== 0;
    return { type: 'ellipse', width: w, height: h, startAngle: a0, endAngle: a1, pie };
  }

  readPoints(r, isPath) {
    let count;
    if (isPath) {
      r.skip(4);
      count = r.u16() + r.u16();
      r.skip(16);
    } else {
      count = r.u16();
      r.skip(2);
    }
    const pointSize = (this.precision === 16 ? 4 : 8) + 1;
    count = Math.min(count, Math.floor(r.remaining / pointSize));
    const points = [];
    for (let i = 0; i < count; i++) points.push([this.coord(r), this.coord(r)]);
    const nodeTypes = [];
    for (let i = 0; i < count; i++) nodeTypes.push(r.u8());
    return { type: 'points', points, nodeTypes };
  }

  readPolygonTransform(r) {
    const v = this.version;
    if (v < 1300) r.skip(4);
    const sides = r.u32();
    let step = r.u32();
    if (step <= 1) step = r.u32();
    else r.skip(4);
    if (v >= 1300) r.skip(4);
    const rx = r.f64(), ry = r.f64();
    const cx = this.coord(r), cy = this.coord(r);
    return { sides, step, rx, ry, cx, cy };
  }

  /**
   * Lens / transparency argument (0x1f40). Observed layout (X5):
   *   u32 0x514, u32 length, u8, u32 id, u8 lensType, ...
   * One sample (lens type 3) renders as an inverting lens in CorelDRAW's own
   * thumbnail, so type 3 is mapped to "invert". Other types are reported raw.
   */
  readLens(r) {
    const start = r.pos;
    const v = this.version;
    const raw = r.bytesView(Math.min(r.remaining, 160));
    const lr = new Reader(raw);
    if (v >= 1300) {
      lr.skip(13);
      const type = lr.u8();
      const opacity = lr.u16() / 1000;
      return { type: { 3: 'invert' }[type] ?? `lens-${type}`, typeCode: type, opacity, raw: toHex(raw, 48), _start: start };
    }
    lr.skip(10);
    return { type: 'transparency', opacity: lr.u16() / 1000, raw: toHex(raw, 48) };
  }

  readTransform(data) {
    const r = new Reader(data);
    const v = this.version;
    const length = Math.min(r.u32(), data.length);
    let n = r.u32();
    const argsStart = r.u32();
    if (argsStart >= length) return IDENTITY;
    n = Math.min(n, Math.floor((length - argsStart) / 4));
    const offsets = [];
    r.seek(argsStart);
    for (let i = 0; i < n; i++) offsets.push(r.u32());
    let m = IDENTITY;
    for (const off of offsets) {
      if (off >= length) continue;
      const ar = new Reader(data, off, length);
      if (v >= 1300) ar.skip(8);
      if (ar.u16() !== 0x08) continue; // 0x10 = envelope/perspective style distortions (not decoded)
      let t;
      if (v >= 500) {
        if (v >= 600) ar.skip(6);
        const a = ar.f64(), b = ar.f64(), c = this.dcoord(ar), d = ar.f64(), e = ar.f64(), f = this.dcoord(ar);
        t = [a, b, c, d, e, f];
      } else {
        const fx = () => ar.s32() / 65536;
        const a = fx(), b = fx(), c = ar.s32() * 0.0254, d = fx(), e = fx(), f = ar.s32() * 0.0254;
        t = [a, b, c, d, e, f];
      }
      m = then(m, t);
    }
    return m;
  }

  buildObject(chunk) {
    const obj = { kind: 'unknown', id: null, transform: IDENTITY, path: null, fill: null, outline: null, lens: null, bbox: null };
    let loda = null;
    const visit = (c) => {
      if (c.type === 'obj ' && c !== chunk) return; // nested objects are handled by the caller
      switch (c.id) {
        case 'usdn': obj.id = this.u32Of(c); break;
        case 'bbox': {
          const r = new Reader(this.payload(c));
          if (r.remaining >= (this.precision === 16 ? 8 : 16)) {
            const x0 = this.coord(r), y0 = this.coord(r), x1 = this.coord(r), y1 = this.coord(r);
            obj.bbox = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
          }
          break;
        }
        case 'loda': case 'lobj':
          loda = this.readLoda(this.payload(c));
          break;
        case 'trfd':
          obj.transform = this.readTransform(this.payload(c));
          break;
        default:
          break;
      }
      for (const k of c.children) visit(k);
    };
    for (const c of chunk.children) visit(c);
    if (!loda) return null;

    obj.kind = loda.kind ?? `unknown-0x${loda.kindCode.toString(16)}`;
    obj.geometry = loda.geometry ?? null;
    obj.styleId = loda.styleId ? hexId(loda.styleId) : null;
    obj.lens = loda.lens ?? null;

    const fillId = loda.fillId ?? (loda.styleId ? this.styleLookup(loda.styleId, 'fill') : null);
    const outlineId = loda.outlineId ?? (loda.styleId ? this.styleLookup(loda.styleId, 'outline') : null);
    obj.fill = fillId ? this.fills.get(fillId) ?? { id: hexId(fillId), type: 'missing' } : null;
    obj.outline = outlineId ? this.outlines.get(outlineId) ?? null : null;
    obj.fillSource = loda.fillId ? 'object' : fillId ? 'style' : null;
    obj.outlineSource = loda.outlineId ? 'object' : outlineId ? 'style' : null;

    const local = buildLocalPath(obj.geometry, loda.polygon, this.warn);
    if (local) obj.path = transformPath(local, obj.transform);
    else if (obj.geometry?.unsupported) this.warn(`${obj.geometry.unsupported} objects are not rendered yet`);
    return obj;
  }
}

// ---- local geometry -> path ------------------------------------------------

function buildLocalPath(g, polygon, warn) {
  if (!g) return null;
  switch (g.type) {
    case 'rectangle': return rectanglePath(g);
    case 'ellipse': return ellipsePath(g);
    case 'points': {
      const p = nodesToPath(g.points, g.nodeTypes);
      return polygon ? polygonPath(p, polygon, warn) : p;
    }
    default:
      return null;
  }
}

function rectanglePath({ width: w, height: h, scaleX: sx, scaleY: sy, cornerType, radii }) {
  // Corners in drawing order: (0,0) -> (0,h) -> (w,h) -> (w,0). Radii are
  // stored pre-scale, so they are divided by the object's scale factors.
  const corners = [[0, 0], [0, h], [w, h], [w, 0]];
  const path = [];
  const K = 0.5522847498;
  for (let i = 0; i < 4; i++) {
    const [cx, cy] = corners[i];
    const [px, py] = corners[(i + 3) % 4];
    const [nx, ny] = corners[(i + 1) % 4];
    const rad = Math.max(0, radii[i] || 0);
    const inX = rad / Math.abs(sx), inY = rad / Math.abs(sy);
    // entry point (coming from previous corner) and exit point (towards next)
    const toward = (ax, ay, bx, by) => [ax === bx ? ax : ax + Math.sign(bx - ax) * inX, ay === by ? ay : ay + Math.sign(by - ay) * inY];
    const [ex, ey] = rad ? toward(cx, cy, px, py) : [cx, cy];
    const [xx, xy] = rad ? toward(cx, cy, nx, ny) : [cx, cy];
    path.push({ op: i === 0 ? 'M' : 'L', x: ex, y: ey });
    if (rad) {
      if (cornerType === 'chamfer') path.push({ op: 'L', x: xx, y: xy });
      else if (cornerType === 'scallop') {
        // concave corner: control points pulled toward the rectangle interior
        const ix = cx + (ex !== cx ? ex - cx : xx - cx), iy = cy + (ey !== cy ? ey - cy : xy - cy);
        path.push({ op: 'C', x1: ex + (ix - ex) * K, y1: ey + (iy - ey) * K, x2: xx + (ix - xx) * K, y2: xy + (iy - xy) * K, x: xx, y: xy });
      } else {
        path.push({ op: 'C', x1: ex + (cx - ex) * K, y1: ey + (cy - ey) * K, x2: xx + (cx - xx) * K, y2: xy + (cy - xy) * K, x: xx, y: xy });
      }
    }
  }
  path.push({ op: 'Z' });
  return path;
}

function ellipsePath({ width, height, startAngle, endAngle, pie }) {
  const cx = width / 2, cy = height / 2, rx = Math.abs(cx), ry = Math.abs(cy);
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let a0 = norm(startAngle), a1 = norm(endAngle);
  // Points are at (cx + rx cos a, cy - ry sin a): stored angles run clockwise
  // in the y-up drawing space, i.e. the parameter is t = -a.
  if (Math.abs(a0 - a1) < 1e-9) {
    const segs = arcToCubics(cx, cy, rx, ry, -a0, -a0 - 2 * Math.PI);
    const p0 = [cx + rx * Math.cos(-a0), cy + ry * Math.sin(-a0)];
    return [{ op: 'M', x: p0[0], y: p0[1] }, ...segs, { op: 'Z' }];
  }
  if (a1 < a0) a1 += 2 * Math.PI;
  const p0 = [cx + rx * Math.cos(-a0), cy + ry * Math.sin(-a0)];
  const path = [{ op: 'M', x: p0[0], y: p0[1] }, ...arcToCubics(cx, cy, rx, ry, -a0, -a1)];
  if (pie) path.push({ op: 'L', x: cx, y: cy }, { op: 'Z' });
  return path;
}

/**
 * Node type bits (one byte per point):
 *   0x40 | 0x80 both clear -> move-to;   0x40 only -> line-to;
 *   0x80 only -> curve end point;        both set  -> Bézier control point;
 *   0x08 -> the subpath closes at this node.
 */
export function nodesToPath(points, types) {
  const path = [];
  let controls = [];
  let open = false;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const t = types[i] ?? 0;
    const closes = (t & 0x08) !== 0;
    const seg = t & 0xc0;
    if (seg === 0x00) {
      if (open && closes) path.push({ op: 'Z' });
      path.push({ op: 'M', x, y });
      open = true;
      controls = [];
      continue;
    }
    if (seg === 0xc0) {
      controls.push([x, y]);
      continue;
    }
    if (seg === 0x80 && controls.length >= 2) {
      path.push({ op: 'C', x1: controls[0][0], y1: controls[0][1], x2: controls[1][0], y2: controls[1][1], x, y });
    } else {
      path.push({ op: 'L', x, y });
    }
    controls = [];
    if (closes) path.push({ op: 'Z' });
  }
  return path;
}

function polygonPath(base, { sides, step, rx, ry, cx, cy }, warn) {
  if (!sides || !base.length) return base;
  warn('polygon/star reconstruction is unverified (no sample file yet)');
  const unit = (2 * Math.PI) / sides;
  const asContinuation = (p) => p.map((c, i) => (i === 0 && c.op === 'M' ? { op: 'L', x: c.x, y: c.y } : c)).filter((c) => c.op !== 'Z');
  const rot = (k) => rotation(-k * unit);
  const parts = [];
  const open = base.filter((c) => c.op !== 'Z');
  if (step && sides % step) {
    for (let i = 0; i < sides; i++) parts.push(i === 0 ? open : asContinuation(transformPath(open, rot(i * step))));
    parts.push([{ op: 'Z' }]);
  } else {
    const s = step || 1;
    for (let i = 0; i < s; i++) {
      for (let j = 0; j < sides / s; j++) {
        const p = transformPath(open, rot(i + j * s));
        parts.push(j === 0 ? p : asContinuation(p));
      }
      parts.push([{ op: 'Z' }]);
    }
  }
  return transformPath(parts.flat(), [rx, 0, cx, 0, ry, cy]);
}

// ---- small helpers ----------------------------------------------------------

function decodeUtf16z(bytes) {
  let end = 0;
  while (end + 1 < bytes.length && (bytes[end] || bytes[end + 1])) end += 2;
  return new TextDecoder('utf-16le').decode(bytes.subarray(0, end));
}

function decodeLatin1z(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return new TextDecoder('latin1').decode(bytes.subarray(0, end));
}

function parseMetadata(xml) {
  if (!xml) return null;
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1] : null;
  };
  const out = {};
  for (const tag of ['ProductName', 'AppVersion', 'BuildNumber', 'CoreVersion', 'Author', 'LastAuthor', 'Title', 'NumPages', 'NumLayers', 'PageDimensions', 'PageSizeName', 'DocID', 'Locale']) {
    const v = pick(tag);
    if (v !== null && v !== '') out[tag] = v;
  }
  const fonts = xml.match(/<FontsUsed>([\s\S]*?)<\/FontsUsed>/);
  if (fonts) out.FontsUsed = [...fonts[1].matchAll(/<rdf:li>([^<]*)<\/rdf:li>/g)].map((m) => m[1]);
  return out;
}

