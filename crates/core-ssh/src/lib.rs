//! russh-based SSH session management: connect, auth (password / key file /
//! agent), shell channels with PTY, resize, keepalives, and TOFU host-key
//! verification via callback.
//!
//! Backpressure is structural: every queue between the russh session loop and
//! the consumer is bounded, so a stalled consumer drains the SSH window and
//! throttles the remote process. See `docs/adr/0011` in the repo root.
//!
//! This crate must never depend on `tauri`.

mod config;
mod error;
mod keys;
mod known_hosts;
mod session;

pub use config::{AuthMethod, Secret, SessionConfig};
pub use error::SshError;
pub use keys::{KeyFormat, KeyInfo, inspect, inspect_str, unlock, unlock_str};
pub use known_hosts::{
    HostKeyVerdict, ImportReport, KnownHostEntry, KnownHostsError, KnownHostsFile,
};
pub use session::{
    HostKeyCallback, HostKeyInfo, ShellChannel, ShellControl, ShellOutput, SshSession,
    accept_any_host_key,
};
