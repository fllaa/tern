//! Serde types shared across the Tern IPC boundary.
//!
//! Rule: terminal byte streams NEVER appear here — raw output bytes ride the
//! binary IPC channel untouched, with no framing (ordering is guaranteed by
//! the channel). Everything low-frequency (session control, events, bench
//! stats) is serde JSON defined in this crate.
//!
//! This crate must never depend on `tauri`.

use serde::{Deserialize, Serialize};

mod store;

pub use store::{
    AuthKindDto, FolderDto, HostDto, HostFilterDto, HostOverridesDto, KeyInfoDto, KeyringStatusDto,
    KnownHostEntryDto, KnownHostsImportReportDto, NewHostDto, SecretUpdateDto,
    SshConfigCandidateDto, SshConfigImportResultDto, SshConfigScanDto, SshConfigWarningDto, TagDto,
};

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
    /// A host from the store, connected by id.
    ///
    /// This is the path the product UI uses, and it is a security property
    /// rather than a convenience: for a saved host **no credential ever
    /// crosses the IPC boundary**. The Rust side reads `secret_ref` and
    /// resolves the secret from the OS keyring itself. `Ssh` survives only
    /// for ad-hoc quick-connect, where there is no stored secret to resolve.
    SavedHost {
        host_id: i64,
    },
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
    /// First contact with an unknown host key. The UI prompts; the connect
    /// blocks until `approve_host_key` answers.
    HostKeyPrompt {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint_sha256: String,
    },
    /// A recorded key for this host and algorithm does not match what the
    /// server offered.
    ///
    /// Deliberately a separate variant from `HostKeyPrompt`, not a flag on it:
    /// this path must never render as the same "do you want to continue?"
    /// dialog. The connect is already refused by the time this arrives —
    /// recovery is an explicit `remove_known_host` followed by a reconnect,
    /// which then presents as ordinary first contact.
    HostKeyChanged {
        host: String,
        port: u16,
        algorithm: String,
        recorded_fingerprint: String,
        presented_fingerprint: String,
        known_hosts_path: String,
        known_hosts_line: usize,
    },
    /// The host key is on file as `@revoked`.
    HostKeyRevoked {
        host: String,
        port: u16,
        known_hosts_path: String,
        known_hosts_line: usize,
    },
    Connected,
    /// A reconnect attempt is scheduled after a transport drop. Purely
    /// informational — the session id is unchanged and the terminal keeps its
    /// scrollback; this drives the "reconnecting…" indicator and the countdown.
    /// `Connected` follows on success, `Disconnected` when the supervisor gives
    /// up.
    Reconnecting {
        attempt: u32,
        /// The configured ceiling, or `0` for unlimited — shown as "n/max".
        max_attempts: u32,
        /// How long until this attempt fires, so the UI can count down.
        delay_ms: u64,
    },
    /// The transport died. Distinct from `Exited`, which means the remote
    /// shell ended on its own — only this one should trigger a reconnect.
    Disconnected {
        reason: String,
    },
    Exited {
        code: Option<u32>,
    },
    Error {
        message: String,
    },
    /// Something the user should know that did not stop the connection.
    ///
    /// Separate from `Error`, which is terminal. The case this exists for is a
    /// host with a saved credential on a machine whose credential store cannot
    /// be read: the connect still proceeds — an agent or an unencrypted key may
    /// carry it — but "authentication failed" alone would send the user to
    /// check a password that was never the problem.
    Warning {
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
