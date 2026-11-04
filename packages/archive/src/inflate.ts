// Decompression via the Web Streams DecompressionStream, which exists both in
// browsers and in Node.js >= 18, so the code runs unchanged in either place.

import { FormatError } from './binary.ts';

export type InflateFormat = 'deflate' | 'deflate-raw';

/**
 * @param bytes      compressed input
 * @param format     'deflate' = zlib-wrapped stream, 'deflate-raw' = bare DEFLATE
 * @param maxOutput  refuse to inflate past this many bytes (zip-bomb guard)
 */
export async function inflate(
  bytes: Uint8Array,
  format: InflateFormat,
  maxOutput = 512 * 1024 * 1024,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new FormatError('DecompressionStream is not available in this runtime');
  }
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // Swallow write-side rejections; the read side reports the same error.
  writer.write(asArrayBufferView(bytes)).catch(() => undefined);
  writer.close().catch(() => undefined);

  const reader = ds.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxOutput) {
        await reader.cancel().catch(() => undefined);
        throw new FormatError(`inflated data exceeds ${maxOutput} bytes`);
      }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof FormatError) throw err;
    // Corel writes zlib streams that end exactly at the declared size, but be
    // tolerant of trailing bytes: keep what was produced before the error.
    if (total === 0) throw new FormatError(`${format} stream is corrupt: ${errorMessage(err)}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Web Streams want a view over a plain ArrayBuffer; copy only if the input is shared. */
function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
  return new Uint8Array(bytes);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
