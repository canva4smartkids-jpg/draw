// RIFF chunk tree reader with the two CorelDRAW-specific twists found while
// dissecting real files:
//
//  1. LIST 'cmpr' holds a zlib-compressed record stream followed by a
//     zlib-compressed table of u32 block lengths. Inside that stream a
//     record's size field is an *index* into the block-length table.
//  2. Records are not reliably padded to even sizes; zero bytes between
//     records are filler and are skipped.
//
// Version >= 7 files also store the style table as LIST 'stlt' whose body is
// a flat binary structure, not sub-chunks, so it is kept as a leaf.

import { Reader, FormatError, fourccAt, byteAt, inflate } from '@draw/archive';

const MAX_DEPTH = 64;

export interface Chunk {
  /** FourCC ('RIFF', 'LIST' or a leaf id such as 'loda') */
  readonly id: string;
  /** list type for RIFF/LIST chunks ('doc ', 'page', 'obj ', …) */
  readonly type?: string;
  /** body size in bytes */
  readonly size: number;
  /** offset of the header within its containing stream */
  readonly offset: number;
  /** true if the chunk was read from a cmpr stream */
  readonly compressed: boolean;
  /** body bytes (for lists: everything after the list type) */
  readonly data: Uint8Array;
  readonly children: readonly Chunk[];
}

export interface ParseRiffOptions {
  readonly maxInflate?: number;
}

interface ParseContext {
  readonly maxInflate: number;
}

/** Parse a CorelDRAW RIFF stream into a chunk tree. */
export async function parseRiff(bytes: Uint8Array, options: ParseRiffOptions = {}): Promise<Chunk> {
  if (fourccAt(bytes, 0) !== 'RIFF') throw new FormatError('not a RIFF stream');
  const ctx: ParseContext = { maxInflate: options.maxInflate ?? 256 * 1024 * 1024 };
  const roots = await readRecords(bytes, 0, bytes.length, null, false, 0, ctx);
  const root = roots[0];
  if (!root) throw new FormatError('empty RIFF stream');
  return root;
}

async function readRecords(
  bytes: Uint8Array,
  start: number,
  end: number,
  blockLengths: readonly number[] | null,
  compressed: boolean,
  depth: number,
  ctx: ParseContext,
): Promise<Chunk[]> {
  if (depth > MAX_DEPTH) throw new FormatError('chunk nesting too deep');
  const out: Chunk[] = [];
  let pos = start;
  while (pos < end) {
    while (pos < end && byteAt(bytes, pos) === 0) pos++; // filler between records
    if (pos + 8 > end) break;
    const r = new Reader(bytes, pos, end);
    const id = r.fourcc();
    let size = r.u32();
    if (blockLengths && size < blockLengths.length) size = blockLengths[size] ?? size;
    const bodyStart = pos + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > end) throw new FormatError(`chunk '${id}' at ${pos} overruns its parent (${size} bytes)`);

    if ((id === 'RIFF' || id === 'LIST') && size >= 4) {
      const type = fourccAt(bytes, bodyStart);
      let children: Chunk[] = [];
      if (type === 'cmpr') {
        children = await readCompressed(bytes, bodyStart + 4, bodyEnd, depth, ctx);
      } else if (type !== 'stlt') {
        children = await readRecords(bytes, bodyStart + 4, bodyEnd, blockLengths, compressed, depth + 1, ctx);
      }
      out.push({ id, size, offset: pos, compressed, data: bytes.subarray(bodyStart + 4, bodyEnd), children, type });
    } else {
      out.push({ id, size, offset: pos, compressed, data: bytes.subarray(bodyStart, bodyEnd), children: [] });
    }
    pos = bodyEnd;
  }
  return out;
}

// cmpr body layout (after the 'cmpr' list type):
//   u32 compressedSize      bytes of the first CPng block (incl. its 8-byte header)
//   u32 uncompressedSize
//   u32 blocksCompressedSize
//   u32 blocksUncompressedSize
//   'CPng' u16=1 u16=4 <zlib stream>           (compressedSize bytes)
//   'CPng' u16=1 u16=4 <zlib stream of u32[]>  (the rest of the list)
async function readCompressed(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
  ctx: ParseContext,
): Promise<Chunk[]> {
  const r = new Reader(bytes, start, end);
  const compressedSize = r.u32();
  const uncompressedSize = r.u32();
  r.skip(8);
  const streamStart = start + 16;
  if (streamStart + compressedSize > end) throw new FormatError('cmpr payload overruns its list');

  const payload = await inflateCPng(bytes, streamStart, streamStart + compressedSize, ctx);
  const tableBytes = await inflateCPng(bytes, streamStart + compressedSize, end, ctx);
  const blockLengths: number[] = [];
  const tv = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
  for (let i = 0; i + 4 <= tableBytes.length; i += 4) blockLengths.push(tv.getUint32(i, true));

  if (uncompressedSize && payload.length !== uncompressedSize) {
    throw new FormatError(`cmpr declared ${uncompressedSize} bytes but inflated to ${payload.length}`);
  }
  return readRecords(payload, 0, payload.length, blockLengths, true, depth + 1, ctx);
}

async function inflateCPng(bytes: Uint8Array, start: number, end: number, ctx: ParseContext): Promise<Uint8Array> {
  if (end - start < 8) return new Uint8Array(0);
  if (fourccAt(bytes, start) !== 'CPng') throw new FormatError(`expected CPng block at ${start}`);
  const r = new Reader(bytes, start + 4, end);
  const a = r.u16();
  const b = r.u16();
  if (a !== 1 || b !== 4) throw new FormatError(`unexpected CPng header ${a}/${b}`);
  return inflate(bytes.subarray(start + 8, end), 'deflate', ctx.maxInflate);
}

export interface WalkEntry {
  readonly chunk: Chunk;
  readonly depth: number;
  readonly parents: readonly Chunk[];
}

/** Depth-first iteration over a chunk tree. */
export function* walk(chunk: Chunk, depth = 0, parents: readonly Chunk[] = []): Generator<WalkEntry> {
  yield { chunk, depth, parents };
  for (const c of chunk.children) yield* walk(c, depth + 1, [...parents, chunk]);
}

/** Human-readable dump of the tree, one chunk per line. */
export function formatTree(root: Chunk, { hex = 0 }: { readonly hex?: number } = {}): string {
  const lines: string[] = [];
  for (const { chunk, depth } of walk(root)) {
    const pad = '  '.repeat(depth);
    if (chunk.type) {
      lines.push(`${pad}${chunk.id} '${chunk.type}' ${chunk.size}${chunk.compressed ? ' (cmpr)' : ''}`);
    } else {
      let line = `${pad}${chunk.id} ${chunk.size}`;
      if (hex) {
        let s = '';
        for (let i = 0; i < Math.min(hex, chunk.data.length); i++)
          s += byteAt(chunk.data, i).toString(16).padStart(2, '0');
        line += ` ${s}${chunk.data.length > hex ? '…' : ''}`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}
