// Minimal ZIP reader: enough for CorelDRAW X4+ packages (stored or deflated
// entries, no encryption, no ZIP64). Entries are read through the central
// directory, which is the authoritative listing.

import { Reader, FormatError, byteAt } from './binary.ts';
import { inflate } from './inflate.ts';

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

export interface ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  read(name: string): Promise<Uint8Array | null>;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function openZip(bytes: Uint8Array): ZipArchive {
  const r = new Reader(bytes);
  // End-of-central-directory record: 22 bytes plus an optional comment (<= 65535).
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (
      byteAt(bytes, i) === 0x50 &&
      byteAt(bytes, i + 1) === 0x4b &&
      byteAt(bytes, i + 2) === 0x05 &&
      byteAt(bytes, i + 3) === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FormatError('ZIP end-of-central-directory record not found');
  r.seek(eocd);
  if (r.u32() !== EOCD_SIG) throw new FormatError('bad EOCD signature');
  r.skip(6); // disk numbers, entries on this disk
  const count = r.u16();
  const cdSize = r.u32();
  const cdOffset = r.u32();
  if (cdOffset === 0xffffffff || count === 0xffff) throw new FormatError('ZIP64 archives are not supported');
  if (cdOffset + cdSize > bytes.length) throw new FormatError('central directory lies outside the file');

  const entries = new Map<string, ZipEntry>();
  r.seek(cdOffset);
  for (let i = 0; i < count; i++) {
    if (r.u32() !== CDIR_SIG) throw new FormatError(`bad central directory entry ${i}`);
    r.skip(4); // version made by, version needed
    const flags = r.u16();
    const method = r.u16();
    r.skip(8); // time, date, crc
    const compressedSize = r.u32();
    const size = r.u32();
    const nameLen = r.u16();
    const extraLen = r.u16();
    const commentLen = r.u16();
    r.skip(8); // disk start, internal attrs, external attrs
    const localOffset = r.u32();
    const nameBytes = r.bytesView(nameLen);
    r.skip(extraLen + commentLen);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(nameBytes);
    if (flags & 0x1) throw new FormatError(`entry ${name} is encrypted`);
    entries.set(name, { name, method, compressedSize, size, localOffset });
  }

  async function read(name: string): Promise<Uint8Array | null> {
    const e = entries.get(name);
    if (!e) return null;
    const lr = new Reader(bytes);
    lr.seek(e.localOffset);
    if (lr.u32() !== LOCAL_SIG) throw new FormatError(`bad local header for ${name}`);
    lr.skip(22);
    const nameLen = lr.u16();
    const extraLen = lr.u16();
    lr.skip(nameLen + extraLen);
    const data = lr.bytesView(e.compressedSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflate(data, 'deflate-raw', Math.max(e.size, 1) * 2 + 1024);
    throw new FormatError(`entry ${name} uses unsupported compression method ${e.method}`);
  }

  return { entries, read };
}
