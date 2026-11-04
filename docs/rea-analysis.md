# How REA was used

[REA](https://github.com/morluto/rea) (`rea-agents` 6.8.0 from npm) handled
the container-level work. Byte-level dissection of the RIFF records was done
with small scripts, because REA has no CorelDRAW-specific decoder.

## Scope

CorelDRAW is proprietary Windows software. Its licence restricts reverse
engineering of the program, and REA's own `DISCLAIMER.md` excludes copying
proprietary code. This investigation therefore stayed on the **file format**:
it reads documents that CorelDRAW writes so they can be opened elsewhere
(interoperability). No CorelDRAW executable was downloaded, decompiled or
run.

## Steps

```bash
npm install rea-agents@6.8.0

# 1. What is this file? -> ZIP package, 9-node artifact graph, entry hashes
npx rea inspect-artifact fdo65220-2.cdr --format json

# 2. Unpack it -> content/riffData.cdr, metadata/*.xml, thumbnails, palette
npx rea extract-artifact fdo65220-2.cdr --format json

# 3. Is the payload compressed or encrypted?
npx rea inspect-byte-entropy content/riffData.cdr --block-size 1024
npx rea inspect-byte-entropy EDB-35217-2.cdr --block-size 1024
```

| Finding | REA output |
| --- | --- |
| X5 `.cdr` is a ZIP, not a bare RIFF | `root_format: "zip"`, 8 entries, all `hash_status: verified` |
| The drawing lives in `content/riffData.cdr` (3978 B, stored) | extraction manifest |
| `riffData.cdr` is almost entirely compressed | file entropy 7.93; every 1 KiB block > 7.6 |
| `EDB-35217-2.cdr` is not a drawing | entropy 7.98, uniform across all blocks, no RIFF/ZIP magic; `inspect-artifact` → `unsupported binary format` |
| `fdo63782-1.cmx` | `unsupported binary format` (RIFF `CMX1`, a different format) |

REA correctly cautions that entropy alone cannot tell compressed data from
encrypted data. Here the `RIFF … LIST cmpr … CPng` structure settled it:
the zlib streams inflate to exactly the declared 24482 bytes.

## Byte-level dissection

With the stream unpacked, a short RIFF walker established the tree in
[`cdr-format.md`](cdr-format.md). Four ground truths written by CorelDRAW
itself were then used to confirm or reject each hypothesis:

1. `metadata.xml` object, fill and effect counts → 5 rectangles, 5 uniform
   fills, 1 lens
2. `docPalette.xml` colour tints → every decoded RGB fill
3. `textinfo.xml` layer names → `loda` argument `0x3e8`
4. `metadata/thumbnails/page1.bmp` → the rendered SVG

The final check rasterises the SVG at the thumbnail's 181 × 256 size and
diffs the two images. The mean absolute difference fell from 24.5 to 8.1
(out of 255) after the z-order, invert-lens and paper-blending fixes. What
remains is mostly anti-aliasing, plus CorelDRAW painting inverted paper as
`#2a2a2a` rather than black.

libcdr's source (MPL-2.0) served as a cross-reference for field meanings
that the single sample could not exercise. This repository's code is an
independent JavaScript implementation; [`cdr-format.md`](cdr-format.md)
marks which facts are verified here and which are only cross-checked.

## Repeating this with more samples

Most of the decoder is cross-checked but unverified, so the most useful next
step is more real files. Prefer files you own or that carry a licence.
For each new file:

```bash
npx rea inspect-artifact new.cdr --format json   # container + entries
node bin/cdr2svg.js new.cdr --tree               # record tree
node bin/cdr2svg.js new.cdr --json               # decoded model + warnings
node bin/cdr2svg.js new.cdr -o new.svg           # compare with metadata/thumbnails/*.bmp
```
