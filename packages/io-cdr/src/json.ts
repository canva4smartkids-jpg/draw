import type { CdrDocument } from './model.ts';

/**
 * Stable JSON form of a decoded document: internal "_" links and the raw
 * chunk tree are omitted. Used by `cdr2svg --json` and by golden tests.
 */
export function cdrDocumentToJson(doc: CdrDocument): string {
  return JSON.stringify(
    doc,
    (key: string, value: unknown) => (key.startsWith('_') || key === 'tree' ? undefined : value),
    2,
  );
}
