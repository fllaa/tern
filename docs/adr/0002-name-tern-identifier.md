# ADR-0002: Name "Tern", bundle identifier `io.github.fllaa.tern`

- Status: Accepted
- Date: 2026-07-20

## Context

The name and bundle identifier propagate into the repo, crate prefixes, app data
directories, MSI upgrade identity, macOS keychain entries, and updater identity.
Changing any of these after users exist breaks continuity, so they are decided
first. The prototype's name ("SwiftSSH") collided with Apple's Swift in search.

## Decision

The product is **Tern** (the seabird — small, light, famous for long
migrations). Crates are prefixed `tern-*` (dir names keep the plain
`core-*` layout). The bundle identifier is **`io.github.fllaa.tern`**:
verifiable reverse-DNS without owning a domain, and the exact form Flathub
sanctions for GitHub-hosted projects — so one identifier works everywhere,
forever. `dev.tern.app`-style IDs were rejected because the domain isn't owned
(collision + Flathub-verification risk).

## Consequences

- Good: identifier never needs to change; Flathub (Phase 6) needs no rename.
- Bad / accepted cost: the GitHub-user-based ID looks less "branded" than a
  custom domain. If a domain is bought later, it can be used for the website
  and updater endpoints without touching the bundle identifier.
- Revisit when: never for the identifier; the display name could still be
  rebranded before the first public beta if a conflict surfaces.
