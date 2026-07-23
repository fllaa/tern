//! Plain records. No `tauri`, no `russh` — the desktop layer maps these onto
//! `SessionConfig`, which is what keeps this crate off the core-ssh graph.

use serde::{Deserialize, Serialize};

pub type HostId = i64;
pub type FolderId = i64;
pub type TagId = i64;
pub type SnippetId = i64;

/// How a host authenticates.
///
/// Stored as TEXT with no SQL `CHECK`, because `keyboard-interactive` is a
/// known future value and `SQLite` cannot alter a CHECK without rebuilding the
/// table. Validation lives here instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    Agent,
    KeyFile,
    Password,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::KeyFile => "key_file",
            Self::Password => "password",
        }
    }
}

impl TryFrom<&str> for AuthKind {
    type Error = crate::error::StoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "agent" => Ok(Self::Agent),
            "key_file" => Ok(Self::KeyFile),
            "password" => Ok(Self::Password),
            other => Err(crate::error::StoreError::Invalid(format!(
                "unknown auth_method {other:?}"
            ))),
        }
    }
}

/// Encode a fallback chain for storage. Empty yields `None`, so "no fallback"
/// is a SQL NULL rather than an empty string that reads as data.
#[must_use]
pub fn encode_auth_fallbacks(kinds: &[AuthKind]) -> Option<String> {
    if kinds.is_empty() {
        return None;
    }
    Some(
        kinds
            .iter()
            .map(|k| k.as_str())
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// Decode a stored fallback chain.
///
/// Unknown entries are dropped rather than failing the read. A host row is not
/// worth making unreadable over one unrecognised fallback — the likely cause is
/// a newer build that wrote a method this one does not have, and losing the
/// fallback degrades to the primary method rather than to an unusable record.
#[must_use]
pub fn decode_auth_fallbacks(raw: Option<&str>) -> Vec<AuthKind> {
    raw.unwrap_or_default()
        .split(',')
        .filter_map(|s| AuthKind::try_from(s.trim()).ok())
        .collect()
}

/// Where a host record came from. Drives idempotent re-import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostSource {
    Manual,
    SshConfig,
}

impl HostSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::SshConfig => "ssh_config",
        }
    }
}

impl TryFrom<&str> for HostSource {
    type Error = crate::error::StoreError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "manual" => Ok(Self::Manual),
            "ssh_config" => Ok(Self::SshConfig),
            other => Err(crate::error::StoreError::Invalid(format!(
                "unknown host source {other:?}"
            ))),
        }
    }
}

/// Per-host connection overrides. `None` means "inherit the global setting".
///
/// Every field here maps onto one `SessionConfig` field that already exists —
/// adding an override never requires a new transport-level knob.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostOverrides {
    pub term: Option<String>,
    // Seconds are u32, not u64: SQLite integers are signed 64-bit and rusqlite
    // deliberately refuses u64. u32 seconds is 136 years of keepalive interval.
    pub keepalive_secs: Option<u32>,
    pub keepalive_max: Option<u32>,
    pub connect_timeout_secs: Option<u32>,
    pub window_size: Option<u32>,
    pub reconnect_enabled: Option<bool>,
    pub reconnect_max_attempts: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Host {
    pub id: HostId,
    pub folder_id: Option<FolderId>,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthKind,
    /// Methods to try after `auth` fails, in order. Empty means no fallback,
    /// which is the default and matches every host created before fallbacks
    /// existed.
    #[serde(default)]
    pub auth_fallbacks: Vec<AuthKind>,
    /// Keyring *account* string, never a credential. `None` = prompt each time.
    pub secret_ref: Option<String>,
    pub key_path: Option<String>,
    pub overrides: HostOverrides,
    /// Parsed in Phase 1, executed in Phase 2.
    pub proxy_jump: Option<String>,
    pub source: HostSource,
    pub source_alias: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
    pub last_connected_at: Option<i64>,
    pub connect_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<TagId>,
}

/// A host being created. Separate from `Host` because ids and timestamps are
/// the store's to assign.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewHost {
    pub folder_id: Option<FolderId>,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthKind,
    #[serde(default)]
    pub auth_fallbacks: Vec<AuthKind>,
    pub secret_ref: Option<String>,
    pub key_path: Option<String>,
    #[serde(default)]
    pub overrides: HostOverrides,
    pub proxy_jump: Option<String>,
    #[serde(default = "default_source")]
    pub source: HostSource,
    pub source_alias: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
}

fn default_source() -> HostSource {
    HostSource::Manual
}

impl NewHost {
    /// Minimal manual host. Callers override fields as needed.
    pub fn manual(name: impl Into<String>, hostname: impl Into<String>) -> Self {
        Self {
            folder_id: None,
            name: name.into(),
            hostname: hostname.into(),
            port: 22,
            username: String::new(),
            auth: AuthKind::Agent,
            auth_fallbacks: Vec::new(),
            secret_ref: None,
            key_path: None,
            overrides: HostOverrides::default(),
            proxy_jump: None,
            source: HostSource::Manual,
            source_alias: None,
            color: None,
            notes: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: FolderId,
    pub parent_id: Option<FolderId>,
    pub name: String,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub id: TagId,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
}

/// A reusable command body, with optional `{{variable}}` placeholders the UI
/// prompts for before sending.
///
/// Plaintext by design: a snippet is a command you would have typed, not a
/// credential. Secrets live in the OS keyring behind a host record — nothing
/// here is encrypted or redacted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    pub id: SnippetId,
    pub name: String,
    pub body: String,
    pub description: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A snippet to create; the store assigns the id and timestamps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewSnippet {
    pub name: String,
    pub body: String,
    pub description: Option<String>,
}

/// Host list query. All fields AND together; empty means "no constraint".
///
/// Search is a plain `LIKE '%q%'` over name/hostname/username. FTS5 was
/// considered and cut: it is a virtual table and a migration liability for a
/// list that will not exceed a few hundred rows.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostFilter {
    pub query: Option<String>,
    pub folder_id: Option<FolderId>,
    /// A host must carry *every* listed tag to match.
    #[serde(default)]
    pub tag_ids: Vec<TagId>,
    pub limit: Option<u32>,
}
