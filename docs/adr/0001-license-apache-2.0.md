# ADR-0001: License — Apache-2.0

- Status: Accepted
- Date: 2026-07-20

## Context

Relicensing after outside contributions land is close to impossible, so this had
to be decided before the first public commit. The candidates were Apache-2.0
(contributor-friendly, explicit patent grant), GPLv3 (blocks closed-source
forks), MIT (maximal simplicity, what WezTerm/Tabby use), and a hybrid
(GPL app + permissive core crates).

## Decision

We license the entire repository under Apache-2.0, with a NOTICE file per Apache
convention. Contributions are accepted under the DCO (`Signed-off-by`, enforced
in CI) rather than a CLA. The patent grant matters for an SSH/crypto product;
the permissive terms match the project's "open Termius" positioning and keep the
core crates reusable by the Rust ecosystem.

## Consequences

- Good: lowest contribution friction; explicit patent protection; core crates
  can be adopted by other projects, which grows the contributor pool.
- Bad / accepted cost: a commercial actor may ship a closed fork. We accept
  this; the project's moat is velocity, trust, and the sync ecosystem — not
  the license.
- Revisit when: never realistically — relicensing is effectively off the table
  once external contributions exist. That is the point of deciding now.
