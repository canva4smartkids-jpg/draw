# 0003: React for the application UI

- Status: accepted
- Date: 2026-11-04

## Context

Panels, inspectors, trees, dialogs and tabs need a component model. The
canvas must not depend on it: it is owned by the render engine. See proposal
§2.6.

## Decision

Use React for the UI shell in `apps/desktop/src/renderer`. It binds to the
editor through the editor's own store API (`subscribe`/selectors, consumed
via `useSyncExternalStore`).

- No `packages/*` module may import React; the boundary checker treats any
  undeclared third-party import as a violation.
- No third-party component library. The UI uses an in-house design system so
  the application has its own visual identity.

## Consequences

React is introduced in roadmap phase 2, together with Electron, not earlier.
Because the editor core is framework-free, replacing React later would touch
only the renderer UI layer.
