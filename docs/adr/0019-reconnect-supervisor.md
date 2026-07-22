# ADR-0019: A Rust-side reconnect supervisor that swaps the transport in place

- Status: Accepted
- Date: 2026-07-21

## Context

A session must survive a dropped transport — a flapping VPN, a roaming laptop,
a rebooted jump box — and come back on its own. The `Disconnected` event and
`SshError::is_retryable` had existed since M1 with nothing consuming them; M4
is the consumer. The design question is *where* the reconnect loop lives, and
what it does to the session identity the rest of the app is built on.

The awkward fact a terminal reconnect has to face: SSH cannot resume a PTY.
Reconnecting means a *new* shell to the same host, its output appended after
the old scrollback. So a reconnect is never transparent to the remote side —
the question is only whether it is transparent to *our* side: the session id,
the data channel, the terminal, the flow-control state.

Two homes were possible. A **webview supervisor** would treat `disconnected`
as a signal, wait, and call `open_session` again — a brand-new Rust session
bound to the same terminal. A **Rust supervisor** would own the connection for
its whole life and swap the transport underneath a stable session id.

## Decision

The supervisor lives in **Rust and owns the connection**; a reconnect swaps the
transport inside a shared `Conn` cell while the session id, the data channel,
and the webview's terminal stay put. The webview learns a reconnect happened
only from events (`Reconnecting` → `Connected`, or `Disconnected` when it gives
up); it never rebinds anything.

Three things drove it there:

- **Retryability stays authoritative.** The decision not to retry a wrong
  password (an account-lockout generator) or a changed host key (a security
  event, not noise) is `SshError::is_retryable`, in Rust. A webview supervisor
  would have to reconstruct that from a stringified error crossing IPC, or have
  it re-emitted as a flag — either way, re-deriving a judgement that already
  exists, one wrong guess away from hammering a locked account.
- **The session identity is load-bearing.** Flow control, pause/resume, write
  and resize all key off the session id. Keeping it stable across a reconnect
  means none of that has to be re-plumbed, and scrollback survives because the
  terminal is never touched. A new-session-per-reconnect design churns the id
  and leaks the old Rust `LiveSession` until something remembers to close it.
- **It genuinely is a supervisor.** A task that owns a resource for its life,
  observes failure, and re-establishes it is the shape the dev plan named.

The risky logic is quarantined from the async wiring. The **decisions** —
exponential backoff with full jitter, the attempt cap, retry-or-give-up given
`is_retryable` — are a pure module (`reconnect.rs`) with eleven tests covering
saturation, jitter bounds, and the give-up conditions. The **supervisor** is a
thin async driver that calls those decisions, sleeps, and reconnects. Full
jitter rather than none is deliberate: it desynchronises a fleet that all
dropped at once so recovery is not a thundering herd.

Alternatives considered:

- **Webview supervisor (reconnect = new session, rebind terminal).** Rejected
  for the three reasons above. It is less Rust code, but it moves the
  retryability judgement to the weakest place to make it and churns the session
  identity the rest of the app leans on.
- **A single `MaxAuthTries`-blind retry loop.** Rejected — see ADR-0018; the
  chain-level skip and the reconnect-level backoff are the same discipline
  applied at two scales.
- **Making the supervisor loop generic to unit-test it end to end.** Rejected
  for now. The loop is bound to `tauri::ipc::Channel` and core-ssh session
  types; abstracting them behind traits to inject fakes is a large investment
  for a driver whose every *decision* is already tested in isolation. The gap
  is logged in Consequences.

## Consequences

- Good: a dropped saved-host session reconnects on its own, with backoff and
  jitter, bounded by a per-host-or-global attempt cap, and stops on a
  non-retryable failure. Scrollback and the session id survive; the terminal
  and data channel never rebind.
- Good: each attempt re-resolves the credential from the keyring and re-reads
  the host record, so a secret revoked or a host edited mid-outage is honoured
  rather than reconnected with a stale copy; a host deleted mid-outage is a
  non-retryable stop.
- Good: the state is visible. `Reconnecting` carries attempt/ceiling/delay for
  a live countdown, and a given-up session shows a Reconnect control rather
  than a frozen black terminal — the failure mode "survive the day" exists to
  kill.
- Bad / accepted cost: the async supervisor loop itself has no automated
  end-to-end test. Its decisions are unit-tested and its data path is confirmed
  by the throughput bench, but "drop the transport, watch it come back" needs
  the running app and a forced disconnect. This is the same command-layer
  testing gap the whole `commands.rs` shares, widened by one loop; closing it
  means either a Tauri test harness or a generic, fake-injectable supervisor.
- Bad / accepted cost: `LiveSession` grew a `Mutex`-guarded, swappable `Conn`
  and every session command now clones the control out under a brief lock
  instead of reading a plain field. The lock is uncontended in practice (a
  reconnect swap is rare and brief), but it is real surface that did not exist.
- Bad / accepted cost: a new `getrandom` dependency in the desktop crate for
  the jitter. Already vetted via core-ssh at the same version, so no new
  cargo-deny surface, but it is one more direct dependency.
- Revisit when: a Tauri integration harness exists (add the end-to-end
  reconnect test), or ProxyJump lands (a jump-host chain changes what
  "reconnect" re-establishes and may move some of this into core-ssh).
