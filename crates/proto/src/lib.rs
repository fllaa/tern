//! Serde types shared across the Tern IPC boundary.
//!
//! Rule: terminal byte streams NEVER appear here — raw output bytes ride the
//! binary IPC channel untouched, with no framing (ordering is guaranteed by
//! the channel). Everything low-frequency (session control, events, bench
//! stats) is serde JSON defined in this crate.
//!
//! This crate must never depend on `tauri`.

use serde::{Deserialize, Serialize};

/// Opaque identifier for a terminal session (SSH or local PTY).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// What a session connects to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    Ssh(SshTarget),
    LocalPty(LocalPtyTarget),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethodDto,
    /// Auto-trust unknown host keys. Spike/bench rigs only — real UI flows use
    /// the `HostKeyPrompt` event + `approve_host_key` command.
    #[serde(default)]
    pub insecure_accept_host_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum AuthMethodDto {
    Password {
        password: String,
    },
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalPtyTarget {
    /// `None` = platform login shell.
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Open a session: target + initial PTY size + data-path tuning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenSessionReq {
    pub target: Target,
    pub cols: u16,
    pub rows: u16,
    /// Coalescer max frame bytes (default 64 KiB).
    pub chunk_max: Option<u32>,
    /// Coalescer tick in milliseconds (default 8).
    pub tick_ms: Option<u32>,
    /// SSH flow-control window bytes (default 512 KiB). SSH targets only.
    pub window_size: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResizeReq {
    pub id: SessionId,
    pub cols: u16,
    pub rows: u16,
}

/// Low-frequency session lifecycle events (JSON channel; never terminal bytes).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum SessionEvent {
    HostKeyPrompt {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint_sha256: String,
    },
    Connected,
    Disconnected {
        reason: String,
    },
    Exited {
        code: Option<u32>,
    },
    Error {
        message: String,
    },
}

/// Snapshot of the Rust-side stream counters (see `tern-term-stream`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StreamStatsDto {
    pub bytes_in: u64,
    pub newlines_in: u64,
    pub frames_out: u64,
    pub bytes_out: u64,
    pub max_frame_bytes: u64,
    pub pause_count: u64,
    pub paused_ms: u64,
    /// Milliseconds since the last stats reset.
    pub elapsed_ms: u64,
}

/// JS-side benchmark measurements, reported by the webview.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BenchJsStats {
    pub recv_bytes: u64,
    pub recv_frames: u64,
    /// Bytes acknowledged by xterm write callbacks (i.e. parsed).
    pub parsed_bytes: u64,
    pub wall_ms: u64,
    pub max_pending_bytes: u64,
    pub pause_count: u64,
    pub js_newlines: u64,
    pub echo_p50_ms: Option<f64>,
    pub echo_p95_ms: Option<f64>,
    pub echo_max_ms: Option<f64>,
    pub echo_samples: Option<u32>,
    /// Longest gap between animation frames while streaming (UI stall proxy).
    pub max_stall_ms: Option<f64>,
}

/// One benchmark scenario's merged result, written to docs/bench/results/.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchReport {
    pub scenario: String,
    pub renderer: String,
    pub chunk_max: u32,
    pub tick_ms: u32,
    pub window_size: u32,
    pub server: String,
    pub rust: StreamStatsDto,
    pub js: BenchJsStats,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_serde_round_trip() {
        let id = SessionId("s-1".into());
        let json = serde_json::to_string(&id).expect("serialize");
        let back: SessionId = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(id, back);
    }

    #[test]
    fn open_session_req_wire_shape() {
        let req = OpenSessionReq {
            target: Target::Ssh(SshTarget {
                host: "127.0.0.1".into(),
                port: 2222,
                username: "tern".into(),
                auth: AuthMethodDto::KeyFile {
                    path: "/tmp/k".into(),
                    passphrase: None,
                },
                insecure_accept_host_key: true,
            }),
            cols: 120,
            rows: 40,
            chunk_max: Some(65536),
            tick_ms: Some(8),
            window_size: None,
        };
        let json = serde_json::to_string(&req).expect("serialize");
        assert!(
            json.contains("\"kind\":\"ssh\""),
            "tagged enum shape: {json}"
        );
        assert!(
            json.contains("\"method\":\"key_file\""),
            "auth tag shape: {json}"
        );
        let back: OpenSessionReq = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.cols, 120);
    }
}

/// Auto-benchmark configuration handed to the webview when `TERN_BENCH=auto`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoBenchCfg {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    pub chunk_max: u32,
    pub tick_ms: u32,
    pub window_size: u32,
    /// Skip the slow scenarios (used while smoke-testing the harness itself).
    pub quick: bool,
}
