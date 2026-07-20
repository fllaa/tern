//! Local `SQLite` store for hosts, folders, tags, and settings.
//!
//! Two things deliberately live *outside* this crate:
//!
//! * **Secrets.** `hosts.secret_ref` holds an OS-keyring account string, never
//!   a credential. Key material never reaches `SQLite` (ADR-0008).
//! * **Host keys.** Tern's own `known_hosts` file is the sole authority for
//!   trust decisions. Mirroring it here would create a second source of truth
//!   for a security decision, which is how a client ends up silently trusting
//!   the wrong key (ADR-0013).
//!
//! There is no `tauri` dependency (the workspace rule that keeps a mobile app
//! a re-skin) and deliberately no `tern-core-ssh` dependency: this crate
//! returns records, and the desktop layer maps them onto `SessionConfig`.
//! That keeps the core crates a DAG with no cross-edges.

mod db;
mod error;
mod folders;
mod hosts;
mod migrate;
mod model;
mod settings;
mod ssh_config;
mod tags;

pub use db::Store;
pub use error::StoreError;
pub use folders::FolderRepo;
pub use hosts::HostRepo;
pub use migrate::target_version as schema_target_version;
pub use model::{
    AuthKind, Folder, FolderId, Host, HostFilter, HostId, HostOverrides, HostSource, NewHost, Tag,
    TagId, decode_auth_fallbacks, encode_auth_fallbacks,
};
pub use settings::{
    KEY_HASH_KNOWN_HOSTS, KEY_KNOWN_HOSTS_IMPORT_OFFERED, KEY_RECONNECT_ENABLED,
    KEY_RECONNECT_MAX_ATTEMPTS, SettingsRepo,
};
pub use ssh_config::{
    Candidate as SshConfigCandidate, Disposition as SshConfigDisposition, ImportOutcome,
    Scan as SshConfigScan, Warning as SshConfigWarning, apply as apply_ssh_config,
    default_path as default_ssh_config_path, scan as scan_ssh_config,
};
pub use tags::TagRepo;

/// Unix seconds. Every timestamp column in the schema is this.
///
/// `SystemTime` rather than a date library: the store never formats or does
/// calendar arithmetic, so `chrono` would be a dependency for nothing.
/// A clock before the epoch yields 0 rather than panicking.
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}
