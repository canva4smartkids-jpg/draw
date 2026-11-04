// Render the document model produced by readCdr() as SVG.
//
// CorelDRAW's drawing space has its origin at the page centre with the y axis
// pointing up; SVG's origin is the top-left corner with y pointing down.

import { transformPath, toSvgPathData, pathBounds } from './path.js';
import { rgbHex } from './color.js';

const HAIRLINE_MM = 0.1;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const n = (v) => String(Math.round(v * 1000) / 1000);

/**
 * @param {object} doc     result of readCdr()
 * @param {{ page?: number, includeMasterLayers?: boolean, placeholders?: boolean }} [options]
 */
export function toSvg(doc, options = {}) {
  const pages = doc.pages.filter((p) => !p.master);
  const page = pages[options.page ?? 0] ?? pages[0] ?? doc.pages[0];
  if (!page) throw new Error('document has no pages');
  const W = page.width, H = page.height;
  const toPage = [1, 0, W / 2, 0, -1, H / 2];
  const defs = [];
  const body = [];
  let gradientId = 0;

  const renderObject = (obj, out) => {
    if (obj.kind === 'group') {
      const inner = [];
      for (const c of [...obj.children].reverse()) renderObject(c, inner);
      if (inner.length) out.push(`<g data-cdr-container="${esc(obj.container)}">`, ...inner, '</g>');
      return;
    }
    if (!obj.path) {
      if (options.placeholders && obj.bbox) {
        const b = obj.bbox;
        out.push(`<rect class="cdr-placeholder" data-kind="${esc(obj.kind)}" x="${n(b.x0 + W / 2)}" y="${n(H / 2 - b.y1)}" width="${n(b.x1 - b.x0)}" height="${n(b.y1 - b.y0)}" fill="none" stroke="#999" stroke-width="0.2" stroke-dasharray="1 1"/>`);
      }
      return;
    }
    const path = transformPath(obj.path, toPage);
    const attrs = [`d="${toSvgPathData(path)}"`];
    if (obj.id !== null && obj.id !== undefined) attrs.push(`data-cdr-id="${obj.id}"`);
    attrs.push(`data-kind="${esc(obj.kind)}"`);

    // fill
    let fill = 'none';
    const f = obj.fill;
    if (f?.type === 'solid') fill = rgbHex(f.color.rgb);
    else if (f?.type === 'gradient' && f.gradient.stops.length) {
      const id = `g${gradientId++}`;
      defs.push(gradientDef(id, f.gradient, pathBounds(path)));
      fill = `url(#${id})`;
    } else if (f && f.type !== 'none') {
      fill = '#c0c0c0';
      attrs.push(`data-cdr-fill="${esc(f.type)}"`);
    }

    // outline
    const stroke = [];
    const o = obj.outline;
    if (o && !o.none) {
      let width = o.width > 0 ? o.width * o.stretch : HAIRLINE_MM;
      if (o.scaleWithObject) width *= Math.sqrt(Math.abs(obj.transform[0] * obj.transform[4] - obj.transform[1] * obj.transform[3]));
      stroke.push(`stroke="${rgbHex(o.color.rgb)}"`, `stroke-width="${n(width)}"`);
      if (o.caps !== 'butt') stroke.push(`stroke-linecap="${o.caps}"`);
      if (o.join !== 'miter') stroke.push(`stroke-linejoin="${o.join}"`);
      if (o.dashed) stroke.push(`stroke-dasharray="${o.dashes.map((d) => n(Math.max(d, 0.01) * width)).join(' ')}"`);
    }

    // An inverting lens is "difference" blending with white over everything
    // below it (paper included). Its outline is drawn normally on top, which
    // is how CorelDRAW's own preview shows it.
    if (obj.lens?.type === 'invert') {
      out.push(`<path ${attrs.join(' ')} data-cdr-lens="invert" fill="#ffffff" style="mix-blend-mode:difference"/>`);
      if (stroke.length) out.push(`<path d="${toSvgPathData(path)}" fill="none" ${stroke.join(' ')}/>`);
      return;
    }
    if (obj.lens) attrs.push(`data-cdr-lens="${esc(obj.lens.type)}"`);
    out.push(`<path ${attrs.join(' ')} fill="${fill}"${stroke.length ? ' ' + stroke.join(' ') : ''}/>`);
  };

  // CDR stores layers and objects top-most first; SVG paints in document
  // order, so both are emitted in reverse.
  for (const layer of [...page.layers].reverse()) {
    if (layer.master && !options.includeMasterLayers) continue;
    const inner = [];
    for (const obj of [...layer.objects].reverse()) renderObject(obj, inner);
    if (!inner.length) continue;
    const label = layer.name ? ` data-layer="${esc(layer.name)}"` : '';
    body.push(`<g${label}>`, ...inner, '</g>');
  }

  const title = doc.metadata?.Title || `${doc.format.product} drawing`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}mm" height="${n(H)}mm" viewBox="0 0 ${n(W)} ${n(H)}">`,
    `<title>${esc(title)}</title>`,
    `<desc>Converted from ${esc(doc.format.product)} (version ${doc.format.version}) by draw-cdr</desc>`,
    defs.length ? `<defs>${defs.join('')}</defs>` : '',
    // Paper and artwork share one isolated group so blend-mode lenses see the paper.
    '<g style="isolation:isolate">',
    `<rect data-cdr-paper="1" width="${n(W)}" height="${n(H)}" fill="#ffffff"/>`,
    ...body,
    '</g>',
    '</svg>',
    '',
  ].filter(Boolean).join('\n');
}

function gradientDef(id, g, b) {
  const stops = [...g.stops]
    .sort((a, b2) => a.offset - b2.offset)
    .map((s) => `<stop offset="${n(s.offset)}" stop-color="${rgbHex(s.color.rgb)}"/>`)
    .join('');
  if (!b) b = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (g.kind === 'linear') {
    // Angle is counter-clockwise in CorelDRAW's y-up space; SVG y points down.
    const dx = Math.cos(g.angle), dy = -Math.sin(g.angle);
    const half = (Math.abs(dx * w) + Math.abs(dy * h)) / 2;
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(cx - dx * half)}" y1="${n(cy - dy * half)}" x2="${n(cx + dx * half)}" y2="${n(cy + dy * half)}">${stops}</linearGradient>`;
  }
  // radial / conical / square approximated as radial around the offset centre
  const ox = cx + ((g.centerX ?? 0) / 100) * (w / 2);
  const oy = cy - ((g.centerY ?? 0) / 100) * (h / 2);
  const r = Math.hypot(w, h) / 2;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(ox)}" cy="${n(oy)}" r="${n(r)}">${stops}</radialGradient>`;
}
