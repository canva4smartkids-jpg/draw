// Little-endian cursor over a Uint8Array with bounds checking.
// Every read throws a FormatError instead of returning garbage, so a
// truncated or hostile file fails loudly rather than producing nonsense.

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

export class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly start: number;
  readonly end: number;
  pos: number;

  constructor(bytes: Uint8Array, offset = 0, end: number = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.start = offset;
    this.pos = offset;
    this.end = end;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  /** Offset relative to the start of this reader's window. */
  tell(): number {
    return this.pos - this.start;
  }

  /** Seek relative to the start of this reader's window. */
  seek(offset: number): this {
    const target = this.start + offset;
    if (target < this.start || target > this.end) {
      throw new FormatError(`seek to ${offset} outside window of ${this.end - this.start} bytes`);
    }
    this.pos = target;
    return this;
  }

  skip(n: number): this {
    this.need(n);
    this.pos += n;
    return this;
  }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new FormatError(`need ${n} bytes at ${this.tell()}, only ${this.remaining} left`);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  s8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  s16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  s32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  fourcc(): string {
    this.need(4);
    const p = this.pos;
    this.pos += 4;
    return fourccAt(this.bytes, p);
  }

  bytesView(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Byte at `i`, or 0 past the end (callers bounds-check before decoding). */
export function byteAt(bytes: Uint8Array, i: number): number {
  return bytes[i] ?? 0;
}

export function fourccAt(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(
    byteAt(bytes, offset),
    byteAt(bytes, offset + 1),
    byteAt(bytes, offset + 2),
    byteAt(bytes, offset + 3),
  );
}

export function toHex(bytes: Uint8Array, max = 32): string {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += byteAt(bytes, i).toString(16).padStart(2, '0');
  return bytes.length > max ? s + '…' : s;
}
