// CorelDRAW (.cdr) import: container and record decoding into an import
// model, plus an SVG preview renderer.
//
// Support level: verified against real CorelDRAW X5 (version 1500) output
// only. Every other version is experimental; see docs/formats/cdr-format.md.

export { readCdr, sniff, productName, versionFromFormChar, nodesToPath } from './cdr.ts';
export type { SniffResult } from './cdr.ts';
export { toSvg } from './svg.ts';
export type { ToSvgOptions } from './svg.ts';
export { parseRiff, walk, formatTree } from './riff.ts';
export type { Chunk, WalkEntry, ParseRiffOptions } from './riff.ts';
export { toRgb, rgbHex, modelName } from './color.ts';
export type { Rgb, RgbConversion } from './color.ts';
export type { Matrix, PathCommand, Path, Bounds } from './path.ts';
export type * from './model.ts';
export { METADATA_TAGS } from './model.ts';
export { cdrDocumentToJson } from './json.ts';
