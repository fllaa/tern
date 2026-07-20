//! Wire types for the host store.
//!
//! These mirror `tern-core-store`'s records rather than re-exporting them:
//! `proto` must not depend on the store crate (it is the IPC vocabulary, not a
//! consumer of any core crate), and the wire shape should be free to differ
//! from the storage shape as either evolves.
//!
//! The one shape that is *not* a mirror is [`SecretUpdateDto`] — see its docs.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKindDto {
    Agent,
    KeyFile,
    Password,
}

/// Per-host connection overrides. `None` = inherit the global setting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostOverridesDto {
    pub term: Option<String>,
    pub keepalive_secs: Option<u32>,
    pub keepalive_max: Option<u32>,
    pub connect_timeout_secs: Option<u32>,
    pub window_size: Option<u32>,
    pub reconnect_enabled: Option<bool>,
    pub reconnect_max_attempts: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDto {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthKindDto,
    /// Whether a credential is stored for this host. Deliberately a boolean —
    /// neither the secret nor its keyring account name has any business
    /// reaching the webview.
    pub has_secret: bool,
    pub key_path: Option<String>,
    #[serde(default)]
    pub overrides: HostOverridesDto,
    pub proxy_jump: Option<String>,
    pub source: String,
    pub color: Option<String>,
    pub notes: Option<String>,
    pub last_connected_at: Option<i64>,
    pub connect_count: i64,
    #[serde(default)]
    pub tags: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHostDto {
    pub folder_id: Option<i64>,
    pub name: String,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    pub auth: AuthKindDto,
    pub key_path: Option<String>,
    #[serde(default)]
    pub overrides: HostOverridesDto,
    pub proxy_jump: Option<String>,
    pub color: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub tags: Vec<i64>,
}

fn default_port() -> u16 {
    22
}

/// What to do with a host's stored credential on update.
///
/// The tri-state is unavoidable and the reason a plain `Option<String>` will
/// not do: "the user did not touch the password field" and "the user cleared
/// the password field" are different intents, and collapsing them would either
/// wipe credentials on every unrelated edit or make clearing one impossible.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
#[derive(Default)]
pub enum SecretUpdateDto {
    #[default]
    Unchanged,
    Set {
        secret: String,
    },
    Clear,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFilterDto {
    pub query: Option<String>,
    pub folder_id: Option<i64>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDto {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntryDto {
    pub line: usize,
    pub patterns: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub marker: Option<String>,
    /// Hashed entries cannot be reversed, so the UI has no hostname to show.
    pub hashed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsImportReportDto {
    pub total: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub skipped_cert_authority: usize,
    pub malformed: usize,
}

#[cfg(test)]
mod tests {
    use super::{AuthKindDto, NewHostDto, SecretUpdateDto};

    #[test]
    fn secret_update_is_a_tagged_tri_state() {
        let unchanged = serde_json::to_string(&SecretUpdateDto::Unchanged).expect("serialize");
        assert_eq!(unchanged, r#"{"action":"unchanged"}"#);
        let clear = serde_json::to_string(&SecretUpdateDto::Clear).expect("serialize");
        assert_eq!(clear, r#"{"action":"clear"}"#);
        let set =
            serde_json::to_string(&SecretUpdateDto::Set { secret: "s".into() }).expect("serialize");
        assert_eq!(set, r#"{"action":"set","secret":"s"}"#);
    }

    #[test]
    fn new_host_accepts_the_minimum_the_ui_can_supply() {
        // The quick-add path sends only what a user actually typed.
        let json = r#"{"name":"box","hostname":"box.example.com","auth":"agent"}"#;
        let host: NewHostDto = serde_json::from_str(json).expect("deserialize");
        assert_eq!(host.port, 22, "port should default rather than be required");
        assert_eq!(host.username, "");
        assert_eq!(host.auth, AuthKindDto::Agent);
        assert!(host.tags.is_empty());
    }

    #[test]
    fn host_fields_are_camel_case_on_the_wire() {
        let json = serde_json::to_string(&super::HostOverridesDto {
            keepalive_secs: Some(30),
            ..super::HostOverridesDto::default()
        })
        .expect("serialize");
        assert!(json.contains("keepaliveSecs"), "got {json}");
    }
}
