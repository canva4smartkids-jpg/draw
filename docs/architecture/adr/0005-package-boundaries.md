# 0005: Package boundaries, enforced in CI

- Status: accepted
- Date: 2026-11-04

## Context

The proposal separates geometry, document, rendering, editor, IO and UI so
they can be tested and replaced independently (proposal §3.2). Boundaries
that are not enforced erode.

## Decision

`tools/boundaries.ts` holds the layer table, including packages that do not
exist yet. `npm run boundaries` (part of `npm run check`) fails when:

- a package's `src/` imports an `@draw/*` package its layer does not allow,
  or one that is not declared in its `dependencies`;
- a platform-neutral package's `src/` imports a Node built-in (all packages
  except `testkit` are platform-neutral: they must run in the renderer,
  workers and Node);
- `electron` is imported outside `apps/desktop/src/main` or
  `apps/desktop/src/preload`;
- a relative import escapes its package;
- a third-party import is undeclared;
- a package directory is missing from the layer table;
- the layer table contains a cycle.

Imports are found with TypeScript's own pre-processor, not regular
expressions, so comments and strings are never mistaken for imports. Tests
may import their own package by name (to exercise the public API), plus
`@draw/testkit` and the shared development toolchain.

ESLint additionally forbids DOM and Node globals (`window`, `document`,
`process`, `Buffer`, …) in `packages/*/src`.

## Consequences

A new package needs a line in the layer table, which forces a conscious
decision about where it sits.
