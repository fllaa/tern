# Tern

**The open, lightweight Termius — with sync you own.**

[![CI](https://github.com/fllaa/tern/actions/workflows/ci.yml/badge.svg)](https://github.com/fllaa/tern/actions/workflows/ci.yml)

Cross-platform SSH client for macOS, Windows, and Linux. Rust core, Tauri 2 shell,
xterm.js frontend. Apache-2.0.

> **Status: pre-alpha.** Tern is a few weeks old. Nothing here is usable yet —
> right now this repo is scaffolding plus the de-risking spikes for the terminal
> data path. Watch releases if you want to know when that changes.

## Why

Termius has the UX but is closed-source with paid sync. Tabby is open but
Electron-heavy. WezTerm is fast but isn't a host manager. Tern aims at all three
at once: Termius-grade UX, fully open source, a Rust-native core, and
self-hostable end-to-end-encrypted sync.

## Privacy

**No telemetry. None by default, ever.** A future release may offer opt-in,
self-hosted crash reporting; it will be off unless you turn it on.

## Planned v1 scope

Terminal + host management · SFTP · tunneling/port forwarding · serial/telnet ·
E2E-encrypted config sync (file-based — you own the storage)

The full phased plan lives in [docs/dev-plan.md](docs/dev-plan.md). Architectural
decisions are recorded in [docs/adr/](docs/adr/).

## Building from source

Prerequisites: [rustup](https://rustup.rs) (the toolchain is pinned by
`rust-toolchain.toml`), [bun](https://bun.sh) ≥ 1.3, and the
[Tauri platform prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
bun install
bun run tauri dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Note that commits require a DCO
sign-off (`git commit -s`).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
