# Draw

An independent desktop vector graphics editor. It will have its own document
format, editing engine, renderer and Electron/React desktop interface. CDR,
SVG and PDF are import/export formats, never the native one.

**Status:** roadmap **Phase 0 (foundation) is complete**. The repository is a
strict-TypeScript monorepo containing the experimental CorelDRAW importer,
developer tools and the enforcement scaffolding later phases build on. There
is no desktop application yet; it arrives in Phase 2.

- [Architecture proposal and roadmap](docs/architecture/proposal.md)
- [Architecture decision records](docs/architecture/adr/)
- [CorelDRAW format notes](docs/formats/cdr-format.md) and
  [how they were reverse-engineered](docs/formats/rea-analysis.md)

## Requirements

- Node.js **22.18 or later** (runs TypeScript directly; see ADR 0004)
- git (only for `npm run fixtures`)

## Commands

```bash
npm ci                 # install (dev tooling only; no runtime dependencies)
npm run check          # typecheck + lint + format check + boundary rules + tests
npm test               # tests only (Vitest)
npm run coverage       # tests with V8 coverage
npm run fixtures       # fetch real CorelDRAW test files (hash-verified, not committed)
npm run format         # apply Prettier
```

Developer tools:

```bash
npm run cdr2svg -- drawing.cdr              # writes drawing.svg
npm run cdr2svg -- drawing.cdr --info       # summary
npm run cdr2svg -- drawing.cdr --json       # decoded import model
npm run cdr2svg -- drawing.cdr --tree       # raw RIFF chunk tree
npm run viewer                              # CDR debug viewer in the browser (Vite)
```

## Repository layout

```
packages/
  archive/    binary reader, inflate, ZIP reading (platform-neutral)
  io-cdr/     CorelDRAW importer: RIFF/cmpr decoding, import model, SVG preview
  testkit/    test-only builders (synthetic CDR/ZIP files) and fixture access
tools/        cdr2svg CLI, fixture fetcher, boundary checker, debug viewer
docs/         architecture proposal, ADRs, format notes
fixtures/     real-file test fixtures (fetched, git-ignored)
```

Packages planned in the proposal (geometry, color, document, render, editor,
format-native, io-svg, io-pdf, io-raster) and `apps/desktop` already have
entries in the boundary rules (`tools/boundaries.ts`).

## Engineering rules

- **Strict TypeScript everywhere.** Library code is platform-neutral: no DOM,
  no Node built-ins. This is enforced by a separate typecheck pass and by
  `npm run boundaries`.
- **Layering is enforced.** Lower layers never import higher ones. Only the
  Electron main and preload code may import `electron` (ADR 0005).
- **No dependency without an ADR.** There are zero runtime dependencies
  today.
- **CDR import output is pinned by golden files.** An intentional change
  updates `packages/io-cdr/test/golden/` in the same commit (ADR 0006).

## CorelDRAW import: support level

Experimental. It is **verified against real CorelDRAW X5 (version 1500)
output only**:
- rectangles;
- solid RGB/CMYK fills;
- outlines and styles inherited through the style table;
- layers;
- the invert lens.

Other versions, groups, polygons and gradients are implemented from
documented layouts and are untested. Text, bitmaps, pattern fills, PowerClip
and CMX are not supported. See `docs/formats/cdr-format.md` for every field's
confidence level.

## Licence and credits

The project licence has **not been chosen yet** (see proposal §7).

No CorelDRAW code or assets are used. libcdr (Document Liberation Project,
MPL-2.0) served as a reference for format details only. CorelDRAW is a
trademark of its owner; this project is not affiliated with it.
