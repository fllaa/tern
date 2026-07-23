//! `~/.ssh/config` import.
//!
//! Deliberately a **subset, one-way, non-authoritative** bulk-add with a
//! preview step (ADR-0017). `ssh_config` is a small language with a long tail —
//! `Match` blocks, `Include` graphs, tokens like `%h`, dozens of keywords — and
//! chasing all of it produces no product differentiation. What bounds the scope
//! is the promise that anything we do *not* understand is **listed**, never
//! silently dropped: a user can see exactly what did not come across.
//!
//! Two phases:
//!
//! * [`scan`] reads and reports. It writes nothing, so the UI can show a
//!   checklist with per-row conflict state before the user commits.
//! * [`apply`] upserts the chosen rows, keyed on `source_alias`, so
//!   re-importing after editing the file updates rather than duplicating.

mod lex;
mod parse;

use std::path::{Path, PathBuf};

use crate::db::Store;
use crate::error::StoreError;
use crate::model::{AuthKind, HostOverrides, HostSource, NewHost};

pub use parse::Warning;

/// One importable host, plus what would happen to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The `Host` alias, which becomes both the display name and the import key.
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthKind,
    pub key_path: Option<String>,
    pub proxy_jump: Option<String>,
    pub overrides: HostOverrides,
    /// What `apply` would do with this row.
    pub disposition: Disposition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// No stored host claims this alias.
    New,
    /// A previous import of this alias exists and would be updated.
    Update,
}

#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub source: String,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportOutcome {
    pub created: usize,
    pub updated: usize,
}

/// Default location of the user's ssh config.
pub fn default_path() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(
            || PathBuf::from(".ssh/config"),
            |home| PathBuf::from(home).join(".ssh/config"),
        )
}

/// Read a config and work out what importing it would do. Writes nothing.
pub fn scan(path: &Path, store: &Store) -> Result<Scan, StoreError> {
    let parsed = parse::parse_file(path);
    let mut candidates = Vec::new();

    // One candidate per concrete alias — `Host web1 web2` names two separately
    // connectable hosts. Settings are resolved per alias by walking every
    // stanza that matches it, so `Host *.legacy` reaches only `*.legacy` hosts
    // while `Host *` reaches all of them.
    for alias in parsed.aliases() {
        let resolved = parsed.resolve(&alias);
        let existing = store.hosts().find_by_source_alias(&alias)?;
        candidates.push(Candidate {
            // No HostName means the alias *is* the hostname.
            hostname: resolved.hostname.clone().unwrap_or_else(|| alias.clone()),
            port: resolved.port.unwrap_or(22),
            username: resolved.user.clone().unwrap_or_default(),
            // Never Password — an ssh_config contains no credentials.
            auth: if resolved.identity_file.is_some() {
                AuthKind::KeyFile
            } else {
                AuthKind::Agent
            },
            key_path: resolved.identity_file.clone(),
            proxy_jump: resolved.proxy_jump.clone(),
            overrides: HostOverrides {
                keepalive_secs: resolved.server_alive_interval,
                connect_timeout_secs: resolved.connect_timeout,
                // Carried across rather than dropped: `ForwardAgent yes` in a
                // config the user already wrote is them asking for it on that
                // host, which is exactly the per-host opt-in this setting is.
                // Absent stays absent, so nothing is switched on by importing.
                forward_agent: resolved.forward_agent,
                ..HostOverrides::default()
            },
            disposition: if existing.is_some() {
                Disposition::Update
            } else {
                Disposition::New
            },
            alias,
        });
    }

    Ok(Scan {
        source: path.display().to_string(),
        candidates,
        warnings: parsed.warnings,
    })
}

/// Commit the chosen candidates.
///
/// Idempotent by alias: importing the same file twice updates in place. Hosts
/// the user created by hand are never touched, because the lookup is scoped to
/// `source = 'ssh_config'`.
pub fn apply(store: &Store, chosen: &[Candidate]) -> Result<ImportOutcome, StoreError> {
    let mut outcome = ImportOutcome::default();

    for c in chosen {
        if let Some(mut existing) = store.hosts().find_by_source_alias(&c.alias)? {
            existing.hostname.clone_from(&c.hostname);
            existing.port = c.port;
            existing.username.clone_from(&c.username);
            existing.auth = c.auth;
            existing.key_path.clone_from(&c.key_path);
            existing.proxy_jump.clone_from(&c.proxy_jump);
            existing.overrides = c.overrides.clone();
            // `name` is deliberately left alone: the user may have renamed it,
            // and a re-import should not undo that.
            store.hosts().update(&existing)?;
            outcome.updated += 1;
        } else {
            store.hosts().create(&NewHost {
                folder_id: None,
                name: c.alias.clone(),
                hostname: c.hostname.clone(),
                port: c.port,
                username: c.username.clone(),
                auth: c.auth,
                // ssh_config has no fallback concept to import: OpenSSH derives
                // its own method order from the client config, so inventing a
                // chain here would attribute a choice to the file that the file
                // never made.
                auth_fallbacks: Vec::new(),
                secret_ref: None,
                key_path: c.key_path.clone(),
                overrides: c.overrides.clone(),
                proxy_jump: c.proxy_jump.clone(),
                source: HostSource::SshConfig,
                source_alias: Some(c.alias.clone()),
                color: None,
                notes: None,
            })?;
            outcome.created += 1;
        }
    }
    Ok(outcome)
}
