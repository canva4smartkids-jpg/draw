#!/usr/bin/env node
// cdr2svg — inspect CorelDRAW files and convert them to SVG.
//
//   cdr2svg drawing.cdr                 write drawing.svg next to the input
//   cdr2svg drawing.cdr -o out.svg      choose the output file ("-" = stdout)
//   cdr2svg drawing.cdr --json          print the decoded document model
//   cdr2svg drawing.cdr --tree          print the RIFF chunk tree
//   cdr2svg drawing.cdr --info          print a short summary

import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { readCdr, toSvg, parseRiff, formatTree, openZip, sniff, FormatError } from '../src/index.js';

const USAGE = `usage: cdr2svg <file.cdr> [-o out.svg|-] [--page N] [--json] [--tree] [--info]
                [--placeholders] [--master-layers]`;

function parseArgs(argv) {
  const opts = { input: null, output: null, page: 0, mode: 'svg', placeholders: false, masterLayers: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') opts.output = argv[++i];
    else if (a === '--page') opts.page = Number(argv[++i]);
    else if (a === '--json') opts.mode = 'json';
    else if (a === '--tree') opts.mode = 'tree';
    else if (a === '--info') opts.mode = 'info';
    else if (a === '--placeholders') opts.placeholders = true;
    else if (a === '--master-layers') opts.masterLayers = true;
    else if (a === '-h' || a === '--help') opts.mode = 'help';
    else if (!opts.input) opts.input = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return opts;
}

async function riffBytesOf(bytes) {
  const s = sniff(bytes);
  if (s.kind === 'cdr-riff') return bytes;
  if (s.kind === 'zip') {
    const zip = openZip(bytes);
    return (await zip.read('content/riffData.cdr')) ?? (await zip.read('content/root.dat'));
  }
  throw new FormatError('not a CorelDRAW file');
}

function replacer(key, value) {
  if (key.startsWith('_') || key === 'tree') return undefined;
  return value;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.mode === 'help' || !opts.input) {
    console.log(USAGE);
    return opts.mode === 'help' ? 0 : 2;
  }
  const bytes = new Uint8Array(await readFile(opts.input));

  if (opts.mode === 'tree') {
    const root = await parseRiff(await riffBytesOf(bytes));
    console.log(formatTree(root, { hex: 16 }));
    return 0;
  }

  const doc = await readCdr(bytes);
  for (const w of doc.warnings) console.error(`warning: ${w}`);

  if (opts.mode === 'json') {
    console.log(JSON.stringify(doc, replacer, 2));
    return 0;
  }
  if (opts.mode === 'info') {
    const content = doc.pages.filter((p) => !p.master);
    const count = (objs) => objs.reduce((n, o) => n + (o.kind === 'group' ? count(o.children) : 1), 0);
    console.log(`${opts.input}: ${doc.format.product} (version ${doc.format.version}, ${doc.format.container})`);
    console.log(`page size: ${doc.pageSize.width.toFixed(2)} x ${doc.pageSize.height.toFixed(2)} mm`);
    content.forEach((p, i) => {
      const layers = p.layers.filter((l) => l.objects.length);
      console.log(`page ${i + 1}: ${layers.map((l) => `${l.name ?? 'layer'} (${count(l.objects)} objects)`).join(', ') || 'empty'}`);
    });
    console.log(`fills: ${Object.keys(doc.fills).length}, outlines: ${Object.keys(doc.outlines).length}, styles: ${Object.keys(doc.styles).length}`);
    return 0;
  }

  const svg = toSvg(doc, { page: opts.page, placeholders: opts.placeholders, includeMasterLayers: opts.masterLayers });
  if (opts.output === '-') {
    process.stdout.write(svg);
  } else {
    const out = opts.output ?? join(dirname(opts.input), basename(opts.input, extname(opts.input)) + '.svg');
    await writeFile(out, svg);
    console.error(`wrote ${out}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`cdr2svg: ${err instanceof FormatError ? '' : 'error: '}${err.message}`);
    process.exit(1);
  },
);
