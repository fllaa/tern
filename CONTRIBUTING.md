# Contributing to Tern

Thanks for your interest! Tern is young and moving fast; small, focused PRs have
the best odds of merging quickly.

## Dev setup

1. Install [rustup](https://rustup.rs) — the repo's `rust-toolchain.toml` pins the
   toolchain and components automatically.
2. Install [bun](https://bun.sh) ≥ 1.3.
3. Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for
   your OS (on Linux that includes `libwebkit2gtk-4.1-dev` and friends).
4. `bun install`, then `bun run tauri dev`.

## Checks to run before pushing

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run --filter @tern/ui build
cargo deny check        # optional locally; CI runs it
```

## DCO sign-off (required)

Every commit must carry a `Signed-off-by` trailer:

```
Signed-off-by: Your Name <you@example.com>
```

Add it with `git commit -s`. This is the
[Developer Certificate of Origin](https://developercertificate.org) — your
attestation that you have the right to submit the work under Apache-2.0. It is
**not** a CLA; there is no paperwork and you keep your copyright.

Forgot to sign off? Fix the branch with:

```sh
git rebase --signoff origin/main
git push --force-with-lease
```

CI enforces this on every pull request.

## Architecture ground rules

```
crates/
  proto/        serde types shared across the IPC boundary
  core-ssh/     russh session management, channels, forwards, agent
  term-stream/  output coalescing + flow control shared by SSH and local-PTY paths
  core-pty/     local shells via portable-pty
  core-sftp/    (Phase 3)
  core-vault/   storage + crypto (Phase 5; OS-keyring wrapper lives here)
  core-serial/  (Phase 4)
apps/desktop/   Tauri 2 shell — thin: wiring + capabilities only
ui/             React + Vite + TypeScript frontend
```

**The hard rule: no `tauri` dependency in any `core-*` crate (or `proto`, or
`term-stream`).** This is what keeps a future mobile app a re-skin instead of a
rewrite. PRs that violate it will be asked to move the code.

Significant decisions get an ADR in [docs/adr/](docs/adr/) — one page, using the
template there. If your PR changes an architectural decision, update or add one.

## Privacy policy applies to code too

No telemetry, no phoning home, no remote content in the webview. PRs introducing
any of these will be declined regardless of intent.
