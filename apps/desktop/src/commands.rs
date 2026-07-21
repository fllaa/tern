//! Tauri command layer: thin wiring between the webview and the core crates.
//!
//! Terminal bytes ride `Channel<InvokeResponseBody>` as raw frames (never
//! JSON); everything else is `tern-proto` serde types. The desktop-side pump
//! is gated by a pause watch because `Channel::send` never blocks — without
//! the gate, a slow webview would grow the channel queue without bound
//! instead of propagating backpressure.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use tern_core_pty::{LocalPty, PtyConfig, PtyControl};
use tern_core_ssh::{
    AuthMethod, HostKeyCallback, HostKeyVerdict, KnownHostsFile, SessionConfig, ShellControl,
    ShellOutput, SshError, SshSession, accept_any_host_key,
};
use tern_core_store::Store;
use tern_proto::{
    AuthMethodDto, AutoBenchCfg, BenchReport, OpenSessionReq, ResizeReq, SessionEvent, SessionId,
    StreamStatsDto, Target,
};
use tern_term_stream::{CoalescerConfig, StreamStats, coalesce};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tracing::{debug, info, warn};

use crate::reconnect::{Backoff, Decision, PumpEnd, ReconnectPolicy};

const QUEUE_DEPTH: usize = 32;

#[derive(Clone)]
enum Control {
    Ssh(ShellControl),
    Pty(PtyControl),
}

/// The live transport, swapped in place by the reconnect supervisor.
///
/// Behind a `Mutex` because a reconnect replaces both the control handle and
/// the session it belongs to while `write_session` / `resize_session` may be
/// reading them. `Control` is cheap to clone (an `Arc` inside), so callers
/// clone it out under a brief lock rather than holding the lock across a write.
struct Conn {
    control: Control,
    /// Keeps the russh handle (and thus the connection) alive. `None` for PTY.
    /// Swapped on reconnect so the old connection can drop. Never read — its
    /// only job is to own the session for as long as the control does.
    #[allow(dead_code)]
    keepalive: Option<Arc<SshSession>>,
}

/// Last-known terminal size, so a reconnected shell opens at the right size
/// rather than the size the session first started at. Updated by
/// `resize_session`, read by the supervisor.
struct Dims {
    cols: AtomicU16,
    rows: AtomicU16,
}

impl Dims {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols: AtomicU16::new(cols),
            rows: AtomicU16::new(rows),
        }
    }
    fn set(&self, cols: u16, rows: u16) {
        self.cols.store(cols, Ordering::Relaxed);
        self.rows.store(rows, Ordering::Relaxed);
    }
    fn get(&self) -> (u16, u16) {
        (
            self.cols.load(Ordering::Relaxed),
            self.rows.load(Ordering::Relaxed),
        )
    }
}

struct LiveSession {
    conn: Arc<Mutex<Conn>>,
    dims: Arc<Dims>,
    /// Set true when the user closes the tab, so the supervisor stops trying to
    /// reconnect instead of fighting the close.
    shutdown: watch::Sender<bool>,
    /// Gates the desktop→webview sender task.
    desktop_pause: watch::Sender<bool>,
    stats: Arc<StreamStats>,
    stats_epoch: std::sync::Mutex<Instant>,
    paused_since: std::sync::Mutex<Option<Instant>>,
}

impl LiveSession {
    /// The current control handle, cloned out so the caller never holds the
    /// `conn` lock across an `await`.
    async fn control(&self) -> Control {
        self.conn.lock().await.control.clone()
    }
}

pub struct AppState {
    sessions: Mutex<HashMap<String, Arc<LiveSession>>>,
    pending_host_keys: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    next_id: AtomicU64,
    store: Store,
    /// Tern's own `known_hosts`. Never `~/.ssh/known_hosts` (ADR-0013).
    known_hosts_path: PathBuf,
}

impl AppState {
    /// Built in Tauri's `setup` hook rather than derived, because the paths
    /// come from the app's path resolver. Keeping resolution out of
    /// `core-store` is what lets that crate stay `tauri`-free and makes its
    /// in-memory test constructor equivalent.
    pub fn new(store: Store, known_hosts_path: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_host_keys: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            store,
            known_hosts_path,
        }
    }

    /// A cheap clone — `Store` is an `Arc` inside.
    pub fn store(&self) -> Store {
        self.store.clone()
    }

    pub fn known_hosts_path(&self) -> PathBuf {
        self.known_hosts_path.clone()
    }

    async fn session(&self, id: &str) -> Result<Arc<LiveSession>, String> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown session {id}"))
    }
}

/// Map the wire DTO onto the transport's auth type.
///
/// This is the boundary where a credential that arrived over IPC becomes a
/// zeroizing `Secret`. For saved hosts the plaintext should never reach here
/// at all — the Rust side resolves it from the keyring instead.
fn auth_from_dto(dto: AuthMethodDto) -> AuthMethod {
    match dto {
        AuthMethodDto::Password { password } => AuthMethod::password(password),
        AuthMethodDto::KeyFile { path, passphrase } => AuthMethod::key_file(path, passphrase),
        AuthMethodDto::Agent => AuthMethod::Agent,
    }
}

/// Spawn the shared tail of the data path:
/// transport output -> coalescer -> gated sender -> webview channel.
fn spawn_data_path(
    coalescer_cfg: CoalescerConfig,
    stats: Arc<StreamStats>,
    data: Channel<InvokeResponseBody>,
) -> (mpsc::Sender<Bytes>, watch::Sender<bool>) {
    let (in_tx, in_rx) = mpsc::channel::<Bytes>(QUEUE_DEPTH);
    let (frame_tx, mut frame_rx) = mpsc::channel::<Bytes>(QUEUE_DEPTH);
    let (pause_tx, mut pause_rx) = watch::channel(false);

    tokio::spawn(coalesce(in_rx, frame_tx, coalescer_cfg, stats));

    tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            while *pause_rx.borrow() {
                if pause_rx.changed().await.is_err() {
                    return;
                }
            }
            if data.send(InvokeResponseBody::Raw(frame.to_vec())).is_err() {
                break;
            }
        }
    });

    (in_tx, pause_tx)
}

/// Host-key trust: consult Tern's `known_hosts`, then TOFU only for a genuinely
/// unknown key.
///
/// Four outcomes, and keeping them distinct is the whole point:
///
/// * `Trusted`  — connect silently. The common case; a client that prompts
///   every time trains users to accept without reading.
/// * `Unknown`  — first contact. Emit `HostKeyPrompt` and block until the
///   webview answers; on accept, record the key.
/// * `Changed`  — refuse, and emit `HostKeyChanged` carrying both fingerprints
///   so the UI can show expected vs offered. Never an "accept?" prompt.
/// * `Revoked`  — refuse. The key is on file as `@revoked`.
///
/// The callback signature returns a bare bool, so the *reason* for a refusal
/// cannot travel through the return value — hence emitting the detail on the
/// events channel just before returning false.
fn host_key_prompt(
    insecure_accept: bool,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    events: Channel<SessionEvent>,
    session_id: String,
    known_hosts_path: PathBuf,
    hash_new_entries: bool,
) -> HostKeyCallback {
    if insecure_accept {
        // Rig and benchmark runs only; the product UI never sets this.
        return accept_any_host_key();
    }
    Arc::new(move |info| {
        let pending = Arc::clone(&pending);
        let ev = events.clone();
        let sid = session_id.clone();
        let path = known_hosts_path.clone();
        Box::pin(async move {
            let file = KnownHostsFile::at(&path);
            let verdict = match file.verify(&info.host, info.port, &info.public_key) {
                Ok(v) => v,
                Err(e) => {
                    // An unreadable known_hosts must not silently downgrade to
                    // "trust anything".
                    let _ = ev.send(SessionEvent::Error {
                        message: format!("could not read known_hosts: {e}"),
                    });
                    return false;
                }
            };

            match verdict {
                HostKeyVerdict::Trusted => {
                    debug!(host = %info.host, port = info.port, "host key: known and trusted");
                    true
                }
                HostKeyVerdict::Revoked { line } => {
                    warn!(host = %info.host, port = info.port, "host key: revoked — refusing");
                    let _ = ev.send(SessionEvent::HostKeyRevoked {
                        host: info.host.clone(),
                        port: info.port,
                        known_hosts_path: path.display().to_string(),
                        known_hosts_line: line,
                    });
                    false
                }
                HostKeyVerdict::Changed {
                    line,
                    recorded_algorithm,
                    recorded_fingerprint,
                } => {
                    warn!(host = %info.host, port = info.port, "host key: changed — refusing");
                    let _ = ev.send(SessionEvent::HostKeyChanged {
                        host: info.host.clone(),
                        port: info.port,
                        algorithm: recorded_algorithm,
                        recorded_fingerprint,
                        presented_fingerprint: info.fingerprint_sha256.clone(),
                        known_hosts_path: path.display().to_string(),
                        known_hosts_line: line,
                    });
                    false
                }
                HostKeyVerdict::Unknown => {
                    info!(
                        host = %info.host,
                        port = info.port,
                        fingerprint = %info.fingerprint_sha256,
                        "host key: first contact — prompting user",
                    );
                    let (tx, rx) = oneshot::channel();
                    pending.lock().await.insert(sid, tx);
                    let _ = ev.send(SessionEvent::HostKeyPrompt {
                        host: info.host.clone(),
                        port: info.port,
                        algorithm: info.algorithm.clone(),
                        fingerprint_sha256: info.fingerprint_sha256.clone(),
                    });
                    // A dropped sender (webview closed mid-prompt) resolves to
                    // "no" rather than trusting by default.
                    let accepted = rx.await.unwrap_or(false);
                    if accepted
                        && let Err(e) =
                            file.learn(&info.host, info.port, &info.public_key, hash_new_entries)
                    {
                        // Trust was granted for this session; failing to
                        // persist it means the next connect asks again, which
                        // is the safe direction to fail.
                        let _ = ev.send(SessionEvent::Error {
                            message: format!("could not record host key: {e}"),
                        });
                    }
                    accepted
                }
            }
        })
    })
}

fn millis_u64(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

fn coalescer_cfg(req: &OpenSessionReq) -> CoalescerConfig {
    CoalescerConfig {
        max_frame: req.chunk_max.unwrap_or(128 * 1024) as usize,
        tick: Duration::from_millis(u64::from(req.tick_ms.unwrap_or(8))),
    }
}

/// The transport pieces produced by one (re)connect.
struct Established {
    out: ShellOutput,
    control: ShellControl,
    ssh: Arc<SshSession>,
}

/// Why a reconnect attempt failed, and whether another attempt could help.
///
/// Its own type rather than `SshError` because a reconnect can fail before it
/// ever reaches SSH — the host was deleted mid-outage, the store is unreadable
/// — and those are non-retryable for reasons `SshError` has no variant for.
struct ReconnectError {
    retryable: bool,
    message: String,
}

impl From<SshError> for ReconnectError {
    fn from(e: SshError) -> Self {
        Self {
            retryable: e.is_retryable(),
            message: e.to_string(),
        }
    }
}

/// Re-establishes a saved host's connection for the supervisor.
///
/// A boxed async closure over *owned* state — the supervisor outlives the
/// command that spawned it, so it cannot borrow `State`. Each call re-resolves
/// the credential from the keyring (a password revoked mid-outage makes the
/// next attempt fail loudly rather than reconnect with a stale copy) and opens
/// a shell at the given size.
type Reconnector = Box<
    dyn Fn(u16, u16) -> Pin<Box<dyn Future<Output = Result<Established, ReconnectError>> + Send>>
        + Send
        + Sync,
>;

/// A jitter fraction in `[0, 1)` from the OS RNG.
///
/// On the vanishingly unlikely RNG failure it returns 0.0 — no jitter, which
/// only removes the herd-desynchronisation and cannot break the backoff itself.
#[allow(clippy::cast_precision_loss)] // the >>11 keeps the value within f64's 53-bit mantissa
fn rand01() -> f64 {
    let mut buf = [0u8; 8];
    if getrandom::fill(&mut buf).is_err() {
        return 0.0;
    }
    // Top 53 bits -> a uniform double in [0, 1), the usual construction.
    ((u64::from_le_bytes(buf) >> 11) as f64) / ((1u64 << 53) as f64)
}

/// Supervise one SSH session for its whole life: pump its output, and on a
/// transport drop, reconnect with backoff until it comes back or the policy
/// gives up.
///
/// The session id and the webview's terminal are untouched across a reconnect —
/// only the transport inside `conn` is swapped — so scrollback survives and the
/// data channel never rebinds. `Connected` marks a successful reconnect,
/// `Disconnected` the point where the supervisor gives up.
#[allow(clippy::too_many_arguments)] // distinct pieces of one session's state
async fn supervise(
    mut out: ShellOutput,
    mut ssh: Arc<SshSession>,
    in_tx: mpsc::Sender<Bytes>,
    events: Channel<SessionEvent>,
    conn: Arc<Mutex<Conn>>,
    dims: Arc<Dims>,
    mut shutdown: watch::Receiver<bool>,
    desktop_pause: watch::Sender<bool>,
    policy: ReconnectPolicy,
    reconnector: Option<Reconnector>,
) {
    loop {
        // Pump this generation until its channel ends or the tab closes.
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => return,
                chunk = out.recv() => match chunk {
                    Some(c) => {
                        if in_tx.send(c).await.is_err() {
                            return; // the desktop sender is gone; nothing to feed
                        }
                    }
                    None => break,
                },
            }
        }
        if *shutdown.borrow() {
            return;
        }

        // A closed transport with no exit status is a drop; a status is a clean
        // exit; neither with an open transport is a shell that ended quietly.
        let end = match out.exit_status().await {
            Some(code) => PumpEnd::Exited(Some(code)),
            None if ssh.is_closed() => PumpEnd::Dropped,
            None => PumpEnd::Exited(None),
        };

        if let PumpEnd::Exited(code) = end {
            let _ = events.send(SessionEvent::Exited { code });
            return;
        }

        // A dropped transport. Without a reconnector (ad-hoc / local targets)
        // this is terminal, exactly as before reconnect existed.
        let Some(reconnector) = reconnector.as_ref() else {
            let _ = events.send(SessionEvent::Disconnected {
                reason: "connection lost".into(),
            });
            return;
        };

        let mut reason = String::from("connection lost");
        let mut decision = policy.decide(PumpEnd::Dropped, 1, rand01());
        let established = loop {
            let (attempt, delay) = match decision {
                Decision::Reconnect { attempt, delay } => (attempt, delay),
                Decision::GiveUp => {
                    warn!(reason = %reason, "supervise: giving up — reconnect exhausted");
                    let _ = events.send(SessionEvent::Disconnected { reason });
                    return;
                }
                // `decide`/`after_failed_attempt` never return Exit for a drop.
                Decision::Exit(code) => {
                    let _ = events.send(SessionEvent::Exited { code });
                    return;
                }
            };

            debug!(attempt, delay = ?delay, "supervise: reconnecting after transport drop");
            let _ = events.send(SessionEvent::Reconnecting {
                attempt,
                max_attempts: policy.max_attempts,
                delay_ms: millis_u64(delay),
            });

            tokio::select! {
                biased;
                _ = shutdown.changed() => return,
                () = tokio::time::sleep(delay) => {}
            }
            if *shutdown.borrow() {
                return;
            }

            let (cols, rows) = dims.get();
            match reconnector(cols, rows).await {
                Ok(est) => break est,
                Err(e) => {
                    reason = e.message;
                    decision = policy.after_failed_attempt(attempt, e.retryable, rand01());
                }
            }
        };

        // Swap in the new transport under the lock, then carry on pumping it.
        {
            let mut c = conn.lock().await;
            c.control = Control::Ssh(established.control);
            c.keepalive = Some(Arc::clone(&established.ssh));
        }
        // A fresh generation has no backlog; clear any pause left from the old
        // one so the new producer is not throttled against a stale watermark.
        let _ = desktop_pause.send(false);
        info!("supervise: reconnected — transport swapped, scrollback preserved");
        let _ = events.send(SessionEvent::Connected);
        out = established.out;
        ssh = established.ssh;
    }
}

/// Resolve a saved host's reconnect policy: per-host override, else the global
/// setting, else the built-in default.
async fn reconnect_policy_for(store: &Store, host: &tern_core_store::Host) -> ReconnectPolicy {
    let store = store.clone();
    let (enabled_default, max_default) = tauri::async_runtime::spawn_blocking(move || {
        let s = store.settings();
        (
            s.get_or(tern_core_store::KEY_RECONNECT_ENABLED, true)
                .unwrap_or(true),
            s.get_or(
                tern_core_store::KEY_RECONNECT_MAX_ATTEMPTS,
                ReconnectPolicy::DEFAULT.max_attempts,
            )
            .unwrap_or(ReconnectPolicy::DEFAULT.max_attempts),
        )
    })
    .await
    .unwrap_or((true, ReconnectPolicy::DEFAULT.max_attempts));

    ReconnectPolicy {
        enabled: host.overrides.reconnect_enabled.unwrap_or(enabled_default),
        max_attempts: host.overrides.reconnect_max_attempts.unwrap_or(max_default),
        backoff: Backoff::DEFAULT,
    }
}

/// One (re)connect to a saved host, from the record and the keyring outward.
/// Shared by the initial connect's reconnector and every retry after it.
#[allow(clippy::too_many_arguments)] // owned pieces the spawned closure must carry
async fn establish_saved_host(
    store: Store,
    host_id: i64,
    known_hosts_path: PathBuf,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    events: Channel<SessionEvent>,
    session_id: String,
    window: Option<u32>,
    cols: u16,
    rows: u16,
) -> Result<Established, ReconnectError> {
    let fetch = store.clone();
    let host = tauri::async_runtime::spawn_blocking(move || fetch.hosts().get(host_id))
        .await
        .map_err(|e| ReconnectError {
            retryable: false,
            message: format!("store task failed: {e}"),
        })?
        .map_err(|e| ReconnectError {
            retryable: false,
            message: e.to_string(),
        })?
        .ok_or_else(|| ReconnectError {
            // The host was deleted during the outage; there is nothing to
            // reconnect to, so stop rather than retry a phantom.
            retryable: false,
            message: format!("host {host_id} was removed"),
        })?;

    // Re-resolved every attempt on purpose (see auth.rs): a credential the user
    // revoked mid-session fails the next attempt loudly instead of succeeding
    // with a stale copy. A degraded-keyring note is dropped here — it was
    // already shown on the first connect and would only repeat.
    let resolved = crate::auth::auth_for_host(&host);
    let cfg = crate::session_cfg::for_host(&host, resolved.methods, window);

    let hash_store = store.clone();
    let hash_new = tauri::async_runtime::spawn_blocking(move || {
        hash_store
            .settings()
            .get_or(tern_core_store::KEY_HASH_KNOWN_HOSTS, false)
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);

    // Never insecure on the product path — a changed key on reconnect must be
    // refused (a non-retryable error that ends the loop), not trusted.
    let on_host_key = host_key_prompt(
        false,
        pending,
        events,
        session_id,
        known_hosts_path,
        hash_new,
    );
    let session = SshSession::connect(cfg, on_host_key).await?;
    let shell = session.open_shell(cols, rows).await?;
    let (out, control) = shell.split();
    Ok(Established {
        out,
        control,
        ssh: Arc::new(session),
    })
}

/// Connect an SSH target and wire its output into an already-spawned data path.
///
/// Shared by the ad-hoc `Ssh` target and the stored `SavedHost` one, which
/// differ only in where the config came from and whether they reconnect.
#[allow(clippy::too_many_arguments)] // wiring seam; each argument is distinct state
async fn connect_ssh(
    state: &State<'_, AppState>,
    id: &str,
    ssh_cfg: SessionConfig,
    insecure_accept: bool,
    req: &OpenSessionReq,
    events: &Channel<SessionEvent>,
    in_tx: mpsc::Sender<Bytes>,
    desktop_pause: watch::Sender<bool>,
    stream_stats: Arc<StreamStats>,
    host_id: Option<i64>,
    policy: ReconnectPolicy,
    reconnector: Option<Reconnector>,
) -> Result<LiveSession, String> {
    let hash_new = {
        let store = state.store();
        tauri::async_runtime::spawn_blocking(move || {
            store
                .settings()
                .get_or(tern_core_store::KEY_HASH_KNOWN_HOSTS, false)
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    };

    let on_host_key = host_key_prompt(
        insecure_accept,
        Arc::clone(&state.pending_host_keys),
        events.clone(),
        id.to_string(),
        state.known_hosts_path(),
        hash_new,
    );

    let session = SshSession::connect(ssh_cfg, on_host_key)
        .await
        .map_err(|e| {
            warn!(session = %id, error = %e, "connect_ssh: connect failed");
            e.to_string()
        })?;
    let shell = session.open_shell(req.cols, req.rows).await.map_err(|e| {
        warn!(session = %id, error = %e, "connect_ssh: open shell failed");
        e.to_string()
    })?;
    let (out, control) = shell.split();

    // Only a successful connect counts — a failed attempt should not reorder
    // the recent-hosts list.
    if let Some(host_id) = host_id {
        let store = state.store();
        let at = now_unix();
        drop(tauri::async_runtime::spawn_blocking(move || {
            let _ = store.hosts().record_connection(host_id, at);
        }));
    }

    let session = Arc::new(session);

    // Shared with the supervisor, which swaps the transport inside `conn` on
    // each reconnect while the session commands read it.
    let conn = Arc::new(Mutex::new(Conn {
        control: Control::Ssh(control),
        keepalive: Some(Arc::clone(&session)),
    }));
    let dims = Arc::new(Dims::new(req.cols, req.rows));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    tokio::spawn(supervise(
        out,
        session,
        in_tx,
        events.clone(),
        Arc::clone(&conn),
        Arc::clone(&dims),
        shutdown_rx,
        desktop_pause.clone(),
        policy,
        reconnector,
    ));

    Ok(LiveSession {
        conn,
        dims,
        shutdown: shutdown_tx,
        desktop_pause,
        stats: stream_stats,
        stats_epoch: std::sync::Mutex::new(Instant::now()),
        paused_since: std::sync::Mutex::new(None),
    })
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

// A dispatcher over three target kinds; each arm is wiring, and splitting it up
// to satisfy a line count would scatter that wiring for no gain.
#[allow(clippy::too_many_lines)]
#[tauri::command]
pub async fn open_session(
    state: State<'_, AppState>,
    req: OpenSessionReq,
    data: Channel<InvokeResponseBody>,
    events: Channel<SessionEvent>,
) -> Result<SessionId, String> {
    let id = format!("s-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    // A label that never touches the auth field: `Target`'s derived `Debug`
    // would print an ad-hoc password in the clear, so build the string by hand
    // from the non-secret fields only.
    let target = match &req.target {
        Target::Ssh(t) => format!("ssh {}@{}:{}", t.username, t.host, t.port),
        Target::SavedHost { host_id } => format!("saved-host {host_id}"),
        Target::LocalPty(t) => format!("pty {}", t.program.as_deref().unwrap_or("<shell>")),
    };
    info!(session = %id, %target, "open_session");
    let stream_stats = StreamStats::new();
    let frame_cfg = coalescer_cfg(&req);
    let (in_tx, desktop_pause) = spawn_data_path(frame_cfg, Arc::clone(&stream_stats), data);

    let live = match req.target {
        Target::Ssh(ref target) => {
            let mut ssh_cfg = SessionConfig::new(
                target.host.clone(),
                target.username.clone(),
                auth_from_dto(target.auth.clone()),
            );
            ssh_cfg.port = target.port;
            if let Some(w) = req.window_size {
                ssh_cfg.window_size = w;
            }
            let insecure = target.insecure_accept_host_key;
            // Ad-hoc targets have no stored identity to reconnect against
            // (bench and rig connections live and die within one run).
            connect_ssh(
                &state,
                &id,
                ssh_cfg,
                insecure,
                &req,
                &events,
                in_tx,
                desktop_pause,
                stream_stats,
                None,
                ReconnectPolicy::OFF,
                None,
            )
            .await?
        }
        Target::SavedHost { host_id } => {
            // The product path. No credential crosses the IPC boundary: the
            // record names a keyring account and we resolve it here.
            let store = state.store();
            let host = {
                let store = store.clone();
                tauri::async_runtime::spawn_blocking(move || store.hosts().get(host_id))
                    .await
                    .map_err(|e| format!("store task failed: {e}"))?
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("no such host {host_id}"))?
            };

            let resolved = crate::auth::auth_for_host(&host);
            // Emitted before the connect rather than folded into its failure:
            // the attempt may well succeed, and the user still wants to know
            // their saved credential was not the thing that carried it.
            if let Some(note) = resolved.degraded {
                let _ = events.send(SessionEvent::Warning { message: note });
            }
            let policy = reconnect_policy_for(&store, &host).await;
            let ssh_cfg = crate::session_cfg::for_host(&host, resolved.methods, req.window_size);

            // The supervisor reconnects by re-running the saved-host establish
            // from owned state; skip building it when the policy can never fire.
            let reconnector: Option<Reconnector> = if policy.enabled {
                let store = state.store();
                let known_hosts_path = state.known_hosts_path();
                let pending = Arc::clone(&state.pending_host_keys);
                let events = events.clone();
                let sid = id.clone();
                let window = req.window_size;
                Some(Box::new(move |cols, rows| {
                    Box::pin(establish_saved_host(
                        store.clone(),
                        host_id,
                        known_hosts_path.clone(),
                        Arc::clone(&pending),
                        events.clone(),
                        sid.clone(),
                        window,
                        cols,
                        rows,
                    ))
                }))
            } else {
                None
            };

            connect_ssh(
                &state,
                &id,
                ssh_cfg,
                false,
                &req,
                &events,
                in_tx,
                desktop_pause,
                stream_stats,
                Some(host_id),
                policy,
                reconnector,
            )
            .await?
        }
        Target::LocalPty(ref target) => {
            let target = target.clone();
            let pty_cfg = PtyConfig {
                program: target.program,
                args: target.args,
                cwd: None,
                cols: req.cols,
                rows: req.rows,
            };
            let pty = LocalPty::spawn(&pty_cfg).map_err(|e| e.to_string())?;
            let (mut out, control) = pty.split();

            let ev = events.clone();
            tokio::spawn(async move {
                while let Some(chunk) = out.recv().await {
                    if in_tx.send(chunk).await.is_err() {
                        break;
                    }
                }
                // A local child process that stops producing output has
                // exited — there is no transport to lose, so unlike SSH there
                // is nothing to disambiguate here, and nothing to reconnect.
                let code = out.exit_code().await;
                let _ = ev.send(SessionEvent::Exited { code });
            });

            // A local shell has no transport to drop and nothing to reconnect,
            // so the swappable transport is only ever read, never swapped, and
            // the shutdown channel is inert.
            LiveSession {
                conn: Arc::new(Mutex::new(Conn {
                    control: Control::Pty(control),
                    keepalive: None,
                })),
                dims: Arc::new(Dims::new(req.cols, req.rows)),
                shutdown: watch::channel(false).0,
                desktop_pause,
                stats: stream_stats,
                stats_epoch: std::sync::Mutex::new(Instant::now()),
                paused_since: std::sync::Mutex::new(None),
            }
        }
    };

    let _ = events.send(SessionEvent::Connected);
    state
        .sessions
        .lock()
        .await
        .insert(id.clone(), Arc::new(live));
    Ok(SessionId(id))
}

#[tauri::command]
pub async fn approve_host_key(
    state: State<'_, AppState>,
    id: String,
    accept: bool,
) -> Result<(), String> {
    let sender = state.pending_host_keys.lock().await.remove(&id);
    match sender {
        Some(tx) => {
            let _ = tx.send(accept);
            Ok(())
        }
        None => Err(format!("no pending host-key prompt for {id}")),
    }
}

#[tauri::command]
pub async fn write_session(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = state.session(&id).await?;
    match session.control().await {
        Control::Ssh(c) => c.write(data).await.map_err(|e| e.to_string()),
        Control::Pty(c) => c.write(data).await.map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn resize_session(state: State<'_, AppState>, req: ResizeReq) -> Result<(), String> {
    let session = state.session(&req.id.0).await?;
    // Recorded so a reconnected shell opens at the current size, not the size
    // the session first started at.
    session.dims.set(req.cols, req.rows);
    match session.control().await {
        Control::Ssh(c) => c
            .resize(req.cols, req.rows)
            .await
            .map_err(|e| e.to_string()),
        Control::Pty(c) => c.resize(req.cols, req.rows).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn pause_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state.session(&id).await?;
    let _ = session.desktop_pause.send(true);
    if let Control::Ssh(c) = session.control().await {
        c.pause();
    }
    session.stats.pause_count.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut since) = session.paused_since.lock() {
        since.get_or_insert_with(Instant::now);
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state.session(&id).await?;
    if let Ok(mut since) = session.paused_since.lock()
        && let Some(started) = since.take()
    {
        session
            .stats
            .paused_ms
            .fetch_add(millis_u64(started.elapsed()), Ordering::Relaxed);
    }
    let _ = session.desktop_pause.send(false);
    if let Control::Ssh(c) = session.control().await {
        c.resume();
    }
    Ok(())
}

#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(&id);
    if let Some(session) = session {
        // Stop the supervisor first, or it would treat the close as a drop and
        // start reconnecting the tab the user just closed.
        let _ = session.shutdown.send(true);
        if let Control::Ssh(c) = session.control().await {
            let _ = c.close().await;
        }
    }
    // PTY sessions end when their queues drop; the child gets SIGHUP on
    // master close once all clones are gone.
    Ok(())
}

#[tauri::command]
pub async fn bench_reset(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state.session(&id).await?;
    session.stats.reset();
    if let Ok(mut epoch) = session.stats_epoch.lock() {
        *epoch = Instant::now();
    }
    Ok(())
}

#[tauri::command]
pub async fn bench_stats(state: State<'_, AppState>, id: String) -> Result<StreamStatsDto, String> {
    let session = state.session(&id).await?;
    let counters = &session.stats;
    let elapsed_ms = session
        .stats_epoch
        .lock()
        .map_or(0, |epoch| millis_u64(epoch.elapsed()));
    Ok(StreamStatsDto {
        bytes_in: counters.bytes_in.load(Ordering::Relaxed),
        newlines_in: counters.newlines_in.load(Ordering::Relaxed),
        frames_out: counters.frames_out.load(Ordering::Relaxed),
        bytes_out: counters.bytes_out.load(Ordering::Relaxed),
        max_frame_bytes: counters.max_frame_bytes.load(Ordering::Relaxed),
        pause_count: counters.pause_count.load(Ordering::Relaxed),
        paused_ms: counters.paused_ms.load(Ordering::Relaxed),
        elapsed_ms,
    })
}

fn bench_out_dir() -> std::path::PathBuf {
    std::env::var("TERN_BENCH_OUT").map_or_else(|_| "../../docs/bench/results".into(), Into::into)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // tauri command args are deserialized owned
pub fn bench_finish(report: BenchReport) -> Result<String, String> {
    let dir = bench_out_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file_name = format!(
        "{}-c{}k-w{}k.json",
        report.scenario,
        report.chunk_max / 1024,
        report.window_size / 1024
    );
    let path = dir.join(file_name);
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Append a harness log line to `<TERN_BENCH_OUT>/bench.log` — the webview
/// console is invisible when the app drives itself.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // tauri command args are deserialized owned
pub fn bench_log(line: String) {
    let dir = bench_out_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(dir.join("bench.log"))
    {
        use std::io::Write as _;
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
pub fn bench_auto() -> Option<AutoBenchCfg> {
    if std::env::var("TERN_BENCH").ok()? != "auto" {
        return None;
    }
    let env_or = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.into());
    Some(AutoBenchCfg {
        host: env_or("TERN_SSH_HOST", "127.0.0.1"),
        port: env_or("TERN_SSH_PORT", "2222").parse().ok()?,
        username: env_or("TERN_SSH_USER", "tern"),
        // Relative to `apps/desktop`, which is where `bun run tauri dev` runs
        // from — same convention as `bench_out_dir`. The bare `.rig/...` this
        // used to default to could only resolve from the repo root, so
        // `TERN_BENCH=auto bun run tauri dev` never worked without an explicit
        // TERN_SSH_KEY. scripts/bench-ci.sh drives bench_sink directly and
        // never goes through the webview, which is why it went unnoticed.
        key_path: env_or("TERN_SSH_KEY", "../../.rig/ssh/id_ed25519"),
        chunk_max: env_or("TERN_BENCH_CHUNK", "131072").parse().ok()?,
        tick_ms: env_or("TERN_BENCH_TICK", "8").parse().ok()?,
        window_size: env_or("TERN_BENCH_WINDOW", "524288").parse().ok()?,
        quick: env_or("TERN_BENCH_QUICK", "0") == "1",
    })
}

#[tauri::command]
pub fn bench_auto_done(failed: bool) {
    // Machine-readable line for the driving script.
    println!("TERN_BENCH_COMPLETE failed={failed}");
    if std::env::var("TERN_BENCH_EXIT").as_deref() == Ok("1") {
        std::process::exit(i32::from(failed));
    }
}
