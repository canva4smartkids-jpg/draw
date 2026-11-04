# CorelDRAW `.cdr` format notes

These notes record what was established about the CorelDRAW file format while
building this reader. Each section says where the knowledge came from and
how confident it is:

- **verified**: observed in real CorelDRAW output (the X5 sample below) and
  checked against an independent ground truth, either CorelDRAW's own
  thumbnail or the `metadata.xml` it writes.
- **cross-checked**: consistent with the public behaviour of
  [libcdr](https://github.com/LibreOffice/libcdr) (the Document Liberation
  Project's reader used by LibreOffice and Inkscape) but not exercised by a
  real file here.
- **unverified**: implemented from documentation only. No sample has
  exercised it yet.

No CorelDRAW binaries were decompiled or inspected. Everything here comes
from files, i.e. this is file-format reverse engineering for interoperability.

## Evidence used

| File | Source | SHA-256 | Notes |
| --- | --- | --- | --- |
| `fdo65220-2.cdr` | LibreOffice `writerperfect/qa/unit/data/draw/libcdr/pass/` | `88e62beb…dd348` | Real CorelDRAW X5 (build 686) output: one A4 page, 5 rectangles, one invert lens |
| `EDB-35217-2.cdr` | same directory | `10bbe0e2…d42df` | Crash-regression input; uniformly high entropy, no RIFF/ZIP structure |
| `fdo63782-1.cmx` | `…/libcdr-cmx/pass/` | `14c29eed…93e80` | Corel Presentation Exchange file, used only to test format identification |

`npm run fixtures` fetches these files and verifies their hashes.

## 1. Containers (verified for X5)

CorelDRAW has used three outer containers:

| Versions | Container | Drawing stream |
| --- | --- | --- |
| 3 – X3 (≤ 1300) | bare RIFF file | the file itself |
| X4 – X5 (1400 – 1500) | ZIP package | `content/riffData.cdr` |
| X6 + (≥ 1600) | ZIP package | `content/root.dat` plus `content/data/*.dat` streams listed in `content/dataFileList.dat` |

The X5 package (REA `inspect-artifact`, then `extract-artifact`) contains:

```
content/riffData.cdr          3978 B   stored    the drawing (RIFF)
metadata/metadata.xml         6174 B   deflated  XMP: product, build, page size, object counts
metadata/textinfo.xml          621 B   deflated  layer / page / object names
metadata/thumbnails/page1.bmp  139318 B deflated 181×256 preview of page 1
metadata/thumbnails/thumbnail.bmp 196662 B deflated 256×256 preview
color/docPalette.xml          1042 B   deflated  named document colours (RGB/CMYK tints)
color/color.xml                249 B   deflated  colour-management context
links.xml                       53 B   deflated  external links (empty here)
```

`metadata.xml` turned out to be a ground-truth oracle. It states
`ProductName=CorelDRAW X5`, `BuildNumber=686`, `PageWidth=2100000`,
`PageHeight=2970000`, `Objects/Rect=5`, `Fills/Uniform=5` and `Effects/Lens=1`.
Every one of those numbers is reproduced by the reader.

## 2. RIFF stream (verified)

The stream is little-endian RIFF: `RIFF <u32 size> 'CDR?'`. The fourth byte of
the form type encodes the major version: `'5'`…`'9'` → 5–9, `'A'` → 10,
`'B'` → 11, … `'F'` → 15 (X5), `'G'` → 16 (X6), and so on (×100 gives the
internal version number). A `vrsn` chunk (`u16`, here `0x05dc` = 1500) gives
the exact value.

Two deviations from textbook RIFF:

1. **Compressed lists.** `LIST 'cmpr'` has this body:

   ```
   u32 compressedSize     size of the first CPng block, including its 8-byte header
   u32 uncompressedSize   inflated size of that block (24482 in the sample)
   u32 tableCompressedSize
   u32 tableUncompressedSize
   'CPng' u16=1 u16=4  <zlib stream>      → the record stream
   'CPng' u16=1 u16=4  <zlib stream>      → u32[] block-length table
   ```

   Inside the inflated record stream, a chunk's size field is **an index
   into the block-length table**, not a byte count. In the sample, index 0
   resolves to 20226 bytes, which is the `LIST 'doc '` that holds every
   style table. This is why the raw `riffData.cdr` measures 7.93 bits/byte
   in REA's `inspect-byte-entropy`: almost the whole stream is zlib payload.

2. **Padding.** Odd-sized records inside `cmpr` are not padded (a 97-byte
   `fild` is followed directly by the next header). Readers should skip any
   zero bytes between records instead of assuming RIFF's even alignment.

From version 7 onward, `LIST 'stlt'` (the style table) is a flat binary
structure, not a list of sub-chunks (see §6).

## 3. Document tree (verified)

```
RIFF 'CDRF'
  vrsn                         version (u16)
  LIST cmpr                    empty in the sample
  LIST cmpr
    LIST 'doc '
      mcfg                     page settings (width/height after 12 bytes in X3+)
      LIST fntt  font*         font table (u16 id, u16 encoding, 14 bytes, UTF-16 name)
      LIST filt  LIST filc fild*   fill table
      LIST otlt  outl*         outline table
      LIST stlt                style table (binary)
    LIST page                  page 0: master page (flags 0x90010000)
      flgs bbox LIST gobj LIST layr* …
    LIST page                  page 1: the real page (flags 0x90000040)
      flgs bbox obbx
      LIST gobj
        LIST layr              flgs, LIST lgob(loda: layer properties), LIST obj*
          LIST 'obj '
            flgs bbox obbx usdn
            LIST lgob
              loda             geometry + style references
              ftil             fill transform (6 doubles)
              LIST trfl trfd   object transform
```

- **Master page.** Pages whose `flgs` has bits in `0x00ff0000` hold the master
  layers: guides, desktop and grid, named *Hilfslinien*, *Desktop* and
  *Gitter* in this German-locale file. Their layers carry the `0x00010000`
  flag. Normal content layers (*Ebene 1*, "Layer 1") have flags `0x98000000`.
- **Layer names** are stored in the layer's `loda` as argument type `0x3e8`,
  NUL-terminated UTF-16 (verified: all four names decode and match
  `textinfo.xml`).
- **Stacking order.** Objects and layers are stored **top-most first**. The
  lens object is first in the file but on top in CorelDRAW's thumbnail.
- **Object ids.** `usdn` holds a per-document object number (5, 6, 7, 8, 4 in
  the sample).

## 4. `loda`: the object record (verified)

```
u32 length
u32 argCount
u32 argOffsetsStart     → u32 offsets[argCount]
u32 argTypesStart       → u32 types[argCount], stored in REVERSE order
u32 kind                1 rect, 2 ellipse, 3 curve, 4 artistic text, 5 bitmap,
                        6 paragraph text, 0x14 polygon, 0x25 path (v4+)
… argument bodies …
```

The reversed type table was established by pairing offsets with types in
both orders. Only the reversed pairing puts the 16-byte GUID under `0x9c41`,
the geometry under `0x1e` and the trailing 4-byte fill id under `0x14`.

| Arg type | Meaning | Body |
| --- | --- | --- |
| `0x1e` | geometry | depends on `kind` (below) |
| `0x14` | fill id | `u32` → `fild` |
| `0x0a` | outline id | `u32` → `outl` |
| `0xc8` | style id | `u32` → `stlt` record |
| `0x1f40` | lens / transparency | see §8 |
| `0x3e8` | name | UTF-16 string |
| `0x2af8` | polygon parameters | sides, step, radii, centre (unverified) |
| `0x4aba` | page size | two coordinates (cross-checked) |
| `0x9c41` | object GUID | 16 bytes |
| `0x4ae2`, `0x64` | unknown | 12 and 4 bytes; identical on every rectangle |

### Geometry

- **Rectangle, X5 (verified):** `f64 width, f64 height, f64 scaleX, f64 scaleY,
  u8 radiusMode, 7 pad`, then four corner radii, each followed by padding,
  with a corner-type byte after the first. Width and height are signed. The
  sample's rectangles have negative heights, so each one is drawn from its
  local origin downwards. Pre-X5 files use integer coordinates and up to four
  radii (cross-checked).
- **Ellipse:** `coord w, coord h, angle start, angle end, pie flag`, centred on
  `(w/2, h/2)` (cross-checked).
- **Curve / path:** a node count, then `count` coordinate pairs, then `count`
  node-type bytes (cross-checked):
  - `0x40` and `0x80` both clear → move-to
  - `0x40` only → line-to
  - both set → Bézier control point
  - `0x80` only → curve end point
  - `0x08` → the subpath closes here

## 5. Units, coordinates and transforms (verified)

- 32-bit coordinates (v6+) are integers in units of **1/254000 inch = 0.1 µm**,
  i.e. `mm = raw / 10000`. `mcfg` gives `2100000 × 2970000`, which is A4
  (210 × 297 mm), matching `metadata.xml`. 16-bit coordinates (v5 and
  earlier) are 1/1000 inch.
- X5 rectangles and all matrices use IEEE doubles in the same unit.
- The page origin is the **page centre**, with **y pointing up**.
- `trfd` holds a list of matrices. In X3+ each matrix is preceded by 8 bytes,
  then a `u16` type (`0x08` = affine), 6 pad bytes and six doubles
  `a b c d e f`, mapping `(x, y) → (a·x + b·y + c, d·x + e·y + f)`. The lens
  rectangle's matrix is `[0.838, 0, −16.69 mm, 0, 1, 107.02 mm]`: its stored
  139.07 mm width is horizontally scaled to the 116.6 mm seen in the thumbnail.
- From version 4 on, an object's matrix is absolute. Group matrices are not
  applied to children (cross-checked).

## 6. Styles: `fild`, `outl`, `stlt` (verified)

**`fild` (X3+).** `u32 id, 8 bytes, u16 type`.
- Type 1 (solid) has 13 more bytes, then a colour record.
- Type 2 (gradient) has a header and colour stops.
- Type 0 is no fill.

In the sample, all four RGB fills decode to exactly the RGB tints listed in
`docPalette.xml`: Blau `0,0,1`, Rot `1,0,0`, Babyblau `0.4,0.6,1`,
Waldgrün `0,0.4,0.2`.

**Colour record (v5+).** `u16 model, u16 palette, 4 bytes, u32 value`. Models
seen: `0x05` RGB (value bytes B, G, R) and `0x02` CMYK 0–100 (bytes
C, M, Y, K). Other models are implemented from libcdr's model table:
CMY, HSB, HLS, grayscale, Lab and registration.

**`outl` (X3+).** `u32 id`, then tagged blocks `(u32 tag, u32 length, body)`.
Block tag 1 is the outline proper:

```
u16 flags   bit 0 = none, bit 2 = dashed, bit 5 = scale with object
u16 caps    0 butt, 1 round, 2 square
u16 join    0 miter, 1 round, 2 bevel
s32 width   e.g. 2000 = 0.2 mm
u16 stretch (percent)
2 pad, angle, 46 bytes
colour
16 bytes
u16 dash count, dashes
```

**`stlt` style table (verified, X5).** The table is a sequence of counted
sections. Lengths for X5 that consumed the 3716-byte table exactly:

| Section | Record size |
| --- | --- |
| style count | (single `u32`) |
| fills: `id → fild id` | 60 (12 + 48-byte matrix) |
| outlines: `id → outl id` | 12 |
| fonts | 60 |
| alignment | 12 |
| intervals | 52 |
| paragraph settings | 152 |
| tabs | 784 |
| bullets | variable (60 or 116) |
| indents | **28** |
| hyphenation | 36 |
| drop caps | 28 |
| `set11` | 12 |
| style records | variable |

Each style record is:

```
u32 parts, u32 id, u32 parent, 8 bytes
u32 nameLength, UTF-16 name
u32 fillRef, u32 outlineRef
+20 bytes if parts > 1
+20 bytes if parts > 2
```

The sample's ten styles are named `CorelDefaultID_5000`…`5009`. Fill and
outline references go through the two indirection sections at the top of the
table.

This resolved a real rendering question. None of the five rectangles has an
outline argument, yet CorelDRAW's thumbnail shows black outlines. All five
reference style `0x0b11efc8` (*CorelDefaultID_5008*), whose outline ref
`0x0b109b30` maps to `outl 0x0aeb39e8`: 0.2 mm, solid, black.

## 7. ZIP X6+ out-of-line records (unverified)

In `root.dat`, a 16-byte leaf record is a reference:
`u32 stream index, u32 length, u32 offset`. The index points into the
streams listed by `dataFileList.dat`. The reader follows these references
for the record types it decodes. No X6+ sample was available, so this path is
untested.

## 8. Lens effects (verified for one case)

The lens object carries a `0x1f40` argument (134 bytes in X5) that starts
`u32 0x514, u32 0x7e, u8, u32 id, u8 lensType`. Here `lensType = 3`, and
CorelDRAW's thumbnail shows every colour under that rectangle replaced by its
RGB complement:

| Original | Under the lens |
| --- | --- |
| blue | yellow |
| red | cyan |
| `#6699ff` | `#996600` |
| `#006633` | `#ff99cc` |

So type 3 is an **invert** lens. Treating this argument as plain opacity, as
earlier readers do, would make the lens fully transparent. The renderer maps
it to `mix-blend-mode: difference` with white.

There is one remaining difference. CorelDRAW paints the inverted white paper
as `#2a2a2a` rather than pure black, probably because the inversion is done
in its colour-managed space. Other lens types are reported by number and
rendered as ordinary fills.

## 9. What is not decoded yet

- text (`txsm` and the paragraph styles)
- bitmaps (`bmp`/`bmpf`)
- pattern, texture and PostScript fills
- arrowheads (`arrw`)
- envelopes and perspective (`trfd` type `0x10`)
- PowerClip clipping
- spot-colour palettes (approximated as grey)
- CMX files (identified, then refused)
- versions earlier than 4, whose fills and outlines are inline (`Waldo`
  records)

The reader warns about each of these instead of failing silently.
