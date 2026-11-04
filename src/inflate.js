// Decompression via the Web Streams DecompressionStream, which exists both in
// browsers and in Node.js >= 18, so the parser runs unchanged in either place.

import { FormatError } from './binary.js';

/**
 * @param {Uint8Array} bytes
 * @param {'deflate' | 'deflate-raw'} format  'deflate' = zlib-wrapped stream, 'deflate-raw' = bare DEFLATE
 * @param {number} [maxOutput] refuse to inflate past this many bytes (zip-bomb guard)
 * @returns {Promise<Uint8Array>}
 */
export async function inflate(bytes, format, maxOutput = 512 * 1024 * 1024) {
  if (typeof DecompressionStream !== 'function') {
    throw new FormatError('DecompressionStream is not available in this runtime');
  }
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // Swallow write-side rejections; the read side reports the same error.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});

  const reader = ds.readable.getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOutput) {
        await reader.cancel().catch(() => {});
        throw new FormatError(`inflated data exceeds ${maxOutput} bytes`);
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof FormatError) throw err;
    // Corel writes zlib streams that end exactly at the declared size, but be
    // tolerant of trailing bytes: keep what was produced before the error.
    if (total === 0) throw new FormatError(`${format} stream is corrupt: ${err.message}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
