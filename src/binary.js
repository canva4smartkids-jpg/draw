// Little-endian cursor over a Uint8Array with bounds checking.
// Every read throws a FormatError instead of returning garbage, so a
// truncated or hostile file fails loudly rather than producing nonsense.

export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

export class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.start = offset;
    this.pos = offset;
    this.end = end;
  }

  get remaining() {
    return this.end - this.pos;
  }

  /** Offset relative to the start of this reader's window. */
  tell() {
    return this.pos - this.start;
  }

  /** Seek relative to the start of this reader's window. */
  seek(offset) {
    const target = this.start + offset;
    if (target < this.start || target > this.end) {
      throw new FormatError(`seek to ${offset} outside window of ${this.end - this.start} bytes`);
    }
    this.pos = target;
    return this;
  }

  skip(n) {
    this.need(n);
    this.pos += n;
    return this;
  }

  need(n) {
    if (n < 0 || this.pos + n > this.end) {
      throw new FormatError(`need ${n} bytes at ${this.tell()}, only ${this.remaining} left`);
    }
  }

  u8() { this.need(1); return this.view.getUint8(this.pos++); }
  s8() { this.need(1); return this.view.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  s16() { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  s32() { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  fourcc() {
    this.need(4);
    const b = this.bytes;
    const p = this.pos;
    this.pos += 4;
    return String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  }

  bytesView(n) {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function fourccAt(bytes, offset) {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function toHex(bytes, max = 32) {
  const n = Math.min(bytes.length, max);
  let s = '';
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0');
  return bytes.length > max ? s + '…' : s;
}
