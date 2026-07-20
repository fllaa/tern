//! Host / folder / tag / known-hosts commands.
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
use tern_core_store::{AuthKind, HostFilter, HostOverrides, NewHost, Store};
use tern_proto::{
    AuthKindDto, FolderDto, HostDto, HostFilterDto, HostOverridesDto, KnownHostEntryDto,
    KnownHostsImportReportDto, NewHostDto, SecretUpdateDto, TagDto,
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
        // deleted the account name is unrecoverable and the entry would linger
        // in the OS keychain forever. A keyring failure must not block the
        // delete the user asked for.
        if let Ok(Some(host)) = store.hosts().get(id)
            && let Some(account) = host.secret_ref.as_deref()
        {
            let _ = auth::clear_secret(account);
        }
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
