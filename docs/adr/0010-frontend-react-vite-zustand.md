# ADR-0010: Frontend — React 19 + Vite 7 + Zustand + Tailwind 4

- Status: Accepted
- Date: 2026-07-20

## Context

The frontend stack is Open Decision #2 in the dev plan: React (author's
background, biggest ecosystem) vs SolidJS (leaner). The SwiftSSH prototype
already built substantial UI in React 19 + Zustand 5 + Tailwind 4.

## Decision

We use **React 19 + Vite + TypeScript (strict) + Zustand + Tailwind 4**. This
matches the author's daily stack and keeps the prototype's screens/stores
portable in Phase 1. Vite is held at **7.x** (not 8/Rolldown) — Phase 0 is
about de-risking the terminal path, not early-adopting bundlers; the upgrade
later is a one-line bump.

## Update (Phase 1)

The component layer is settled separately in ADR-0014: LiltUI on Base UI,
vendored copy-in. Frontend lint/format/test tooling is Biome + Vitest, added in
Phase 1 — CONTRIBUTING lists the commands.

## Consequences

- Good: fastest path through Phases 1–3 (the SFTP file manager especially);
  huge ecosystem around xterm.js, drag-and-drop, virtual lists.
- Bad / accepted cost: React's runtime is heavier than Solid's; terminal
  rendering doesn't care (xterm owns its own DOM/GL), but chrome UI must stay
  disciplined.
- Revisit when: never for v1; a leaner framework is only worth it with a
  ground-up UI rewrite.
