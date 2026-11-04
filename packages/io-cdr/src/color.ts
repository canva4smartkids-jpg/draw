// CorelDRAW color records -> sRGB.
//
// A color is stored as (model u16, palette u16, 4 reserved bytes, value u32)
// in version 5+ files; the four bytes of `value` are the channels in file
// order (c0 = lowest byte). Conversions here are device-independent
// approximations (no ICC profiles), which is adequate for previews.

export type Rgb = readonly [number, number, number];

export const ColorModel = Object.freeze({
  PANTONE_OLD: 0x00,
  CMYK100: 0x02,
  CMYK255: 0x03,
  CMY: 0x04,
  RGB: 0x05,
  HSB: 0x06,
  HLS: 0x07,
  BW: 0x08,
  GRAY: 0x09,
  YIQ: 0x0b,
  LAB_SIGNED: 0x0c,
  CMYK255_ALT: 0x11,
  LAB: 0x12,
  REGISTRATION: 0x14,
  CMYK100_ALT: 0x15,
  SPOT: 0x19,
});

const MODEL_NAMES: Readonly<Record<number, string>> = {
  0x00: 'pantone-legacy',
  0x01: 'cmyk100',
  0x02: 'cmyk100',
  0x03: 'cmyk255',
  0x04: 'cmy',
  0x05: 'rgb',
  0x06: 'hsb',
  0x07: 'hls',
  0x08: 'bw',
  0x09: 'gray',
  0x0b: 'yiq',
  0x0c: 'lab',
  0x11: 'cmyk255',
  0x12: 'lab',
  0x14: 'registration',
  0x15: 'cmyk100',
  0x19: 'spot',
};

export function modelName(model: number): string {
  return MODEL_NAMES[model] ?? `unknown-0x${model.toString(16)}`;
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

const rgbOf = (r: number, g: number, b: number): Rgb => [r, g, b];

function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  // c, m, y, k in 0..1
  return rgbOf(clamp255(255 * (1 - c) * (1 - k)), clamp255(255 * (1 - m) * (1 - k)), clamp255(255 * (1 - y) * (1 - k)));
}

function hsvToRgb(hue: number, s: number, v: number): Rgb {
  const h = ((hue % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return rgbOf(clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255));
}

function labToRgb(L: number, a: number, b: number): Rgb {
  // CIE L*a*b* (D50) -> XYZ -> linear sRGB (D65, Bradford-adapted) -> sRGB
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = L > k * e ? fy ** 3 : L / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const X = xr * 0.96422,
    Y = yr * 1.0,
    Z = zr * 0.82521;
  const rl = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const gl = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  const gamma = (u: number): number => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);
  const ch = (u: number): number => clamp255(gamma(Math.max(0, u)) * 255);
  return rgbOf(ch(rl), ch(gl), ch(bl));
}

export interface RgbConversion {
  readonly rgb: Rgb;
  /** false when the conversion is an approximation (CMYK, Lab, palette colors) */
  readonly exact: boolean;
}

export function toRgb(color: { readonly model: number; readonly value: number }): RgbConversion {
  const v = color.value >>> 0;
  const c0 = v & 0xff,
    c1 = (v >>> 8) & 0xff,
    c2 = (v >>> 16) & 0xff,
    c3 = (v >>> 24) & 0xff;
  switch (color.model) {
    case 0x01:
    case 0x02:
    case 0x15:
      return { rgb: cmykToRgb(c0 / 100, c1 / 100, c2 / 100, c3 / 100), exact: false };
    case 0x03:
    case 0x11:
      return { rgb: cmykToRgb(c0 / 255, c1 / 255, c2 / 255, c3 / 255), exact: false };
    case 0x04:
      return { rgb: [255 - c0, 255 - c1, 255 - c2], exact: true };
    case 0x05:
      return { rgb: [c2, c1, c0], exact: true };
    case 0x06:
      return { rgb: hsvToRgb(c0 | (c1 << 8), c2 / 255, c3 / 255), exact: true };
    case 0x07: {
      const h = c0 | (c1 << 8),
        l = c2 / 255,
        s = c3 / 255;
      const v2 = l + s * Math.min(l, 1 - l);
      return { rgb: hsvToRgb(h, v2 === 0 ? 0 : 2 * (1 - l / v2), v2), exact: true };
    }
    case 0x08:
      return { rgb: c0 ? [0, 0, 0] : [255, 255, 255], exact: true };
    case 0x09:
      return { rgb: [c0, c0, c0], exact: true };
    case 0x0c:
      return { rgb: labToRgb((c0 * 100) / 255, (c1 << 24) >> 24, (c2 << 24) >> 24), exact: false };
    case 0x12:
      return { rgb: labToRgb((c0 * 100) / 255, c1 - 0x80, c2 - 0x80), exact: false };
    case 0x14:
      return { rgb: [0, 0, 0], exact: true };
    default:
      // Spot/palette colors need Corel's palette tables; fall back to a
      // neutral gray so shapes stay visible.
      return { rgb: [128, 128, 128], exact: false };
  }
}

export function rgbHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Exported for tests.
export const _internal = { cmykToRgb, hsvToRgb, labToRgb };
