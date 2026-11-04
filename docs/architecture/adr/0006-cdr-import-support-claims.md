# 0006: CDR import is experimental and claims follow evidence

- Status: accepted
- Date: 2026-11-04

## Context

The CDR reader was built by analysing real CorelDRAW output. Only one real
drawing is available: CorelDRAW X5 (version 1500). Code paths for other
versions follow documented layouts but have never seen a real file.

## Decision

1. CDR support is labelled **experimental** everywhere: code, UI and docs.
   A version is called *verified* only when a real file of that version is a
   CI fixture with assertions on its decoded content. Today that is X5 alone.
2. Fixtures are third-party files. They are fetched by
   `npm run fixtures`, pinned by SHA-256 and never committed.
3. The reader's observable output is pinned by golden files in
   `packages/io-cdr/test/golden/`:
   - the synthetic sample's SVG, JSON and chunk tree, committed as files;
   - hashes of every CLI output for the real fixtures.

   An intentional change updates the goldens in the same commit and explains
   why in the commit message.
4. No proprietary CorelDRAW code or assets are used. libcdr (MPL-2.0) is a
   reference for field meanings only.

## Consequences

The TypeScript port was proven byte-identical to the original JavaScript
reader. Adding a version means obtaining a legitimately licensed sample
first.
