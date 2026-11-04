#!/usr/bin/env node
// cdr2svg — inspect CorelDRAW files and convert them to SVG (developer tool).
//
//   node tools/cdr2svg.ts drawing.cdr              write drawing.svg next to the input
//   node tools/cdr2svg.ts drawing.cdr -o out.svg   choose the output file ("-" = stdout)
//   node tools/cdr2svg.ts drawing.cdr --json       print the decoded document model
//   node tools/cdr2svg.ts drawing.cdr --tree       print the RIFF chunk tree
//   node tools/cdr2svg.ts drawing.cdr --info       print a short summary

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { FormatError, openZip } from '@draw/archive';
import { readCdr, toSvg, parseRiff, formatTree, sniff, cdrDocumentToJson } from '@draw/io-cdr';
import type { CdrNode } from '@draw/io-cdr';

const USAGE = `usage: cdr2svg <file.cdr> [-o out.svg|-] [--page N] [--json] [--tree] [--info]
                [--placeholders] [--master-layers]`;

interface Options {
  input: string | null;
  output: string | null;
  page: number;
  mode: 'svg' | 'json' | 'tree' | 'info' | 'help';
  placeholders: boolean;
  masterLayers: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { input: null, output: null, page: 0, mode: 'svg', placeholders: false, masterLayers: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') opts.output = argv[++i] ?? null;
    else if (a === '--page') opts.page = Number(argv[++i]);
    else if (a === '--json') opts.mode = 'json';
    else if (a === '--tree') opts.mode = 'tree';
    else if (a === '--info') opts.mode = 'info';
    else if (a === '--placeholders') opts.placeholders = true;
    else if (a === '--master-layers') opts.masterLayers = true;
    else if (a === '-h' || a === '--help') opts.mode = 'help';
    else if (!opts.input && a !== undefined) opts.input = a;
    else throw new Error(`unexpected argument: ${String(a)}`);
  }
  return opts;
}

async function riffBytesOf(bytes: Uint8Array): Promise<Uint8Array> {
  const s = sniff(bytes);
  if (s.kind === 'cdr-riff') return bytes;
  if (s.kind === 'zip') {
    const zip = openZip(bytes);
    const riff = (await zip.read('content/riffData.cdr')) ?? (await zip.read('content/root.dat'));
    if (riff) return riff;
  }
  throw new FormatError('not a CorelDRAW file');
}

const countObjects = (objs: readonly CdrNode[]): number =>
  objs.reduce((n, o) => n + (o.kind === 'group' ? countObjects(o.children) : 1), 0);

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help' || !opts.input) {
    console.log(USAGE);
    return opts.mode === 'help' ? 0 : 2;
  }
  const input = opts.input;
  const bytes = new Uint8Array(await readFile(input));

  if (opts.mode === 'tree') {
    const root = await parseRiff(await riffBytesOf(bytes));
    console.log(formatTree(root, { hex: 16 }));
    return 0;
  }

  const doc = await readCdr(bytes);
  for (const w of doc.warnings) console.error(`warning: ${w}`);

  if (opts.mode === 'json') {
    console.log(cdrDocumentToJson(doc));
    return 0;
  }
  if (opts.mode === 'info') {
    const content = doc.pages.filter((p) => !p.master);
    console.log(`${input}: ${doc.format.product} (version ${doc.format.version}, ${doc.format.container})`);
    console.log(`page size: ${doc.pageSize.width.toFixed(2)} x ${doc.pageSize.height.toFixed(2)} mm`);
    content.forEach((p, i) => {
      const layers = p.layers.filter((l) => l.objects.length);
      const summary = layers.map((l) => `${l.name ?? 'layer'} (${countObjects(l.objects)} objects)`).join(', ');
      console.log(`page ${i + 1}: ${summary || 'empty'}`);
    });
    console.log(
      `fills: ${Object.keys(doc.fills).length}, outlines: ${Object.keys(doc.outlines).length}, styles: ${Object.keys(doc.styles).length}`,
    );
    return 0;
  }

  const svg = toSvg(doc, { page: opts.page, placeholders: opts.placeholders, includeMasterLayers: opts.masterLayers });
  if (opts.output === '-') {
    process.stdout.write(svg);
  } else {
    const out = opts.output ?? join(dirname(input), basename(input, extname(input)) + '.svg');
    await writeFile(out, svg);
    console.error(`wrote ${out}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cdr2svg: ${err instanceof FormatError ? '' : 'error: '}${message}`);
    process.exit(1);
  },
);
