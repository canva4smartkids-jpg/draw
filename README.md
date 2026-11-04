# draw: an open CorelDRAW (`.cdr`) reader

A zero-dependency JavaScript reader for CorelDRAW drawings. It decodes the
container, the RIFF record tree and the drawing model (pages, layers,
objects, fills, outlines, styles), then renders the result to SVG. The same
modules run in Node.js (≥ 20) and in the browser.

The format knowledge came from reverse-engineering real CorelDRAW output
with [REA](https://github.com/morluto/rea) and byte-level analysis, checked
against the metadata and thumbnails CorelDRAW embeds in its own files. See:

- [`docs/cdr-format.md`](docs/cdr-format.md): the format, field by field,
  with confidence levels
- [`docs/rea-analysis.md`](docs/rea-analysis.md): the REA workflow and the
  evidence behind each finding

## Quick start

```bash
node bin/cdr2svg.js drawing.cdr              # writes drawing.svg
node bin/cdr2svg.js drawing.cdr --info       # summary
node bin/cdr2svg.js drawing.cdr --json       # full decoded model
node bin/cdr2svg.js drawing.cdr --tree       # raw RIFF chunk tree
```

Browser viewer (drag and drop; files never leave the page):

```bash
node scripts/serve.js 8080    # then open http://127.0.0.1:8080/
```

Library:

```js
import { readCdr, toSvg } from './src/index.js';

const doc = await readCdr(bytes);   // Uint8Array
doc.format;                         // { version: 1500, product: 'CorelDRAW X5', container: 'zip-riffData', … }
doc.pages[1].layers[3].objects[0];  // { kind: 'rectangle', path, transform, fill, outline, lens, … }
const svg = toSvg(doc);
```

All lengths in the model are millimetres in CorelDRAW page space: origin at
the page centre, y axis up. Objects are listed top-most first, as stored in
the file.

## What works

| Feature | Status |
| --- | --- |
| Containers: bare RIFF (v3–X3), ZIP + `riffData.cdr` (X4–X5) | ✅ X5 verified on real output |
| ZIP + `root.dat` with out-of-line data streams (X6+) | ⚠️ implemented, no sample yet |
| Compressed `cmpr` record streams | ✅ |
| Pages, master page, layers and layer names | ✅ |
| Rectangles (incl. rounded/scallop/chamfer corners), ellipses, arcs, pies, curves, paths | ✅ rectangles verified; others built from documented layouts |
| Polygons and stars | ⚠️ unverified |
| Object transforms | ✅ |
| Solid fills, all common colour models | ✅ |
| Linear and radial gradients | ⚠️ approximate |
| Outlines: width, colour, caps, joins, dashes | ✅ |
| Style table (`stlt`) with inherited fills/outlines | ✅ verified |
| Invert lens | ✅ verified against CorelDRAW's thumbnail |
| Text, bitmaps, pattern/texture fills, PowerClip, envelopes | ❌ reported as warnings |
| CMX files | ❌ identified and refused |

## Tests

```bash
npm test             # synthetic files built in test/helpers/build.js
npm run fixtures     # fetch real CorelDRAW files from LibreOffice's test data
npm test             # now also runs test/real-files.test.js
```

The real-file regression checks the CorelDRAW X5 drawing:

- five rectangles under an invert lens
- every fill colour against the document palette
- outlines inherited through the style table
- the lens transform

Without the fixtures those tests are skipped, not failed.

## Scope and credits

This project reads files that CorelDRAW produces so they can be opened
elsewhere (interoperability). It contains no CorelDRAW code or assets, and no
CorelDRAW program was disassembled.
[libcdr](https://github.com/LibreOffice/libcdr) (Document Liberation Project,
MPL-2.0) was used as a reference for record layouts the samples did not
cover. The implementation here is independent. CorelDRAW is a trademark of
its owner, and this project is not affiliated with it.
