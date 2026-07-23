//! Host / folder / tag / snippet / known-hosts commands.
//!
//! Every one of these runs the (synchronous) repo call on a blocking thread.
//! `core-store` holds its connection behind a `std::sync::Mutex`, so touching
//! it from an async context would either hold a lock across an await or block
//! a runtime worker; `spawn_blocking` avoids both.
//!
//! Note there are no capability entries for any of this: app-defined commands
//! registered through `generate_handler!` are not ACL-gated in Tauri 2 — only
//! plugin commands are. `capabilities/default.json` stays as it is.

use tauri::State;
use tern_core_ssh::KnownHostsFile;
use tern_core_store::{AuthKind, HostFilter, HostOverrides, NewHost, NewSnippet, Snippet, Store};
use tern_core_vault::KeyringAvailability;
use tern_proto::{
    AppearanceDto, AuthKindDto, FolderDto, HostDto, HostFilterDto, HostOverridesDto, KeyInfoDto,
    KeyringStatusDto, KnownHostEntryDto, KnownHostsImportReportDto, NewHostDto, NewSnippetDto,
    SecretUpdateDto, SnippetDto, SshConfigCandidateDto, SshConfigImportResultDto, SshConfigScanDto,
    SshConfigWarningDto, TagDto,
};

use crate::auth;
use crate::commands::AppState;

/// Run a blocking store operation off the async runtime.
///
/// The closure gets an owned `Store` clone (it is an `Arc` inside), so nothing
/// borrows across the thread boundary.
async fn blocking<T, F>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Store) -> Result<T, String> + Send + 'static,
{
    let store = state.store();
    tauri::async_runtime::spawn_blocking(move || f(store))
        .await
        .map_err(|e| format!("store task failed: {e}"))?
}

fn auth_kind(dto: AuthKindDto) -> AuthKind {
    match dto {
        AuthKindDto::Agent => AuthKind::Agent,
        AuthKindDto::KeyFile => AuthKind::KeyFile,
        AuthKindDto::Password => AuthKind::Password,
    }
}

fn auth_kind_dto(kind: AuthKind) -> AuthKindDto {
    match kind {
        AuthKind::Agent => AuthKindDto::Agent,
        AuthKind::KeyFile => AuthKindDto::KeyFile,
        AuthKind::Password => AuthKindDto::Password,
    }
}

fn overrides(dto: &HostOverridesDto) -> HostOverrides {
    HostOverrides {
        term: dto.term.clone(),
        keepalive_secs: dto.keepalive_secs,
        keepalive_max: dto.keepalive_max,
        connect_timeout_secs: dto.connect_timeout_secs,
        window_size: dto.window_size,
        reconnect_enabled: dto.reconnect_enabled,
        reconnect_max_attempts: dto.reconnect_max_attempts,
    }
}

fn overrides_dto(o: &HostOverrides) -> HostOverridesDto {
    HostOverridesDto {
        term: o.term.clone(),
        keepalive_secs: o.keepalive_secs,
        keepalive_max: o.keepalive_max,
        connect_timeout_secs: o.connect_timeout_secs,
        window_size: o.window_size,
        reconnect_enabled: o.reconnect_enabled,
        reconnect_max_attempts: o.reconnect_max_attempts,
    }
}

/// Map a stored host onto the wire type.
///
/// `secret_ref` becomes a bare `has_secret` boolean — neither the credential
/// nor the keyring account name it lives under has any business in the
/// webview.
pub fn host_dto(host: &tern_core_store::Host) -> HostDto {
    HostDto {
        id: host.id,
        folder_id: host.folder_id,
        name: host.name.clone(),
        hostname: host.hostname.clone(),
        port: host.port,
        username: host.username.clone(),
        auth: auth_kind_dto(host.auth),
        auth_fallbacks: host
            .auth_fallbacks
            .iter()
            .map(|k| auth_kind_dto(*k))
            .collect(),
        has_secret: host.secret_ref.is_some(),
        key_path: host.key_path.clone(),
        overrides: overrides_dto(&host.overrides),
        proxy_jump: host.proxy_jump.clone(),
        source: host.source.as_str().to_string(),
        color: host.color.clone(),
        notes: host.notes.clone(),
        last_connected_at: host.last_connected_at,
        connect_count: host.connect_count,
        tags: host.tags.clone(),
    }
}

// ── hosts ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_hosts(
    state: State<'_, AppState>,
    filter: HostFilterDto,
) -> Result<Vec<HostDto>, String> {
    blocking(&state, move |store| {
        let f = HostFilter {
            query: filter.query,
            folder_id: filter.folder_id,
            tag_ids: filter.tag_ids,
            limit: filter.limit,
        };
        let hosts = store.hosts().list(&f).map_err(|e| e.to_string())?;
        Ok(hosts.iter().map(host_dto).collect())
    })
    .await
}

#[tauri::command]
pub async fn get_host(state: State<'_, AppState>, id: i64) -> Result<Option<HostDto>, String> {
    blocking(&state, move |store| {
        let host = store.hosts().get(id).map_err(|e| e.to_string())?;
        Ok(host.as_ref().map(host_dto))
    })
    .await
}

#[tauri::command]
pub async fn create_host(
    state: State<'_, AppState>,
    host: NewHostDto,
    secret: Option<String>,
) -> Result<i64, String> {
    let id = blocking(&state, move |store| {
        let draft = NewHost {
            folder_id: host.folder_id,
            name: host.name,
            hostname: host.hostname,
            port: host.port,
            username: host.username,
            auth: auth_kind(host.auth),
            auth_fallbacks: host.auth_fallbacks.iter().map(|k| auth_kind(*k)).collect(),
            secret_ref: None,
            key_path: host.key_path,
            overrides: overrides(&host.overrides),
            proxy_jump: host.proxy_jump,
            source: tern_core_store::HostSource::Manual,
            source_alias: None,
            color: host.color,
            notes: host.notes,
        };
        let id = store.hosts().create(&draft).map_err(|e| e.to_string())?;
        if !host.tags.is_empty() {
            store
                .hosts()
                .set_tags(id, &host.tags)
                .map_err(|e| e.to_string())?;
        }
        Ok(id)
    })
    .await?;

    // The keyring account name embeds the host id, so the secret can only be
    // stored once the row exists.
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        store_secret_for(&state, id, &secret).await?;
    }
    Ok(id)
}

#[tauri::command]
pub async fn update_host(
    state: State<'_, AppState>,
    host: HostDto,
    secret: SecretUpdateDto,
) -> Result<(), String> {
    let id = host.id;
    let tags = host.tags.clone();

    blocking(&state, move |store| {
        let mut existing = store
            .hosts()
            .get(host.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no such host {}", host.id))?;

        existing.folder_id = host.folder_id;
        existing.name = host.name;
        existing.hostname = host.hostname;
        existing.port = host.port;
        existing.username = host.username;
        existing.auth = auth_kind(host.auth);
        existing.auth_fallbacks = host.auth_fallbacks.iter().map(|k| auth_kind(*k)).collect();
        existing.key_path = host.key_path;
        existing.overrides = overrides(&host.overrides);
        existing.proxy_jump = host.proxy_jump;
        existing.color = host.color;
        existing.notes = host.notes;
        // `secret_ref` is intentionally not taken from the DTO — the webview
        // never sees it, so it cannot round-trip it. It is maintained below,
        // from the SecretUpdateDto.

        store.hosts().update(&existing).map_err(|e| e.to_string())?;
        store
            .hosts()
            .set_tags(host.id, &tags)
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await?;

    match secret {
        SecretUpdateDto::Unchanged => Ok(()),
        SecretUpdateDto::Set { secret } => store_secret_for(&state, id, &secret).await,
        SecretUpdateDto::Clear => clear_secret_for(&state, id).await,
    }
}

async fn store_secret_for(
    state: &State<'_, AppState>,
    id: i64,
    secret: &str,
) -> Result<(), String> {
    let secret = secret.to_string();
    blocking(state, move |store| {
        let mut host = store
            .hosts()
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no such host {id}"))?;
        let Some(account) = auth::account_for(&host) else {
            // Agent auth has nothing to store; silently ignoring a supplied
            // secret is friendlier than erroring on a field the form may have
            // left populated after an auth-method switch.
            return Ok(());
        };
        auth::set_secret(&account, &secret).map_err(|e| e.to_string())?;
        host.secret_ref = Some(account);
        store.hosts().update(&host).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

async fn clear_secret_for(state: &State<'_, AppState>, id: i64) -> Result<(), String> {
    blocking(state, move |store| {
        let mut host = store
            .hosts()
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no such host {id}"))?;
        if let Some(account) = host.secret_ref.take() {
            auth::clear_secret(&account).map_err(|e| e.to_string())?;
            store.hosts().update(&host).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_host(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    blocking(&state, move |store| {
        // Best-effort keyring cleanup before the row goes: once the record is
        // deleted the account names are unrecoverable and the entries would
        // linger in the OS keychain forever. Both accounts are cleared by id
        // rather than the current `secret_ref`, because a host's credentialed
        // method may have changed over its life and left a secret under the
        // other account. A keyring failure must not block the delete.
        let _ = auth::clear_secret(&auth::password_account(id));
        let _ = auth::clear_secret(&auth::passphrase_account(id));
        store.hosts().delete(id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn move_host(
    state: State<'_, AppState>,
    id: i64,
    folder_id: Option<i64>,
) -> Result<(), String> {
    blocking(&state, move |store| {
        store
            .hosts()
            .move_to_folder(id, folder_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn set_host_tags(
    state: State<'_, AppState>,
    id: i64,
    tag_ids: Vec<i64>,
) -> Result<(), String> {
    blocking(&state, move |store| {
        store
            .hosts()
            .set_tags(id, &tag_ids)
            .map_err(|e| e.to_string())
    })
    .await
}

// ── folders ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<FolderDto>, String> {
    blocking(&state, |store| {
        let folders = store.folders().tree().map_err(|e| e.to_string())?;
        Ok(folders
            .into_iter()
            .map(|f| FolderDto {
                id: f.id,
                parent_id: f.parent_id,
                name: f.name,
                position: f.position,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn create_folder(
    state: State<'_, AppState>,
    parent_id: Option<i64>,
    name: String,
) -> Result<i64, String> {
    blocking(&state, move |store| {
        store
            .folders()
            .create(parent_id, &name)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    blocking(&state, move |store| {
        store.folders().rename(id, &name).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn move_folder(
    state: State<'_, AppState>,
    id: i64,
    parent_id: Option<i64>,
) -> Result<(), String> {
    blocking(&state, move |store| {
        store
            .folders()
            .reparent(id, parent_id)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    blocking(&state, move |store| {
        store.folders().delete(id).map_err(|e| e.to_string())
    })
    .await
}

// ── tags ─────────────────────────────────────────────────────────────────

fn snippet_dto(s: Snippet) -> SnippetDto {
    SnippetDto {
        id: s.id,
        name: s.name,
        body: s.body,
        description: s.description,
    }
}

#[tauri::command]
pub async fn list_snippets(state: State<'_, AppState>) -> Result<Vec<SnippetDto>, String> {
    blocking(&state, |store| {
        let snippets = store.snippets().list().map_err(|e| e.to_string())?;
        Ok(snippets.into_iter().map(snippet_dto).collect())
    })
    .await
}

#[tauri::command]
pub async fn create_snippet(
    state: State<'_, AppState>,
    snippet: NewSnippetDto,
) -> Result<i64, String> {
    blocking(&state, move |store| {
        store
            .snippets()
            .create(&NewSnippet {
                name: snippet.name,
                body: snippet.body,
                description: snippet.description,
            })
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn update_snippet(state: State<'_, AppState>, snippet: SnippetDto) -> Result<(), String> {
    blocking(&state, move |store| {
        // Read-then-replace: the DTO carries no timestamps, so the stored
        // `created_at` is preserved rather than reset by the edit.
        let existing = store
            .snippets()
            .get(snippet.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no such snippet {}", snippet.id))?;
        store
            .snippets()
            .update(&Snippet {
                name: snippet.name,
                body: snippet.body,
                description: snippet.description,
                ..existing
            })
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    blocking(&state, move |store| {
        store.snippets().delete(id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagDto>, String> {
    blocking(&state, |store| {
        let tags = store.tags().list().map_err(|e| e.to_string())?;
        Ok(tags
            .into_iter()
            .map(|t| TagDto {
                id: t.id,
                name: t.name,
                color: t.color,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<i64, String> {
    blocking(&state, move |store| {
        store
            .tags()
            .get_or_create(&name, color.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    blocking(&state, move |store| {
        store.tags().delete(id).map_err(|e| e.to_string())
    })
    .await
}

// ── known hosts ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_known_hosts(
    state: State<'_, AppState>,
) -> Result<Vec<KnownHostEntryDto>, String> {
    let file = state.known_hosts_path();
    tauri::async_runtime::spawn_blocking(move || {
        let entries = KnownHostsFile::at(file)
            .entries()
            .map_err(|e| e.to_string())?;
        Ok(entries
            .into_iter()
            .map(|e| KnownHostEntryDto {
                line: e.line,
                patterns: e.patterns,
                algorithm: e.algorithm,
                fingerprint: e.fingerprint,
                marker: e.marker,
                hashed: e.hashed,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("known_hosts task failed: {e}"))?
}

/// Forget a host key. The deliberate second step out of a changed-key state —
/// there is no "trust anyway" inline, so recovery is remove-then-reconnect,
/// which re-presents as ordinary first contact.
#[tauri::command]
pub async fn remove_known_host(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> Result<usize, String> {
    let file = state.known_hosts_path();
    tauri::async_runtime::spawn_blocking(move || {
        KnownHostsFile::at(file)
            .remove(&host, port)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("known_hosts task failed: {e}"))?
}

/// Copy entries from another `known_hosts` file (defaults to `~/.ssh/known_hosts`).
/// The source is opened read-only and never modified.
#[tauri::command]
pub async fn import_known_hosts(
    state: State<'_, AppState>,
    source: Option<String>,
) -> Result<KnownHostsImportReportDto, String> {
    let file = state.known_hosts_path();
    let source = source.map_or_else(default_user_known_hosts, std::path::PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        let report = KnownHostsFile::at(file)
            .import_from(&source)
            .map_err(|e| e.to_string())?;
        Ok(KnownHostsImportReportDto {
            total: report.total,
            imported: report.imported,
            duplicates: report.duplicates,
            skipped_cert_authority: report.skipped_cert_authority,
            malformed: report.malformed,
        })
    })
    .await
    .map_err(|e| format!("known_hosts task failed: {e}"))?
}

fn default_user_known_hosts() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(
            || std::path::PathBuf::from(".ssh/known_hosts"),
            |home| std::path::PathBuf::from(home).join(".ssh/known_hosts"),
        )
}

// ── ssh_config import ────────────────────────────────────────────────────

fn warning_dto(w: &tern_core_store::SshConfigWarning) -> SshConfigWarningDto {
    use tern_core_store::SshConfigWarning as W;
    match w {
        W::MatchUnsupported { file, line } => SshConfigWarningDto::MatchUnsupported {
            file: file.clone(),
            line: *line,
        },
        W::IncludeCycle { file, line } => SshConfigWarningDto::IncludeCycle {
            file: file.clone(),
            line: *line,
        },
        W::IncludeUnreadable {
            file,
            line,
            pattern,
        } => SshConfigWarningDto::IncludeUnreadable {
            file: file.clone(),
            line: *line,
            pattern: pattern.clone(),
        },
        W::UnsupportedKeyword {
            file,
            line,
            keyword,
        } => SshConfigWarningDto::UnsupportedKeyword {
            file: file.clone(),
            line: *line,
            keyword: keyword.clone(),
        },
    }
}

fn candidate_dto(c: &tern_core_store::SshConfigCandidate) -> SshConfigCandidateDto {
    SshConfigCandidateDto {
        alias: c.alias.clone(),
        hostname: c.hostname.clone(),
        port: c.port,
        username: c.username.clone(),
        auth: auth_kind_dto(c.auth),
        key_path: c.key_path.clone(),
        proxy_jump: c.proxy_jump.clone(),
        overrides: overrides_dto(&c.overrides),
        disposition: match c.disposition {
            tern_core_store::SshConfigDisposition::New => "new".into(),
            tern_core_store::SshConfigDisposition::Update => "update".into(),
        },
    }
}

/// Read `~/.ssh/config` and report what importing it would do.
///
/// Writes nothing — the UI shows a checklist and the user commits explicitly,
/// so "cancel" genuinely means cancel.
#[tauri::command]
pub async fn scan_ssh_config(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<SshConfigScanDto, String> {
    let path = path.map_or_else(
        tern_core_store::default_ssh_config_path,
        std::path::PathBuf::from,
    );
    blocking(&state, move |store| {
        let scan = tern_core_store::scan_ssh_config(&path, &store).map_err(|e| e.to_string())?;
        Ok(SshConfigScanDto {
            source: scan.source,
            candidates: scan.candidates.iter().map(candidate_dto).collect(),
            warnings: scan.warnings.iter().map(warning_dto).collect(),
        })
    })
    .await
}

/// Commit the chosen candidates. Idempotent by alias, so re-importing after
/// editing the file updates rather than duplicating.
#[tauri::command]
pub async fn import_ssh_config(
    state: State<'_, AppState>,
    aliases: Vec<String>,
    path: Option<String>,
) -> Result<SshConfigImportResultDto, String> {
    let path = path.map_or_else(
        tern_core_store::default_ssh_config_path,
        std::path::PathBuf::from,
    );
    blocking(&state, move |store| {
        // Re-scan rather than trusting candidates round-tripped through the
        // webview: the file is the source of truth, and this way the UI cannot
        // submit a host it never actually read.
        let scan = tern_core_store::scan_ssh_config(&path, &store).map_err(|e| e.to_string())?;
        let chosen: Vec<_> = scan
            .candidates
            .into_iter()
            .filter(|c| aliases.contains(&c.alias))
            .collect();
        let outcome =
            tern_core_store::apply_ssh_config(&store, &chosen).map_err(|e| e.to_string())?;
        Ok(SshConfigImportResultDto {
            created: outcome.created,
            updated: outcome.updated,
        })
    })
    .await
}

/// Whether credentials can be stored on this machine.
///
/// Called before the UI offers to remember a password or passphrase. Cheap and
/// side-effect free — it reads an account that does not exist and reports
/// whether the store answered "no such entry" (working) or failed outright.
#[tauri::command]
pub async fn keyring_status() -> Result<KeyringStatusDto, String> {
    // A keyring call can block on D-Bus or a Keychain prompt, so it does not
    // belong on the async runtime's thread.
    tauri::async_runtime::spawn_blocking(|| match auth::keyring_availability() {
        KeyringAvailability::Available => KeyringStatusDto {
            available: true,
            reason: None,
        },
        KeyringAvailability::Unavailable { reason } => KeyringStatusDto {
            available: false,
            reason: Some(reason),
        },
    })
    .await
    .map_err(|e| format!("keyring probe failed: {e}"))
}

fn key_info_dto(info: &tern_core_ssh::KeyInfo) -> KeyInfoDto {
    KeyInfoDto {
        format: info.format.as_str().to_owned(),
        ppk_version: match info.format {
            tern_core_ssh::KeyFormat::Ppk { version } => Some(version),
            _ => None,
        },
        encrypted: info.encrypted,
        algorithm: info.algorithm.clone(),
        fingerprint: info.fingerprint.clone(),
        comment: info.comment.clone(),
    }
}

/// Describe a private key file without unlocking it.
///
/// Takes no passphrase and does not fail on encrypted keys — the UI calls this
/// to decide whether to ask for one at all.
#[tauri::command]
pub async fn inspect_key(path: String) -> Result<KeyInfoDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tern_core_ssh::inspect(&path)
            .map(|info| key_info_dto(&info))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("key inspection failed: {e}"))?
}

/// Check a passphrase against a key file before it is written to the keyring.
///
/// Storing an unverified passphrase turns a typo into a connection failure much
/// later, somewhere far less obviously connected to the mistake.
///
/// The passphrase arrives over IPC because only the webview has it at this
/// point; it is used and dropped here, never stored by this call.
#[tauri::command]
pub async fn verify_key_passphrase(
    path: String,
    passphrase: Option<String>,
) -> Result<KeyInfoDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tern_core_ssh::unlock(&path, passphrase.as_deref())
            .map(|info| key_info_dto(&info))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("key unlock failed: {e}"))?
}

/// Read appearance settings, falling back to defaults on first run.
#[tauri::command]
pub async fn get_appearance(state: State<'_, AppState>) -> Result<AppearanceDto, String> {
    blocking(&state, |store| {
        Ok(store
            .settings()
            .get::<AppearanceDto>(tern_core_store::KEY_APPEARANCE)
            .map_err(|e| e.to_string())?
            .unwrap_or_default())
    })
    .await
}

/// Persist appearance settings. The webview applies them live; this only stores.
#[tauri::command]
pub async fn set_appearance(
    state: State<'_, AppState>,
    appearance: AppearanceDto,
) -> Result<(), String> {
    blocking(&state, move |store| {
        store
            .settings()
            .set(tern_core_store::KEY_APPEARANCE, &appearance)
            .map_err(|e| e.to_string())
    })
    .await
}
