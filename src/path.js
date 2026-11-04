// Path and affine-matrix helpers. Paths are arrays of commands:
//   { op: 'M'|'L', x, y }
//   { op: 'C', x1, y1, x2, y2, x, y }
//   { op: 'Q', x1, y1, x, y }
//   { op: 'Z' }
// Arcs are converted to cubic Béziers up front, so every path survives an
// arbitrary affine transform exactly.

/** Matrix [a, b, c, d, e, f] maps (x, y) -> (a*x + b*y + c, d*x + e*y + f). */
export const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0]);

export function apply(m, x, y) {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

/** Returns the matrix for "apply `first`, then `second`". */
export function then(first, second) {
  const [a1, b1, c1, d1, e1, f1] = first;
  const [a2, b2, c2, d2, e2, f2] = second;
  return [
    a2 * a1 + b2 * d1,
    a2 * b1 + b2 * e1,
    a2 * c1 + b2 * f1 + c2,
    d2 * a1 + e2 * d1,
    d2 * b1 + e2 * e1,
    d2 * c1 + e2 * f1 + f2,
  ];
}

export function rotation(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, -s, 0, s, c, 0];
}

/** Geometric mean scale of a matrix, used to scale stroke widths. */
export function meanScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
}

export function transformPath(path, m) {
  return path.map((cmd) => {
    switch (cmd.op) {
      case 'M':
      case 'L': {
        const [x, y] = apply(m, cmd.x, cmd.y);
        return { op: cmd.op, x, y };
      }
      case 'C': {
        const [x1, y1] = apply(m, cmd.x1, cmd.y1);
        const [x2, y2] = apply(m, cmd.x2, cmd.y2);
        const [x, y] = apply(m, cmd.x, cmd.y);
        return { op: 'C', x1, y1, x2, y2, x, y };
      }
      case 'Q': {
        const [x1, y1] = apply(m, cmd.x1, cmd.y1);
        const [x, y] = apply(m, cmd.x, cmd.y);
        return { op: 'Q', x1, y1, x, y };
      }
      default:
        return { op: 'Z' };
    }
  });
}

/**
 * Elliptical arc on an axis-aligned ellipse centred at (cx, cy), from angle
 * a0 to a1 (radians, counter-clockwise, y axis pointing up), as cubic
 * Béziers. Each segment spans at most 90 degrees.
 */
export function arcToCubics(cx, cy, rx, ry, a0, a1) {
  const out = [];
  const total = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2) - 1e-9));
  const step = total / n;
  const k = (4 / 3) * Math.tan(step / 4);
  let t = a0;
  for (let i = 0; i < n; i++) {
    const t2 = t + step;
    const c1 = Math.cos(t), s1 = Math.sin(t), c2 = Math.cos(t2), s2 = Math.sin(t2);
    out.push({
      op: 'C',
      x1: cx + rx * (c1 - k * s1), y1: cy + ry * (s1 + k * c1),
      x2: cx + rx * (c2 + k * s2), y2: cy + ry * (s2 - k * c2),
      x: cx + rx * c2, y: cy + ry * s2,
    });
    t = t2;
  }
  return out;
}

export function pathBounds(path) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  for (const c of path) {
    if (c.op === 'Z') continue;
    add(c.x, c.y);
    if (c.op === 'C') { add(c.x1, c.y1); add(c.x2, c.y2); }
    if (c.op === 'Q') add(c.x1, c.y1);
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

export function toSvgPathData(path) {
  return path
    .map((c) => {
      switch (c.op) {
        case 'M': return `M${num(c.x)} ${num(c.y)}`;
        case 'L': return `L${num(c.x)} ${num(c.y)}`;
        case 'C': return `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
        case 'Q': return `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
        default: return 'Z';
      }
    })
    .join('');
}
