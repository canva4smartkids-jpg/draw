# 0001: Record architecture decisions

- Status: accepted
- Date: 2026-11-04

## Context

The architecture proposal (`docs/architecture/proposal.md`) sets direction,
but individual decisions will be revisited over years of development. We need
a durable record of what was decided, when and why.

## Decision

Significant decisions go in `docs/architecture/adr/NNNN-title.md`, using
`0000-template.md`. This includes:
- technology choices;
- every new runtime or development dependency;
- package boundaries;
- file-format versioning;
- support claims.

An ADR is never edited to reverse it; a new ADR supersedes it.

## Consequences

Reviews can point to an ADR instead of re-arguing a decision. Adding a
dependency costs a short document, which is intentional friction.
