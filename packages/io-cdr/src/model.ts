// The decoded CorelDRAW document model returned by readCdr().
//
// This is an *import* model: it mirrors what the file stores (CDR units,
// axes, ordering and style indirection) so nothing is lost before an adapter
// converts it into the application's own document model.
//
// Conventions: lengths in millimetres; origin at the page centre, y axis up;
// layers and objects listed top-most first, as stored.
//
// Fields whose names start with "_" are internal links kept for resolution
// and are omitted from the CLI's JSON output.

import type { Chunk } from './riff.ts';
import type { Bounds, Matrix, PathCommand } from './path.ts';
import type { Rgb } from './color.ts';

export type Container = 'riff' | 'zip-riffData' | 'zip-root';

export interface CdrFormatInfo {
  readonly container: Container;
  readonly version: number;
  readonly product: string;
  readonly precision: 16 | 32;
  readonly units: 'mm';
  readonly coordinateSystem: 'page-centre-y-up';
  readonly stackingOrder: 'top-first';
}

export interface CdrColor {
  readonly model: string;
  readonly modelCode: number;
  readonly palette: number;
  readonly value: string;
  readonly rgb: Rgb;
}

export type GradientKind = 'linear' | 'radial' | 'conical' | 'square';

export interface GradientStop {
  readonly offset: number;
  readonly color: CdrColor;
}

export interface CdrGradient {
  readonly kind: GradientKind;
  readonly edgeOffset: number;
  readonly angle: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly mode: number;
  readonly midpoint: number;
  readonly stops: readonly GradientStop[];
}

interface FillRecordBase {
  readonly id: string;
  readonly _id: number;
  readonly typeCode: number;
}
export interface NoFill extends FillRecordBase {
  readonly type: 'none';
}
export interface SolidFill extends FillRecordBase {
  readonly type: 'solid';
  readonly color: CdrColor;
}
export interface GradientFill extends FillRecordBase {
  readonly type: 'gradient';
  readonly gradient: CdrGradient;
}
export type UnsupportedFillType =
  'pattern' | 'bitmap' | 'full-color-pattern' | 'texture' | 'postscript' | `unknown-${number}`;
export interface UnsupportedFill extends FillRecordBase {
  readonly type: UnsupportedFillType;
}
export type CdrFillRecord = NoFill | SolidFill | GradientFill | UnsupportedFill;
/** An object referenced a fill id that is not in the fill table. */
export interface MissingFill {
  readonly id: string;
  readonly type: 'missing';
}
export type CdrFill = CdrFillRecord | MissingFill;

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export interface CdrOutline {
  readonly id: string;
  readonly _id: number;
  readonly flags: number;
  readonly none: boolean;
  readonly dashed: boolean;
  readonly scaleWithObject: boolean;
  readonly caps: LineCap;
  readonly join: LineJoin;
  readonly width: number;
  readonly stretch: number;
  readonly angle: number;
  readonly color: CdrColor;
  readonly dashes: readonly number[];
}

export interface CdrStyle {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly fillRef: number;
  readonly outlineRef: number;
  readonly _parent: number;
}

export interface CdrFont {
  readonly id: number;
  readonly encoding: number;
  readonly name: string;
}

export type CornerType = 'round' | 'scallop' | 'chamfer';

export interface RectangleGeometry {
  readonly type: 'rectangle';
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly cornerType: CornerType;
  /** radii at corners (0,0), (0,h), (w,h), (w,0) */
  readonly radii: readonly [number, number, number, number];
}

export interface EllipseGeometry {
  readonly type: 'ellipse';
  readonly width: number;
  readonly height: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly pie: boolean;
}

export interface PointsGeometry {
  readonly type: 'points';
  readonly points: readonly (readonly [number, number])[];
  readonly nodeTypes: readonly number[];
}

export type UnsupportedKind = 'artistic-text' | 'paragraph-text' | 'bitmap' | 'spline';

export interface UnsupportedGeometry {
  readonly unsupported: UnsupportedKind;
}

export type CdrGeometry = RectangleGeometry | EllipseGeometry | PointsGeometry | UnsupportedGeometry;

export interface PolygonParams {
  readonly sides: number;
  readonly step: number;
  readonly rx: number;
  readonly ry: number;
  readonly cx: number;
  readonly cy: number;
}

export type CdrLens =
  | {
      readonly type: string;
      readonly typeCode: number;
      readonly opacity: number;
      readonly raw: string;
      readonly _start: number;
    }
  | { readonly type: 'transparency'; readonly opacity: number; readonly raw: string };

export type ObjectKind =
  'rectangle' | 'ellipse' | 'curve' | 'artistic-text' | 'bitmap' | 'paragraph-text' | 'polygon' | 'path' | 'spline';

export interface CdrObject {
  readonly kind: ObjectKind | `unknown-0x${string}`;
  readonly id: number | null;
  readonly transform: Matrix;
  /** geometry in page space (local geometry with `transform` applied) */
  readonly path: readonly PathCommand[] | null;
  readonly fill: CdrFill | null;
  readonly outline: CdrOutline | null;
  readonly lens: CdrLens | null;
  readonly bbox: Bounds | null;
  readonly geometry: CdrGeometry | null;
  readonly styleId: string | null;
  readonly fillSource: 'object' | 'style' | null;
  readonly outlineSource: 'object' | 'style' | null;
}

export interface CdrGroup {
  readonly kind: 'group';
  /** list type the group came from: 'grp', 'lnkg', 'vect' or 'clpt' */
  readonly container: string;
  readonly children: readonly CdrNode[];
}

export type CdrNode = CdrObject | CdrGroup;

export interface CdrLayer {
  readonly flags: number;
  readonly master: boolean;
  readonly kind: ObjectKind | null;
  readonly name: string | null;
  readonly objects: readonly CdrNode[];
}

export interface CdrPage {
  readonly index: number;
  readonly flags: number;
  readonly master: boolean;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly CdrLayer[];
}

export const METADATA_TAGS = [
  'ProductName',
  'AppVersion',
  'BuildNumber',
  'CoreVersion',
  'Author',
  'LastAuthor',
  'Title',
  'NumPages',
  'NumLayers',
  'PageDimensions',
  'PageSizeName',
  'DocID',
  'Locale',
] as const;

export type CdrMetadata = Partial<Readonly<Record<(typeof METADATA_TAGS)[number], string>>> & {
  readonly FontsUsed?: readonly string[];
};

export interface PageSize {
  readonly width: number;
  readonly height: number;
  /** false when the file had no usable mcfg record and A4 was assumed */
  readonly fromFile: boolean;
}

export interface CdrDocument {
  readonly format: CdrFormatInfo;
  readonly pageSize: PageSize;
  readonly pages: readonly CdrPage[];
  readonly fills: Readonly<Record<string, CdrFillRecord>>;
  readonly outlines: Readonly<Record<string, CdrOutline>>;
  readonly styles: Readonly<Record<string, CdrStyle>>;
  readonly fonts: Readonly<Record<string, CdrFont>>;
  readonly metadata: CdrMetadata | null;
  readonly packageEntries: readonly string[] | null;
  /** the raw chunk tree, only when readCdr() is called with keepTree */
  readonly tree: Chunk | undefined;
  readonly warnings: readonly string[];
}

export interface ReadCdrOptions {
  readonly keepTree?: boolean;
}
