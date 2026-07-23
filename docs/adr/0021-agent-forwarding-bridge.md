# ADR-0021: Agent forwarding is a hand-written channel bridge, opt-in per host

- Status: Accepted
- Date: 2026-07-23

## Context

Phase 2 finishes with agent forwarding: the remote host can use the local
ssh-agent to authenticate onward, so `git pull` on a jump target works without
a key ever living on that machine.

Two things forced design decisions rather than wiring.

**russh does not implement it.** `client::Handler` has a
`server_channel_open_agent_forward` hook whose default body accepts the channel
and immediately drops it. That is a *silent* failure: the client side looks
correct, `SSH_AUTH_SOCK` is set on the remote, and only `ssh-add` on the far end
reveals that the socket answers with EOF. Everything below the hook — the
signing protocol, the channel plumbing — is ours to build.

**It delegates authority.** A forwarded agent is not a copy of the key; it is a
live oracle that signs on request. For as long as the session is up, anyone who
can reach the socket on the remote — root, or any process running as the same
user — can authenticate as the user anywhere those keys are trusted. This is
the one setting in Tern where being wrong in the permissive direction is a
security incident rather than an annoyance.

## Decision

**The bridge is a byte pipe, spawned per channel.** The handler dials the local
agent, `reply.accept()`s, and `tokio::spawn`s a detached
`copy_bidirectional(channel.into_stream(), agent)`. The agent protocol is never
parsed, logged, or cached — the remote's agent client and the local agent talk
to each other and we are the wire. Spawning is required, not stylistic: the
handler runs *inside* the session loop, so copying inline would stall every
other channel for the length of each signing request.

The agent is dialed *before* accepting, so a missing agent produces a clean
`ConnectFailed` rejection rather than a channel that opens and then dies. That
awaits inside the session loop, but only on a local socket connect.

Forwarding needs a raw stream — `tokio::net::UnixStream` on unix, the OpenSSH
named pipe on Windows — which is deliberately *not* the `AgentClient` used for
our own authentication. That one speaks the protocol; this one must not.

**Off by default, per host, with no global.** `SessionConfig.forward_agent` is
`false` from `new()`. The store column is nullable and NULL reads as **off**,
which is the one place the overrides block breaks its own convention: its
neighbours treat NULL as "inherit the global default". There is no global here
and no plan for one — a setting that could switch forwarding on for every host
at once is the shape of mistake worth designing out. `session_cfg::for_host`
therefore uses `unwrap_or(false)` rather than the `if let Some` pattern beside
it.

**Only the final target, never a jump hop.** `Hop::from_jump` hardcodes
`forward_agent: false`. A bastion is the host most exposed to the internet and
the one you least want holding a handle on your agent, and the chain reaches the
target without it.

**An unrequested channel is refused.** The handler rejects with
`AdministrativelyProhibited` when the flag is off. This is defense in depth: we
only *request* forwarding for a host that opted in, but a hostile or compromised
server can open the channel regardless, and the default russh behaviour would
accept it.

## Consequences

- Good: the rig test drives the whole loop — `ssh-add` on the remote reaches the
  local agent and its answer returns the same way. It asserts on what `ssh-add`
  *says*, not its exit code, because the accept-then-drop bug also exits 1;
  mutating the bridge to drop the channel makes the test fail, which is how we
  know it tests the bridge and not just the request.
- Good: the negative control asserts a non-opted-in session gets no agent socket
  on the remote at all, so the opt-in cannot rot into decoration.
- Good: `ForwardAgent` had been parsed from `~/.ssh/config` since Phase 1 and
  dropped on the floor; it now reaches the imported host. A config the user
  wrote saying `ForwardAgent yes` is them asking for it, and their plain `ssh`
  already behaves that way — diverging would be the surprising direction.
- Bad / accepted cost: **Pageant cannot be forwarded.** Its transport is shared
  memory, not a byte stream, so there is nothing to copy. Pageant *auth* is
  unaffected (russh implements that transport); only forwarding is unavailable,
  and the error says so rather than reporting a generic missing agent.
- Bad / accepted cost: forwarding is all-or-nothing for the session's lifetime.
  There is no confirmation-per-signature (OpenSSH's `ssh-add -c`), no
  time-limited forwarding, and no per-request audit line — the bridge cannot
  offer any of these without parsing the protocol it deliberately does not read.
  A user who wants confirmation should add their keys with `ssh-add -c` locally,
  where the agent itself enforces it.
- Revisit when: certificate auth lands (Phase 1+ deferred it) and the agent
  vocabulary grows, or if per-signature confirmation is wanted badly enough to
  justify a protocol-aware bridge.
