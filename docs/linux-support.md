# Linux support

Tern targets Linux as a first-class desktop platform via Tauri 2 (WebKitGTK).
CI exercises the Linux path on every push; the parts that vary by distro or by
graphics stack need a human on real hardware, and this is the checklist for
that pass.

## What CI already covers (ubuntu-24.04)

- `clippy --workspace --all-targets` and the full test suite, run under a
  session D-Bus with an unlocked gnome-keyring — so the Secret Service
  credential round-trip runs for real, not skipped.
- The rig integration suite (OpenSSH, dropbear, publickey-only OpenSSH) against
  real servers.
- The UI unit suite and the headless-Chromium layout tier.

CI does **not** cover: distros other than Ubuntu, the WebKitGTK renderer path
(Playwright drives Chromium, not WebKitGTK), or a packaged bundle. Those are
the manual pass below.

## Graceful degradation the code guarantees

These are designed-in, so a distro missing a capability degrades rather than
breaks — but each should still be *seen* working on the pass:

- **No WebGL** (some WebKitGTK builds ship without a usable GL context): the
  terminal falls back to xterm's DOM renderer. `terminal/pool.ts` catches the
  WebGL load failure and sets `renderer: "dom"`; correctness never depends on
  which renderer is active. Verify: a terminal still renders and scrolls.
- **No Secret Service** (headless, a bare WM, no `gnome-keyring`/`kwallet`
  running): the keyring probe fails and a persistent banner says credentials
  cannot be saved; passwords and passphrases are asked for each time instead of
  silently dropped. Verify: the banner appears, and a password host still
  connects by prompting.
- **Self-hosted fonts**: JetBrains Mono is bundled, not taken from the system,
  so the terminal looks the same on a minimal distro with no monospace fonts
  installed. Verify: the default terminal font is JetBrains Mono, not a
  fallback.
- **App shortcuts avoid readline**: the palette and search use Ctrl+Shift+K/F
  on Linux, never bare Ctrl, so Ctrl+K (kill-line), Ctrl+R (reverse-search) and
  friends still reach the shell. Verify: Ctrl+K in a shell kills to end of line;
  Ctrl+Shift+K opens the palette.

## Manual distro checklist

Run on at least one distro from each family — the WebKitGTK and libssl versions
differ enough between them to matter:

- **Debian/Ubuntu** (apt, WebKitGTK 4.1)
- **Fedora** (dnf, often a newer WebKitGTK)
- **Arch** (rolling, newest of everything)

On each:

1. **Launch**: the app starts and the window renders (WebKitGTK found).
2. **Connect**: a saved host connects; the terminal renders and echoes.
3. **Renderer**: confirm which renderer is active (WebGL where available, DOM
   fallback otherwise) and that both scroll cleanly under `cat` of a large file.
4. **Keyring**: with a Secret Service running, a saved password persists across
   a restart (visible in seahorse/kwalletmanager); with none running, the
   degraded banner shows and prompting still works.
5. **ssh-agent**: an agent-auth host works against `$SSH_AUTH_SOCK`.
6. **Reconnect**: drop the link (e.g. `nmcli`/`ip link` toggle) and confirm the
   session reconnects, or shows the Reconnect control after giving up.
7. **Appearance**: light/dark/system all apply; "system" tracks the desktop's
   colour-scheme setting; a terminal scheme and font-size change take effect.
8. **Clipboard**: copy-on-select and paste (Ctrl+Shift+V) work under the
   distro's clipboard manager; the multi-line paste warning appears.
9. **Shortcuts**: Ctrl+Shift+K (palette) and Ctrl+Shift+F (search) open; bare
   Ctrl chords still reach the shell.

## Not yet automated

A packaged Linux build (AppImage/deb) is not produced in CI — that belongs to
the release workflow, which does not exist yet (no `v*` tags). Until it does,
the bundle is built and smoke-tested by hand as part of this pass.
