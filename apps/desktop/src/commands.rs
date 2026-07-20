//! Tauri command layer: thin wiring between the webview and the core crates.
//!
//! Terminal bytes ride `Channel<InvokeResponseBody>` as raw frames (never
//! JSON); everything else is `tern-proto` serde types. The desktop-side pump
//! is gated by a pause watch because `Channel::send` never blocks — without
//! the gate, a slow webview would grow the channel queue without bound
//! instead of propagating backpressure.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use tern_core_pty::{LocalPty, PtyConfig, PtyControl};
use tern_core_ssh::{
    AuthMethod, HostKeyCallback, SessionConfig, ShellControl, SshSession, accept_any_host_key,
};
use tern_proto::{
    AuthMethodDto, AutoBenchCfg, BenchReport, OpenSessionReq, ResizeReq, SessionEvent, SessionId,
    StreamStatsDto, Target,
};
use tern_term_stream::{CoalescerConfig, StreamStats, coalesce};
use tokio::sync::{Mutex, mpsc, oneshot, watch};

const QUEUE_DEPTH: usize = 32;

enum Control {
    Ssh(ShellControl),
    Pty(PtyControl),
}

struct LiveSession {
    control: Control,
    /// Gates the desktop→webview sender task.
    desktop_pause: watch::Sender<bool>,
    stats: Arc<StreamStats>,
    stats_epoch: std::sync::Mutex<Instant>,
    paused_since: std::sync::Mutex<Option<Instant>>,
    /// Keeps the russh handle (and thus the connection) alive.
    _ssh: Option<SshSession>,
}

#[derive(Default)]
pub struct AppState {
    sessions: Mutex<HashMap<String, Arc<LiveSession>>>,
    pending_host_keys: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    next_id: AtomicU64,
}

impl AppState {
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

/// TOFU flow: emit a `HostKeyPrompt` event and block the connect until the
/// webview answers via `approve_host_key` (or auto-trust for rig/bench runs).
fn host_key_prompt(
    insecure_accept: bool,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    events: Channel<SessionEvent>,
    session_id: String,
) -> HostKeyCallback {
    if insecure_accept {
        return accept_any_host_key();
    }
    Arc::new(move |info| {
        let pending = Arc::clone(&pending);
        let ev = events.clone();
        let sid = session_id.clone();
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            pending.lock().await.insert(sid, tx);
            let _ = ev.send(SessionEvent::HostKeyPrompt {
                host: info.host,
                port: info.port,
                algorithm: info.algorithm,
                fingerprint_sha256: info.fingerprint_sha256,
            });
            rx.await.unwrap_or(false)
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

#[tauri::command]
pub async fn open_session(
    state: State<'_, AppState>,
    req: OpenSessionReq,
    data: Channel<InvokeResponseBody>,
    events: Channel<SessionEvent>,
) -> Result<SessionId, String> {
    let id = format!("s-{}", state.next_id.fetch_add(1, Ordering::Relaxed));
    let stream_stats = StreamStats::new();
    let frame_cfg = coalescer_cfg(&req);
    let (in_tx, desktop_pause) = spawn_data_path(frame_cfg, Arc::clone(&stream_stats), data);

    let live = match req.target {
        Target::Ssh(target) => {
            let mut ssh_cfg = SessionConfig::new(
                target.host.clone(),
                target.username.clone(),
                auth_from_dto(target.auth.clone()),
            );
            ssh_cfg.port = target.port;
            if let Some(w) = req.window_size {
                ssh_cfg.window_size = w;
            }

            let on_host_key = host_key_prompt(
                target.insecure_accept_host_key,
                Arc::clone(&state.pending_host_keys),
                events.clone(),
                id.clone(),
            );

            let session = SshSession::connect(ssh_cfg, on_host_key)
                .await
                .map_err(|e| e.to_string())?;
            let shell = session
                .open_shell(req.cols, req.rows)
                .await
                .map_err(|e| e.to_string())?;
            let (mut out, control) = shell.split();

            let ev = events.clone();
            tokio::spawn(async move {
                while let Some(chunk) = out.recv().await {
                    if in_tx.send(chunk).await.is_err() {
                        break;
                    }
                }
                let code = out.exit_status().await;
                let _ = ev.send(SessionEvent::Exited { code });
            });

            LiveSession {
                control: Control::Ssh(control),
                desktop_pause,
                stats: stream_stats,
                stats_epoch: std::sync::Mutex::new(Instant::now()),
                paused_since: std::sync::Mutex::new(None),
                _ssh: Some(session),
            }
        }
        Target::LocalPty(target) => {
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
                let code = out.exit_code().await;
                let _ = ev.send(SessionEvent::Exited { code });
            });

            LiveSession {
                control: Control::Pty(control),
                desktop_pause,
                stats: stream_stats,
                stats_epoch: std::sync::Mutex::new(Instant::now()),
                paused_since: std::sync::Mutex::new(None),
                _ssh: None,
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
    match &session.control {
        Control::Ssh(c) => c.write(data).await.map_err(|e| e.to_string()),
        Control::Pty(c) => c.write(data).await.map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn resize_session(state: State<'_, AppState>, req: ResizeReq) -> Result<(), String> {
    let session = state.session(&req.id.0).await?;
    match &session.control {
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
    if let Control::Ssh(c) = &session.control {
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
    if let Control::Ssh(c) = &session.control {
        c.resume();
    }
    Ok(())
}

#[tauri::command]
pub async fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(&id);
    if let Some(session) = session
        && let Control::Ssh(c) = &session.control
    {
        let _ = c.close().await;
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
        key_path: env_or("TERN_SSH_KEY", ".rig/ssh/id_ed25519"),
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
