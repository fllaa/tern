# ADR-0014: Component foundation — LiltUI, vendored

- Status: Accepted
- Date: 2026-07-20

## Context

Phase 1 replaces the Phase 0 dev harness with a real product shell: sidebar
tree, session tabs, modals, context menus, settings. ADR-0010 settled the stack
(React 19 + Vite + Zustand + Tailwind 4) but not what the components are made
of. Writing dialog focus traps and tree keyboard navigation by hand is exactly
the sort of a11y work that is easy to get subtly wrong.

## Decision

We use **LiltUI**, the author's own component registry, on **Base UI** +
Tailwind 4. It is a shadcn-style copy-in registry rather than a package: the
`shadcn` CLI copies source into `ui/src/components/ui/` and those files become
ours. Base UI supplies focus management, roving tabindex, typeahead and ARIA
wiring; Lilt supplies the styling and a WAI-ARIA `Tree` we would otherwise have
written ourselves.

Two components are deliberately **not** taken. `@lilt/sidebar` registers a
global `(meta|ctrl)+B` keydown listener, and **Ctrl+B is the tmux prefix key** —
in an SSH client that would swallow the most-pressed chord of the target
audience on every keystroke while the terminal is focused. The host sidebar is
composed from `Resizable` + `ScrollArea` + `Tree` instead. `@lilt/table` and
`@lilt/data-table` are skipped because nothing in Phase 1 is tabular and they
would pull in TanStack Table for nothing.

Vendored files may be edited, and edits are marked as such in the file. Three
so far: two whimsical defaults that render on every dialog and form field
(`"A small checkpoint"`, `"Optional, no pressure"`), and a CLI import-rewriting
bug in `tree.tsx` that made it import its own types from itself.

Fallback: because these are plain files, replacing any single component with a
hand-written one is a local change, not a migration.

## Consequences

- Good: a keyboard-accessible tree, dialogs, command palette and context menus
  without hand-rolling focus management, and full freedom to edit any of it.
- Good: the app's own components use the same tokens as the vendored ones, so
  there is one visual system rather than a library plus a local dialect.
- Bad / accepted cost: **no upstream update path.** There is no version and no
  changelog; a fix in the registry has to be re-copied and re-diffed by hand.
  Phase 1 therefore never improves LiltUI — missing pieces are written locally
  and upstreamed after the phase.
- Bad / accepted cost: Lilt's colours are plain `:root` custom properties, not
  registered in `@theme`, so component code writes `bg-[var(--lilt-surface)]`
  rather than `bg-surface`. Verbose, and it means Tailwind cannot warn about a
  token that does not exist.
- Fonts must be bundled, not linked: `tauri.conf.json` sets
  `font-src 'self' data:`, so the registry's suggested Google Fonts link would
  silently fail. `@fontsource` packages satisfy this with no CSP change.
- Revisit when: maintaining the fork costs more than the components save, or
  Base UI ships a tree primitive of its own.
