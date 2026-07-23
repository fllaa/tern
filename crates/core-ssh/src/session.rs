//! Session lifecycle: connect, authenticate, open shell channels with a
//! backpressure-aware output pump.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use russh::ChannelWriteHalf;
use russh::client::{self, AuthResult};
use russh::keys::PublicKey;
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use tokio::sync::{mpsc, oneshot, watch};
use tracing::{debug, info, warn};

use crate::config::{AuthMethod, JumpHop, SessionConfig};
use crate::error::SshError;

/// Depth of the outbound `Bytes` queue between the pump and the consumer.
/// Bounded on purpose: it is one link in the end-to-end backpressure chain.
const OUTPUT_QUEUE_DEPTH: usize = 32;

/// How long a host-key prompt may hold a connect open before it is abandoned.
/// Generous by design — it is a human verifying a fingerprint, possibly out of
/// band — but bounded so a superseded prompt cannot leak the connect forever.
const MAX_HOST_KEY_WAIT: Duration = Duration::from_secs(180);

/// What a user must see before trusting a host key (TOFU).
#[derive(Debug, Clone)]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// Key algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// OpenSSH-style `SHA256:…` fingerprint.
    pub fingerprint_sha256: String,
    /// The key itself, so the callback can check it against `known_hosts` and
    /// record it on accept. The fingerprint alone is a display string — it
    /// cannot be written back to a `known_hosts` file.
    pub public_key: russh::keys::ssh_key::PublicKey,
}

/// Async host-key decision callback: return `true` to trust and continue.
pub type HostKeyCallback =
    Arc<dyn Fn(HostKeyInfo) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// A callback that trusts every host key. Test/rig use only — never wire this
/// into user-facing flows.
#[must_use]
pub fn accept_any_host_key() -> HostKeyCallback {
    Arc::new(|_| Box::pin(async { true }))
}

struct ClientHandler {
    host: String,
    port: u16,
    on_host_key: HostKeyCallback,
    /// Set true while the host-key callback is blocked on a human decision, so
    /// the connect timeout can tell "the network is hung" from "the user is
    /// still reading the fingerprint" and not fire on the latter.
    awaiting_user: Arc<AtomicBool>,
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let info = HostKeyInfo {
            host: self.host.clone(),
            port: self.port,
            algorithm: key.algorithm().to_string(),
            fingerprint_sha256: key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: key.clone(),
        };
        info!(
            host = %self.host,
            port = self.port,
            algorithm = %info.algorithm,
            fingerprint = %info.fingerprint_sha256,
            "host key presented; awaiting trust decision",
        );
        // The callback may block on a TOFU dialog; mark that window so the
        // connect timeout does not count the user's thinking time against it.
        self.awaiting_user.store(true, Ordering::Relaxed);
        let accepted = (self.on_host_key)(info).await;
        self.awaiting_user.store(false, Ordering::Relaxed);
        info!(host = %self.host, accepted, "host key decision received");
        Ok(accepted)
    }
}

/// An authenticated SSH session. Open shells with [`SshSession::open_shell`].
pub struct SshSession {
    handle: client::Handle<ClientHandler>,
    term: String,
    /// Intermediate jump-hop sessions, held only to keep their tunnels open.
    /// A `Handle` owns the sender to its session task; dropping it winds that
    /// task down and collapses the tunnel the next hop rides on, so the target
    /// session must outlive every hop before it. Never touched directly.
    _jumps: Vec<client::Handle<ClientHandler>>,
}

/// One dial target inside [`SshSession::connect`] — a jump hop or the final
/// target — as borrowed views into the `SessionConfig`.
struct Hop<'a> {
    host: &'a str,
    port: u16,
    username: &'a str,
    auth: &'a [AuthMethod],
}

impl<'a> Hop<'a> {
    fn from_jump(j: &'a JumpHop) -> Self {
        Self {
            host: &j.host,
            port: j.port,
            username: &j.username,
            auth: &j.auth,
        }
    }
    fn target(cfg: &'a SessionConfig) -> Self {
        Self {
            host: &cfg.host,
            port: cfg.port,
            username: &cfg.username,
            auth: &cfg.auth,
        }
    }
}

fn new_handler(
    hop: &Hop<'_>,
    on_host_key: &HostKeyCallback,
    awaiting_user: &Arc<AtomicBool>,
) -> ClientHandler {
    ClientHandler {
        host: hop.host.to_owned(),
        port: hop.port,
        on_host_key: Arc::clone(on_host_key),
        awaiting_user: Arc::clone(awaiting_user),
    }
}

/// Poll a connect future under the re-arming host-key timeout.
///
/// The timeout bounds the network handshake, not the human at the TOFU dialog:
/// when it elapses while the host-key callback is blocked on a user decision,
/// re-arm rather than fail — the user answering is what completes the connect,
/// within a re-armed window. Re-arming is capped at [`MAX_HOST_KEY_WAIT`] so an
/// abandoned prompt eventually gives up. A genuinely hung handshake never sets
/// `awaiting_user`, so it still fails at the first expiry.
///
/// Applied per hop, sharing one `awaiting_user`: hops connect sequentially, so
/// at most one host-key prompt is ever open.
async fn await_connect(
    connect: impl Future<Output = Result<client::Handle<ClientHandler>, SshError>>,
    connect_timeout: Duration,
    awaiting_user: &AtomicBool,
) -> Result<client::Handle<ClientHandler>, SshError> {
    let mut connect = std::pin::pin!(connect);
    let mut user_waited = Duration::ZERO;
    loop {
        match tokio::time::timeout(connect_timeout, &mut connect).await {
            Ok(result) => {
                return result.map_err(|e| match e {
                    SshError::Protocol(russh::Error::UnknownKey) => SshError::HostKeyRejected,
                    other => other,
                });
            }
            Err(_elapsed)
                if awaiting_user.load(Ordering::Relaxed) && user_waited < MAX_HOST_KEY_WAIT =>
            {
                user_waited = user_waited.saturating_add(connect_timeout);
                debug!(
                    waited = ?user_waited,
                    "ssh connect: timeout elapsed while awaiting host-key decision; re-arming",
                );
            }
            Err(_elapsed) => return Err(SshError::ConnectTimeout(connect_timeout)),
        }
    }
}

impl SshSession {
    /// Connect through any `ProxyJump` chain, verify each hop's host key via
    /// `on_host_key`, and authenticate at each hop.
    ///
    /// With no jumps this is a direct TCP connect to the target — the common
    /// case, and the single-hop path below. With jumps, hop 1 is dialed over
    /// TCP and every later hop (and the target) rides a direct-tcpip tunnel
    /// opened on the hop before it.
    pub async fn connect(
        cfg: SessionConfig,
        on_host_key: HostKeyCallback,
    ) -> Result<Self, SshError> {
        let config = Arc::new(client::Config {
            window_size: cfg.window_size,
            maximum_packet_size: 32 * 1024,
            channel_buffer_size: cfg.channel_buffer_size,
            keepalive_interval: cfg.keepalive_interval,
            keepalive_max: cfg.keepalive_max,
            // Nagle would add up to one RTT to every keystroke echo.
            nodelay: true,
            ..client::Config::default()
        });
        let awaiting_user = Arc::new(AtomicBool::new(false));

        // The dial order: each jump hop, then the target as the final hop. A
        // one-element chain (no jumps) is exactly the old direct connect.
        let mut chain: Vec<Hop<'_>> = cfg.jumps.iter().map(Hop::from_jump).collect();
        chain.push(Hop::target(&cfg));

        // The target chain, redacted to labels, is the single most useful line
        // when a connect misbehaves. `method_label` never emits secret material.
        let auth_chain = cfg
            .auth
            .iter()
            .map(method_label)
            .collect::<Vec<_>>()
            .join(", ");
        info!(
            host = %cfg.host,
            port = cfg.port,
            user = %cfg.username,
            hops = cfg.jumps.len(),
            connect_timeout = ?cfg.connect_timeout,
            auth_chain = %auth_chain,
            "ssh connect: opening transport",
        );

        // Hop 1 over TCP.
        let mut hops = chain.iter();
        let first = hops.next().expect("chain always ends with the target");
        let connect = client::connect(
            Arc::clone(&config),
            (first.host, first.port),
            new_handler(first, &on_host_key, &awaiting_user),
        );
        let mut prev = await_connect(connect, cfg.connect_timeout, &awaiting_user).await?;
        authenticate(&mut prev, first.username, first.auth).await?;
        debug!(host = %first.host, "ssh connect: hop authenticated");

        // Each later hop rides a tunnel opened on the previous one. The prior
        // handles are retained (see `SshSession::_jumps`) so their tunnels stay
        // up for the life of the target session.
        let mut jumps: Vec<client::Handle<ClientHandler>> = Vec::new();
        for hop in hops {
            let open = prev.channel_open_direct_tcpip(
                hop.host.to_owned(),
                u32::from(hop.port),
                "127.0.0.1",
                0,
            );
            // A black-holed tunnel should fail like a hung handshake, not hang.
            let channel = tokio::time::timeout(cfg.connect_timeout, open)
                .await
                .map_err(|_| SshError::ConnectTimeout(cfg.connect_timeout))??;
            let stream = channel.into_stream();
            jumps.push(prev);

            let connect = client::connect_stream(
                Arc::clone(&config),
                stream,
                new_handler(hop, &on_host_key, &awaiting_user),
            );
            let mut handle = await_connect(connect, cfg.connect_timeout, &awaiting_user).await?;
            authenticate(&mut handle, hop.username, hop.auth).await?;
            debug!(host = %hop.host, "ssh connect: hop authenticated");
            prev = handle;
        }

        info!(host = %cfg.host, user = %cfg.username, "ssh connect: session ready");
        // Clone `term` rather than move it: `chain` still borrows `cfg`.
        Ok(Self {
            handle: prev,
            term: cfg.term.clone(),
            _jumps: jumps,
        })
    }

    /// Whether the transport is gone.
    ///
    /// This is what separates "the remote shell exited" from "the connection
    /// died": a channel's output ends in both cases, so the exit status alone
    /// cannot tell them apart. The reconnect supervisor classifies on this.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Open an interactive shell with a PTY of the given size.
    pub async fn open_shell(&self, cols: u16, rows: u16) -> Result<ShellChannel, SshError> {
        debug!(cols, rows, term = %self.term, "shell: opening session channel");
        let channel = self.handle.channel_open_session().await?;
        let (mut read_half, write_half) = channel.split();
        write_half
            .request_pty(
                false,
                &self.term,
                u32::from(cols),
                u32::from(rows),
                0,
                0,
                &[],
            )
            .await?;
        write_half.request_shell(true).await?;
        debug!("shell: pty + shell granted");

        let (out_tx, out_rx) = mpsc::channel::<Bytes>(OUTPUT_QUEUE_DEPTH);
        let (pause_tx, mut pause_rx) = watch::channel(false);
        let (exit_tx, exit_rx) = oneshot::channel::<Option<u32>>();

        tokio::spawn(async move {
            let mut exit_code = None;
            loop {
                // Flow gate: while paused we stop consuming channel messages.
                // russh's bounded delivery buffer then fills, the session loop
                // stalls, and the SSH window drains — backpressure reaches the
                // remote process without any manual window management.
                if *pause_rx.borrow() {
                    if pause_rx.changed().await.is_err() {
                        break;
                    }
                    continue;
                }
                let msg = tokio::select! {
                    m = read_half.wait() => m,
                    _ = pause_rx.changed() => continue,
                };
                match msg {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                        if out_tx.send(Bytes::copy_from_slice(&data)).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    // Eof, Success, WindowAdjusted, …: nothing to forward.
                    Some(_) => {}
                }
            }
            let _ = exit_tx.send(exit_code);
        });

        Ok(ShellChannel {
            output: out_rx,
            write: write_half,
            pause: pause_tx,
            exit: exit_rx,
        })
    }

    /// Cleanly disconnect the whole session.
    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(Disconnect::ByApplication, "closed by user", "en")
            .await?;
        Ok(())
    }
}

/// An open interactive shell. Reads flow through a bounded queue so a stalled
/// consumer throttles the remote end (see the pump task in `open_shell`).
pub struct ShellChannel {
    output: mpsc::Receiver<Bytes>,
    write: ChannelWriteHalf<client::Msg>,
    pause: watch::Sender<bool>,
    exit: oneshot::Receiver<Option<u32>>,
}

impl ShellChannel {
    /// Next chunk of terminal output; `None` when the channel closed.
    pub async fn recv(&mut self) -> Option<Bytes> {
        self.output.recv().await
    }

    /// Send input (keystrokes) to the remote shell.
    pub async fn write(&self, data: impl Into<Bytes> + Send) -> Result<(), SshError> {
        self.write.data_bytes(data).await?;
        Ok(())
    }

    /// Propagate a terminal resize to the remote PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), SshError> {
        self.write
            .window_change(u32::from(cols), u32::from(rows), 0, 0)
            .await?;
        Ok(())
    }

    /// Stop consuming output (engages end-to-end backpressure).
    pub fn pause(&self) {
        let _ = self.pause.send(true);
    }

    /// Resume consuming output.
    pub fn resume(&self) {
        let _ = self.pause.send(false);
    }

    /// Close the channel; returns the remote exit status if the server sent one.
    pub async fn close(mut self) -> Result<Option<u32>, SshError> {
        let _ = self.write.eof().await;
        let _ = self.write.close().await;
        let drain = async {
            while self.output.recv().await.is_some() {}
            self.exit.await.unwrap_or(None)
        };
        Ok(tokio::time::timeout(Duration::from_secs(5), drain)
            .await
            .unwrap_or(None))
    }
}

/// Work through the configured auth methods in order, stopping at the first
/// that succeeds.
///
/// Two things make this more than a loop.
///
/// A method the server has already said it will not accept is skipped rather
/// than attempted. Every attempt counts against the server's `MaxAuthTries`
/// (6 by default), so spending one on a method that cannot succeed can deny a
/// later, viable method its turn — a chain of agent-then-key-then-password
/// against a `PasswordAuthentication no` server should not burn a try proving
/// what the server already told us.
///
/// A local failure — no agent running, an unreadable key file — does not end
/// the chain. That is the entire point of a fallback: "the agent isn't up, use
/// the password" is the case being served.
async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    auth: &[AuthMethod],
) -> Result<(), SshError> {
    // What the server still offers, once it has told us. `None` means it has
    // not yet, so nothing is skipped on the first attempt.
    let mut offered: Option<MethodSet> = None;
    let mut attempts: Vec<String> = Vec::new();

    for method in auth {
        let label = method_label(method);

        // Deliberately conservative: skip only against a non-empty list. The
        // two mistakes are not symmetric — wrongly skipping breaks a config
        // that would have worked, while wrongly attempting costs one auth try.
        // An empty list carries no information worth breaking a login over.
        if let Some(remaining) = &offered
            && !remaining.is_empty()
            && !remaining.contains(&method_kind(method))
        {
            debug!(method = %label, "auth: skipped — server did not offer it");
            attempts.push(format!("{label}: not offered by server"));
            continue;
        }

        debug!(method = %label, "auth: attempting");
        match try_method(handle, user, method).await {
            Ok(AuthResult::Success) => {
                info!(method = %label, "auth: accepted");
                return Ok(());
            }
            Ok(AuthResult::Failure {
                remaining_methods, ..
            }) => {
                debug!(method = %label, "auth: rejected by server");
                attempts.push(format!("{label}: rejected"));
                offered = Some(remaining_methods);
            }
            // Never reached the server; the next method may still work.
            Err(e) => {
                debug!(method = %label, error = %e, "auth: could not attempt — trying next");
                attempts.push(format!("{label}: {e}"));
            }
        }
    }

    let detail = if attempts.is_empty() {
        "no authentication methods configured".to_owned()
    } else {
        attempts.join("; ")
    };
    warn!(detail = %detail, "auth: no method succeeded");
    Err(SshError::AuthFailed(detail))
}

/// Attempt a single method.
///
/// `Ok` carries the server's verdict. `Err` means the attempt never reached the
/// server — a missing key file, an agent that is not running — which the caller
/// treats as "try the next one" rather than as a failed authentication.
async fn try_method(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
    method: &AuthMethod,
) -> Result<AuthResult, SshError> {
    match method {
        AuthMethod::Password(password) => {
            // russh takes an owned String it does not zeroize, so the plain
            // copy is created here — at the last possible moment — rather than
            // being held anywhere with a longer life.
            Ok(handle
                .authenticate_password(user.to_owned(), password.as_str().to_owned())
                .await?)
        }
        AuthMethod::KeyFile { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_ref().map(|p| p.as_str()))
                .map_err(|e| SshError::KeyLoad(e.to_string()))?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            Ok(handle
                .authenticate_publickey(
                    user.to_owned(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await?)
        }
        AuthMethod::Agent => authenticate_with_agent(handle, user).await,
    }
}

/// Which SSH method a configured auth uses, for comparison against what the
/// server offers. Agent and key file are both `publickey` on the wire.
fn method_kind(method: &AuthMethod) -> MethodKind {
    match method {
        AuthMethod::Password(_) => MethodKind::Password,
        AuthMethod::KeyFile { .. } | AuthMethod::Agent => MethodKind::PublicKey,
    }
}

/// Short name for the aggregated failure message. Carries the key path, which
/// is what makes "which of my three keys failed?" answerable; never a secret.
fn method_label(method: &AuthMethod) -> String {
    match method {
        AuthMethod::Password(_) => "password".to_owned(),
        AuthMethod::KeyFile { path, .. } => format!("key {}", path.display()),
        AuthMethod::Agent => "agent".to_owned(),
    }
}

/// An agent connection with its transport type erased.
///
/// The platform connectors return three unrelated concrete types — a unix
/// socket, a Windows named pipe, and Pageant's shared-memory stream — so
/// without this the identity loop below would have to be written three times.
/// `AgentClient::dynamic` boxes the stream, which is what russh provides it for.
type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[cfg(unix)]
async fn connect_agent() -> Result<DynAgent, SshError> {
    AgentClient::connect_env()
        .await
        .map(AgentClient::dynamic)
        .map_err(|e| SshError::Agent(e.to_string()))
}

/// Windows has two agents in common use and no environment variable to pick
/// between them, so both are tried in turn.
///
/// OpenSSH's comes first: it ships in-box on Windows 10+ and is what `ssh-add`
/// talks to by default. Pageant is `PuTTY`'s, and remains widely used by anyone
/// who arrived from `PuTTY` — which, for an SSH client, is a lot of people.
///
/// A failure here reports *both* attempts. "No ssh-agent" with no further
/// detail is unactionable on a platform where the answer is usually "the
/// service is not running" for one of two different services.
#[cfg(windows)]
async fn connect_agent() -> Result<DynAgent, SshError> {
    /// Fixed path for the OpenSSH agent service; not configurable in OpenSSH
    /// for Windows, so hardcoding it is correct rather than lazy.
    const OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

    let openssh = match AgentClient::connect_named_pipe(OPENSSH_PIPE).await {
        Ok(agent) => return Ok(agent.dynamic()),
        Err(e) => e,
    };
    match AgentClient::connect_pageant().await {
        Ok(agent) => Ok(agent.dynamic()),
        Err(pageant) => Err(SshError::Agent(format!(
            "no ssh-agent reachable: OpenSSH named pipe ({openssh}); Pageant ({pageant})"
        ))),
    }
}

#[cfg(not(any(unix, windows)))]
async fn connect_agent() -> Result<DynAgent, SshError> {
    Err(SshError::Agent(
        "ssh-agent auth is not supported on this platform".into(),
    ))
}

/// Offer every identity the agent holds, in the order the agent lists them.
///
/// Returns the server's verdict on the last identity tried, so the caller can
/// read `remaining_methods` off it and skip methods the server has ruled out.
/// An agent that is absent, empty, or holds nothing usable is an `Err` — the
/// server never saw an attempt, and the next method in the chain should run.
async fn authenticate_with_agent(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
) -> Result<AuthResult, SshError> {
    debug!("agent: connecting");
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Agent(e.to_string()))?;
    debug!(count = identities.len(), "agent: identities loaded");
    if identities.is_empty() {
        return Err(SshError::Agent("no identities loaded".into()));
    }
    let hash = handle.best_supported_rsa_hash().await?.flatten();

    let mut last = None;
    let mut last_error = String::from("no usable identities");
    for identity in identities {
        let key: PublicKey = match identity {
            AgentIdentity::PublicKey { key, .. } => key,
            // Certificate auth: Phase 1+.
            AgentIdentity::Certificate { .. } => continue,
        };
        let alg = key.algorithm().to_string();
        match handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(AuthResult::Success),
            Ok(failure) => last = Some(failure),
            Err(e) => last_error = format!("{alg}: {e:?}"),
        }
    }
    // A rejection is the server's answer and carries `remaining_methods`;
    // having never got one means no identity reached it at all.
    last.ok_or_else(|| SshError::Agent(last_error))
}

/// Read side of a split [`ShellChannel`] — owned by the output pump.
pub struct ShellOutput {
    output: mpsc::Receiver<Bytes>,
    exit: oneshot::Receiver<Option<u32>>,
}

impl ShellOutput {
    /// Next chunk of terminal output; `None` when the channel closed.
    pub async fn recv(&mut self) -> Option<Bytes> {
        self.output.recv().await
    }

    /// After `recv` returns `None`, the exit status if the server sent one.
    pub async fn exit_status(self) -> Option<u32> {
        self.exit.await.unwrap_or(None)
    }
}

/// Cloneable control side of a split [`ShellChannel`].
#[derive(Clone)]
pub struct ShellControl {
    write: Arc<ChannelWriteHalf<client::Msg>>,
    pause: watch::Sender<bool>,
}

impl ShellControl {
    /// Send input (keystrokes) to the remote shell.
    pub async fn write(&self, data: impl Into<Bytes> + Send) -> Result<(), SshError> {
        self.write.data_bytes(data).await?;
        Ok(())
    }

    /// Propagate a terminal resize to the remote PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), SshError> {
        self.write
            .window_change(u32::from(cols), u32::from(rows), 0, 0)
            .await?;
        Ok(())
    }

    /// Stop consuming output (engages end-to-end backpressure).
    pub fn pause(&self) {
        let _ = self.pause.send(true);
    }

    /// Resume consuming output.
    pub fn resume(&self) {
        let _ = self.pause.send(false);
    }

    /// Ask the server to close the channel; the output side observes `Close`.
    pub async fn close(&self) -> Result<(), SshError> {
        let _ = self.write.eof().await;
        self.write.close().await?;
        Ok(())
    }
}

impl ShellChannel {
    /// Split into an owned read half and a cloneable control half, so a pump
    /// task can own the output while commands write/resize/pause concurrently.
    #[must_use]
    pub fn split(self) -> (ShellOutput, ShellControl) {
        (
            ShellOutput {
                output: self.output,
                exit: self.exit,
            },
            ShellControl {
                write: Arc::new(self.write),
                pause: self.pause,
            },
        )
    }
}
