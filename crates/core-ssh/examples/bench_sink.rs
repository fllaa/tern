//! Headless slice of the Spike 2 benchmark: SSH → pump → coalescer → sink,
//! no webview. Proves the Rust core path clears its throughput floor and
//! loses nothing, independent of xterm/IPC.
//!
//! ```sh
//! scripts/sshd-rig.sh up
//! cargo run --release -p tern-core-ssh --example bench_sink -- --emit-json
//! cargo run --release -p tern-core-ssh --example bench_sink -- --emit-raw | bun scripts/bench-xterm-headless.mjs
//! ```
//!
//! Env: `TERN_SSH_HOST` / `TERN_SSH_PORT` / `TERN_SSH_KEY` (rig defaults).
//! `--emit-raw` streams the coalesced frames to stdout (stats go to stderr)
//! so a downstream consumer can exercise the same byte stream.

use std::io::Write as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tern_core_ssh::{AuthMethod, SessionConfig, SshSession, accept_any_host_key};
use tern_term_stream::{CoalescerConfig, StreamStats, coalesce};
use tokio::sync::mpsc;

struct ScenarioResult {
    name: &'static str,
    bytes: u64,
    newlines: u64,
    wall_ms: u64,
    mbps: f64,
    complete: bool,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}

#[allow(clippy::cast_precision_loss)]
fn mbps(bytes: u64, wall: Duration) -> f64 {
    let secs = wall.as_secs_f64();
    if secs <= 0.0 {
        return 0.0;
    }
    bytes as f64 / (1024.0 * 1024.0) / secs
}

// Bench harness main: linear scenario script; splitting it would only obscure it.
#[allow(clippy::too_many_lines)]
#[tokio::main]
async fn main() {
    let emit_raw = std::env::args().any(|a| a == "--emit-raw");
    let host = env_or("TERN_SSH_HOST", "127.0.0.1");
    let port: u16 = env_or("TERN_SSH_PORT", "2222").parse().expect("port");
    let key = env_or("TERN_SSH_KEY", ".rig/ssh/id_ed25519");

    let cfg = SessionConfig {
        port,
        ..SessionConfig::new(
            host,
            "tern",
            AuthMethod::KeyFile {
                path: key.into(),
                passphrase: None,
            },
        )
    };
    let session = SshSession::connect(cfg, accept_any_host_key())
        .await
        .expect("connect to rig (scripts/sshd-rig.sh up)");
    let shell = session.open_shell(120, 40).await.expect("open shell");
    let (mut out, control) = shell.split();

    let stats = StreamStats::new();
    let (in_tx, in_rx) = mpsc::channel(32);
    let (frame_tx, mut frame_rx) = mpsc::channel(32);
    tokio::spawn(coalesce(
        in_rx,
        frame_tx,
        CoalescerConfig::default(),
        Arc::clone(&stats),
    ));
    tokio::spawn(async move {
        while let Some(chunk) = out.recv().await {
            if in_tx.send(chunk).await.is_err() {
                break;
            }
        }
    });

    // Sink: count everything, watch for completion markers, optionally
    // re-emit raw frames on stdout for a downstream consumer.
    let (marker_tx, mut marker_rx) = mpsc::channel::<String>(8);
    let (count_tx, count_rx) = tokio::sync::watch::channel((0u64, 0u64));
    let raw_out = emit_raw;
    tokio::spawn(async move {
        let mut bytes = 0u64;
        let mut newlines = 0u64;
        let mut tail = String::new();
        while let Some(frame) = frame_rx.recv().await {
            bytes += frame.len() as u64;
            // Plain loop is fine at these rates (see term-stream's identical call).
            #[allow(clippy::naive_bytecount)]
            {
                newlines += frame.iter().filter(|&&b| b == b'\n').count() as u64;
            }
            let _ = count_tx.send((bytes, newlines));
            if raw_out {
                // Scoped lock: StdoutLock is !Send and must not live across awaits.
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(&frame);
                let _ = stdout.flush();
            }
            tail.push_str(&String::from_utf8_lossy(&frame));
            if tail.len() > 512 {
                let cut = tail.len() - 512;
                tail.drain(..cut);
            }
            while let Some(pos) = tail.find("__SINK_") {
                let rest = &tail[pos..];
                let Some(end) = rest.find("__\n").or_else(|| rest.find("__\r")) else {
                    break;
                };
                let marker = rest[..end + 2].to_string();
                tail.drain(..pos + end + 2);
                let _ = marker_tx.send(marker).await;
            }
        }
    });

    // Kill PTY echo so the typed commands can never satisfy a marker —
    // only printf's real output counts.
    control
        .write(&b"stty -echo\n"[..])
        .await
        .expect("write stty");
    tokio::time::sleep(Duration::from_millis(400)).await;

    let scenarios: [(&'static str, String, u64); 2] = [
        ("core_seq2m", "seq 1 2000000".into(), 2_000_000),
        ("core_cat100mb", "cat /bench/100mb.txt".into(), 0),
    ];

    let mut results = Vec::new();
    for (name, cmd, min_newlines) in scenarios {
        stats.reset();
        let base = *count_rx.borrow();
        let started = Instant::now();
        control
            .write(format!("{cmd}; printf '\\n__SINK_{name}__\\n'\n"))
            .await
            .expect("write command");

        let marker = format!("__SINK_{name}__");
        let complete = tokio::time::timeout(Duration::from_secs(300), async {
            while let Some(m) = marker_rx.recv().await {
                if m.contains(&marker) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);

        let wall = started.elapsed();
        let (bytes, newlines) = *count_rx.borrow();
        let (bytes, newlines) = (bytes - base.0, newlines - base.1);
        results.push(ScenarioResult {
            name,
            bytes,
            newlines,
            wall_ms: u64::try_from(wall.as_millis()).unwrap_or(u64::MAX),
            mbps: mbps(bytes, wall),
            complete: complete && newlines >= min_newlines,
        });
    }

    let _ = control.close().await;
    session.disconnect().await.ok();

    let all_complete = results.iter().all(|r| r.complete);
    let cat = results
        .iter()
        .find(|r| r.name == "core_cat100mb")
        .expect("cat scenario ran");
    // Dev-machine floor is 80 MB/s; CI runners are slower shared hardware, so
    // the workflow sets a runner-class floor via env (see bench.yml).
    let floor: f64 = std::env::var("TERN_BENCH_CORE_FLOOR")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(80.0);
    let floor_ok = cat.mbps >= floor;

    let json = format!(
        "{{\"results\":[{}],\"lossless\":{all_complete},\"core_floor_mbps\":{floor},\"core_floor_ok\":{floor_ok}}}",
        results
            .iter()
            .map(|r| format!(
                "{{\"name\":\"{}\",\"bytes\":{},\"newlines\":{},\"wall_ms\":{},\"mbps\":{:.2},\"complete\":{}}}",
                r.name, r.bytes, r.newlines, r.wall_ms, r.mbps, r.complete
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    // Stats to stderr when stdout carries raw frames.
    if emit_raw {
        eprintln!("{json}");
    } else {
        println!("{json}");
    }

    assert!(all_complete, "core path lost data or missed markers");
    assert!(
        floor_ok,
        "core path below {floor} MB/s floor: {:.2} MB/s",
        cat.mbps
    );
}
