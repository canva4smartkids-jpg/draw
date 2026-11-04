# 0004: Monorepo layout and toolchain

- Status: accepted
- Date: 2026-11-04

## Context

Phase 0 needs strict typing, fast tests, enforceable boundaries and a
dependency budget, without slowing day-to-day work.

## Decision

| Concern | Choice |
| --- | --- |
| Layout | npm workspaces: `packages/*` (libraries) and `tools` (developer tools); `apps/desktop` arrives in phase 2 |
| Language | TypeScript **6.0.3**, pinned |
| Running TS | Node ≥ 22.18 runs `.ts` directly (type stripping). Code uses only erasable syntax and explicit `.ts` import extensions. No build step for libraries, tools or tests; bundling (Vite) is only for browser-facing code |
| Packages | Expose `./src/index.ts` through `exports`; resolved via workspace symlinks |
| Tests | Vitest, with `node:assert/strict` assertions; V8 coverage |
| Lint | ESLint flat config with `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` |
| Format | Prettier (120 columns, single quotes); Markdown is excluded to preserve prose formatting |
| CI | GitHub Actions on Ubuntu, Windows and macOS × Node 22 and 24 |

**Why TypeScript 6.0.3 and not 7.x:** typescript-eslint 8.72 supports
TypeScript `<6.1.0`. Moving to the native TypeScript 7 compiler waits for
typescript-eslint support.

**Strict compiler flags:**
- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `noPropertyAccessFromIndexSignature`
- `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- `noUnusedLocals`, `noUnusedParameters`
- `verbatimModuleSyntax`
- `erasableSyntaxOnly`

**Two typecheck passes per package:**
- `tsconfig.src.json` checks `src/` **without Node types**, so platform-neutral
  code cannot touch `Buffer`, `process` and similar.
- `tsconfig.json` adds tests and Node types.

**Development dependencies** (none ship to users):
- `typescript`
- `vitest`, `@vitest/coverage-v8`
- `vite`
- `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`
- `prettier`
- `@types/node`

**Runtime dependencies:** none.

## Consequences

- `npm run check` is the single gate: typecheck, lint, format, boundaries and
  tests.
- Contributors need Node 22.18 or later.
- Erasable-only syntax rules out `enum`, `namespace` and constructor
  parameter properties.
- Watch: an exported function named `then` makes an ES module namespace
  "thenable" under dynamic import. The CDR matrix helper was renamed to
  `compose` for this reason.
