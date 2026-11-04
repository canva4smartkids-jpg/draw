// Debug viewer for the CDR importer (npm run viewer). Not the application UI.

import { readCdr, toSvg, formatTree } from '@draw/io-cdr';
import type { CdrNode } from '@draw/io-cdr';

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const countObjects = (objs: readonly CdrNode[]): number =>
  objs.reduce((n, o) => n + (o.kind === 'group' ? countObjects(o.children) : 1), 0);

let lastSvg = '';
let lastName = 'drawing';

async function open(file: File): Promise<void> {
  const status = byId('status');
  status.textContent = `Reading ${file.name}…`;
  status.className = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await readCdr(bytes, { keepTree: true });
    lastSvg = toSvg(doc);
    lastName = file.name.replace(/\.[^.]+$/, '');
    byId('canvas').innerHTML = lastSvg.replace(/^<\?xml[^>]*>/, '');
    const pages = doc.pages.filter((p) => !p.master);
    const facts: Record<string, string | number> = {
      Product: doc.format.product,
      Version: doc.format.version,
      Container: doc.format.container,
      Page: `${doc.pageSize.width.toFixed(1)} × ${doc.pageSize.height.toFixed(1)} mm`,
      Pages: pages.length,
      Objects: pages.reduce((n, p) => n + p.layers.reduce((m, l) => m + countObjects(l.objects), 0), 0),
      Fills: Object.keys(doc.fills).length,
      Outlines: Object.keys(doc.outlines).length,
      Styles: Object.keys(doc.styles).length,
      Author: doc.metadata?.Author ?? '—',
    };
    byId('facts').innerHTML = Object.entries(facts)
      .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join('');
    byId('warnings').innerHTML = doc.warnings.length
      ? doc.warnings.map((w) => `<li class="warn">${escapeHtml(w)}</li>`).join('')
      : '<li>none</li>';
    byId('tree').textContent = doc.tree ? formatTree(doc.tree, { hex: 12 }) : '';
    byId('out').hidden = false;
    status.textContent = '';
  } catch (err) {
    byId('out').hidden = true;
    status.textContent = err instanceof Error ? err.message : String(err);
    status.className = 'err';
  }
}

const input = byId('file');
if (!(input instanceof HTMLInputElement)) throw new Error('#file must be an <input>');
input.addEventListener('change', () => {
  const f = input.files?.[0];
  if (f) void open(f);
});
const drop = byId('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => {
  drop.classList.remove('over');
});
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) void open(f);
});
byId('save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastSvg], { type: 'image/svg+xml' }));
  a.download = `${lastName}.svg`;
  a.click();
  URL.revokeObjectURL(a.href);
});
