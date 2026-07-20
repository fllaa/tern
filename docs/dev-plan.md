# SSH Client — Phased Development Plan

*Open-source, Tauri 2 based SSH client for Windows / macOS / Linux. Solo builder, near full-time, Rust-comfortable. Target: signed, auto-updating 1.0 in roughly 6–9 months.*

---

## 1. Snapshot & positioning

The gap you're filling is real: **Termius** has the best UX but is closed-source with a subscription wall on sync. **Tabby** is open but Electron-heavy (300MB+ idle RAM, slow cold start). **WezTerm** is fast but has no host-management UX. A client that combines Termius-grade UX, full OSS, a Rust-native core, and *self-hostable* E2E-encrypted sync has a credible niche — especially with the r/selfhosted crowd.

One-line positioning to keep taped above the desk: **"The open, lightweight Termius — with sync you own."** Every scope decision below should serve that line.

**v1 scope (locked):** terminal + host management, SFTP, tunneling/port forwarding, config sync, serial/telnet.

---

## 2. Architecture decided up front

These are the decisions that get expensive to change after month two.

### Workspace layout

```
repo/
├─ crates/
│  ├─ core-ssh/      # russh session mgmt, channels, forwards, agent, known_hosts
│  ├─ core-store/    # SQLite: hosts, folders, tags, settings (ADR-0012)
│  ├─ core-sftp/     # russh-sftp wrapper, transfer queue engine
│  ├─ core-vault/    # secrets: OS keyring, then argon2id/XChaCha20 vault
│  ├─ core-serial/   # serialport-rs + minimal telnet
│  └─ proto/         # serde types shared across the IPC boundary
├─ apps/desktop/     # Tauri 2 shell (thin: wiring + capabilities)
├─ ui/               # React + Vite + TypeScript frontend
└─ server/           # (post-1.0) self-hosted sync server
```

**Rule: no `tauri` imports inside any `core-*` crate.** This single discipline is what makes the mobile app later (Tauri 2 ships iOS/Android targets) a re-skin instead of a rewrite.

### Library bets

| Concern | Choice | Rationale / fallback |
|---|---|---|
| SSH protocol | `russh` | Pure Rust, async, actively maintained. Fallback: `ssh2` (libssh2) if auth edge cases bite — keep the transport behind a trait so this stays possible |
| SFTP | `russh-sftp` | Rides the same session |
| Terminal render | xterm.js + WebGL addon | Proven at VS Code/Tabby scale; DOM renderer as fallback (xterm 6 removed the canvas renderer) |
| Local PTY | `portable-pty` | Extracted from WezTerm; handles ConPTY on Windows |
| Serial | `serialport-rs` | Cross-platform, mature |
| Secrets | `keyring` (OS keychain) + vault crypto (argon2id + XChaCha20-Poly1305), `zeroize` | Never plaintext on disk |
| Local storage | SQLite via `rusqlite` | Hosts, snippets, history, transfer queue |
| Frontend | React 18 + Vite + Zustand | Safe bet given your NestJS/TS background; SolidJS is the leaner alternative if you want it |

### Terminal data path — the #1 architectural risk

```
russh channel → batch/coalesce (~8–16ms frames, binary)
  → Tauri 2 Channel (raw payloads, not JSON events)
  → xterm.write() with backpressure callback
  → when xterm's buffer fills → shrink SSH window / pause channel
```

If this path can't saturate a terminal (think `yes`, `cat` on a 100MB log, `find /`), the whole architecture wobbles. That's why it gets benchmarked in Phase 0, not discovered in month six. The known escape hatch — rendering the terminal in Rust with wgpu — is a big lift, so prove the cheap path first.

### Security model — non-negotiable from day one

An SSH client lives or dies on trust, and OSS credibility doubles the scrutiny:

- No plaintext secrets on disk, ever. OS keychain for passphrases/passwords, or a master-password vault (argon2id KDF, XChaCha20-Poly1305, `zeroize` on buffers).
- known_hosts with TOFU: clear fingerprint UI on first connect; changed host key = hard, scary warning.
- System SSH agent support on all three OSes: unix socket, Windows OpenSSH named pipe, Pageant.
- Tauri hardening: strict CSP, capability-scoped IPC commands, zero remote content in the webview.
- Paste protection (warn on multi-line paste into a shell).
- No telemetry by default; opt-in crash reporting only, self-hosted — and say so loudly in the README.

---

## 3. Phases

### Phase 0 — De-risking spikes & scaffolding (2–3 weeks)

Kill the unknowns while the codebase is still 500 lines.

- Repo, license (see Open Decisions — decide *now*; relicensing later is painful), DCO, CI matrix on GitHub Actions (lint, test, build on win/mac/linux via `tauri-action`).
- Open the Apple Developer account and Azure Trusted Signing setup **now** — signing logistics take weeks of wall-clock time and you don't want them blocking launch in Phase 6.
- Spike 1: russh → interactive shell with PTY resize + keepalives.
- Spike 2: the throughput benchmark described above. Targets: no dropped output under `yes`, sub-16ms perceived keystroke echo.
- Spike 3: local shell tab via `portable-pty` (including ConPTY on Windows).
- Spike 4: `keyring` round-trip on all three OSes.
- Short ADRs for every row in the library table.

**Exit criteria:** benchmark numbers proving the IPC path is viable, CI producing installable artifacts for all three OSes.

### Phase 1 — Terminal core (4–6 weeks)

- Host manager: CRUD, folders/tags, search, quick-connect (SQLite, ADR-0012).
- Auth: password, publickey (ed25519/ECDSA/RSA), agent; per-host overrides.
- Host-key trust: own known_hosts, TOFU, changed-key refusal (ADR-0013).
- **`~/.ssh/config` import** (ADR-0015) — disproportionate adoption lever, do it early. OpenSSH and PuTTY key import.
- Terminal UX: tabs (ADR-0016), themes, font config, scrollback + search, copy-on-select, paste protection.
- Reconnect logic, keepalive, clear connection-state UI.

**Deferred out of Phase 1:** keyboard-interactive auth (the cost is the async
prompt round-trip across the IPC boundary, not the protocol) and i18n (a
per-string tax on every component written this phase). PuTTY `.ppk` import and
the Windows agent stay in — `ssh-key`'s `ppk` feature and russh's
`connect_named_pipe`/`connect_pageant` are already compiled into the tree, so
both are adapter work rather than protocol work.

**Exit criteria:** you dogfood it daily against your own fleet and stop reaching for the old client. Nothing validates a terminal like living in it.

### Phase 2 — Power-user features (4–6 weeks)

- Split panes; broadcast input to multiple sessions.
- Command palette; keyboard-first navigation throughout.
- Snippets with variable substitution.
- ProxyJump / jump-host chains.
- Agent forwarding (opt-in per host — it's a security decision, treat it as one).
- Local shell tabs (bash/zsh/PowerShell).

**Exit criteria:** feature parity with your daily Termius/Tabby muscle memory.

### Phase 3 — SFTP (4–6 weeks)

Deceptively the biggest **UI** lift in the whole plan — a file manager is its own product.

- Dual-pane browser (local/remote), drag-and-drop, transfer queue with pause/resume/retry.
- chmod/rename/mkdir/delete, symlink handling, hidden-file toggle.
- "Edit remotely": download → watch file → auto-upload on save.
- Reuse the existing SSH session (SFTP subsystem on the same connection); optional parallel connections for throughput.

Scope cuts to resist: bookmarks, folder-sync jobs, cloud-storage backends. All post-1.0.

**Exit criteria:** a 2GB single file and a 10,000-small-files tree both transfer reliably, with resume after a forced disconnect.

### Phase 4 — Tunneling + serial/telnet (3–4 weeks)

- Local (-L), remote (-R), and dynamic SOCKS5 (-D) forwards with saved profiles, auto-start on connect, live status, port-conflict handling.
- Serial console: port autodetect, baud/parity/flow control, log-to-file.
- Telnet: minimal client (the network-gear console use case, nothing more).

**Exit criteria:** your real tunnel workflows move off the ssh CLI; a router console works over serial.

### Phase 5 — Vault & config sync (4–6 weeks)

**Recommendation: v1 ships file-based E2E sync; the sync server is post-1.0.** This keeps v1 shippable, and "sync through the folder you already own" is on-brand for the audience.

- Vault: one encrypted store (argon2id + XChaCha20-Poly1305) for hosts, snippets, and key references, unlockable via OS keychain.
- Encrypted export/import bundle.
- Sync v1: design the vault file for external file sync (Syncthing / Drive / iCloud) — deterministic serialization, per-record versioning, three-way merge on conflict with last-writer-wins per record as the fallback. Property-test the merge; sync corruption is a trust-killer you don't recover from.
- Sync server: **design only** in v1. A thin E2EE-blind relay — stores ciphertext blobs, handles device pairing, never sees plaintext. When you build it (~2–3 weeks), Rust/axum keeps the contributor story coherent; Go plays to your speed. Either works because the server is deliberately dumb.

**Exit criteria:** two machines converge through a dumb synced folder, repeatedly, without data loss — including simultaneous edits.

### Phase 6 — Packaging, polish, launch (3–4 weeks)

- Signed builds: macOS notarization, Windows via Azure Trusted Signing (avoids the EV-cert pain), Linux AppImage + deb/rpm + AUR + Flatpak.
- Tauri auto-updater with signed manifests.
- Opt-in, self-hosted crash reporting; zero default telemetry, stated prominently.
- Docs site, README with GIFs, CONTRIBUTING, issue templates, public roadmap.
- i18n scaffold from the start (en + id at minimum — cheap now, painful later).
- 2–3 week public beta → Show HN, r/selfhosted, r/commandline, lobste.rs.

**Exit criteria:** a stranger installs it on all three OSes from the website without touching a terminal.

---

## 4. Post-1.0 tracks

1. **Sync server GA** — self-hosted first; an optional hosted instance later is your sustainability lever if you ever want one (Sponsors/donations before that).
2. **Mobile** — Tauri 2 iOS/Android reusing the `core-*` crates. The terminal keyboard/UX on mobile is its own 2–3 month project; treat it as a separate milestone, not a v1.x patch.
3. **Plugin API** — only once the core is stable. This is Tabby's moat and an enormous early-scope trap.
4. Parking lot: Mosh, WSL integration, port knocking, team vaults, opt-in AI command help.

---

## 5. Cross-cutting engineering practice

- **Testing:** unit tests in core crates; integration tests against dockerized **OpenSSH and dropbear** (old and embedded servers are where SSH clients actually break); golden-file tests for the vault format; a headless-Chromium layout smoke test for the UI, because jsdom has no layout engine and cannot see a broken panel (ADR-0017); a manual release checklist for the 3-OS × auth-method grid.
- **Release rhythm:** tagged beta every 2–3 weeks from Phase 1 onward. Early users will find the Windows and Linux quirks you can't.
- **Perf budgets:** keep the Phase 0 throughput benchmark runnable in CI so regressions are visible.
- **Known platform pain:** WebKitGTK on Linux is Tauri's weak spot — rendering performance varies and Wayland has quirks. Test on Ubuntu LTS, Fedora, and Arch early; keep the xterm.js DOM renderer as a fallback (xterm 6 removed the canvas renderer) and document known issues honestly.

---

## 6. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Tauri IPC can't sustain terminal throughput | Fatal to the architecture | Phase 0 benchmark; escape hatch = wgpu terminal in Rust (big lift, so prove the cheap path first) |
| WebKitGTK inconsistencies on Linux | UX quality with your core audience | Multi-distro testing from Phase 1; canvas fallback; honest known-issues doc |
| russh edge cases (rare auth methods, no GSSAPI) | Some enterprise users blocked | Trait-abstract the transport so `ssh2` remains a fallback; document limits |
| SFTP UI scope explosion | Schedule slip | Ruthless cut list (no bookmarks/sync-jobs in v1) |
| Sync merge corrupts data | Trust-killer, project-killer | File-sync-first design, versioned format, property-based merge tests |
| Signing/notarization logistics | Launch delay | Accounts opened in Phase 0, not Phase 6 |
| Solo burnout + OSS support load | Project death | Fixed release rhythm, public roadmap, convert beta users into contributors, ruthless v1 scope |

---

## 7. Timeline summary

| Phase | Duration | Cumulative (worst case) |
|---|---|---|
| 0 — Spikes & scaffolding | 2–3 wk | 3 wk |
| 1 — Terminal core | 4–6 wk | 9 wk |
| 2 — Power features | 4–6 wk | 15 wk |
| 3 — SFTP | 4–6 wk | 21 wk |
| 4 — Tunnels + serial | 3–4 wk | 25 wk |
| 5 — Vault & sync | 4–6 wk | 31 wk |
| 6 — Package & launch | 3–4 wk | 35 wk |

**≈ 24–35 focused weeks → 6–9 months to 1.0.** If you need to compress: move serial/telnet to 1.1 (−2 wk) and ship sync as encrypted export/import only (−3 wk) → roughly 5–6 months, at the cost of two of your stated must-haves.

---

## 8. Open decisions (yours, with deadlines)

1. **Name + license** — by end of Phase 0. Apache-2.0 (contributor-friendly, patent grant, Tabby-style openness) vs GPLv3 (blocks closed forks). Relicensing after outside contributions is close to impossible.
2. **Frontend framework** — Phase 0. React recommended for your background; SolidJS if you want leaner.
3. **Sync server language** — no rush; decide when you build it post-1.0.
4. **README positioning line** — before launch; it should be the knife you use for every scope cut.
