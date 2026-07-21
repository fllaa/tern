//! Typed JSON key-value settings.
//!
//! Values are JSON so a setting can grow from a scalar into an object without
//! a migration. The keys that matter are named constants rather than string
//! literals scattered across the desktop layer.

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::db::Store;
use crate::error::StoreError;
use crate::now;

/// Whether the first-run offer to import `~/.ssh/known_hosts` has been shown.
/// Tracked here because the `known_hosts` file itself has nowhere to record it.
pub const KEY_KNOWN_HOSTS_IMPORT_OFFERED: &str = "known_hosts.import_offered";

/// Write new `known_hosts` entries with hashed hostnames. Off by default: this
/// is Tern's own file, and unhashed entries are far easier to inspect and
/// support.
pub const KEY_HASH_KNOWN_HOSTS: &str = "known_hosts.hash";

/// Global default for auto-reconnect, overridable per host.
pub const KEY_RECONNECT_ENABLED: &str = "reconnect.enabled";
pub const KEY_RECONNECT_MAX_ATTEMPTS: &str = "reconnect.max_attempts";

/// Appearance, stored as one JSON blob under a single key. A blob rather than a
/// key each because it is always read and written whole (the settings dialog
/// holds the entire record), and one row is easier to reason about than four
/// that could drift out of step.
pub const KEY_APPEARANCE: &str = "appearance";

pub struct SettingsRepo<'a> {
    store: &'a Store,
}

impl<'a> SettingsRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, StoreError> {
        let conn = self.store.lock()?;
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        match raw {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    /// Read with a fallback. A value that fails to deserialize is treated as
    /// absent rather than fatal — a settings row corrupted by a downgrade
    /// should not stop the app from starting.
    pub fn get_or<T: DeserializeOwned>(&self, key: &str, default: T) -> Result<T, StoreError> {
        Ok(self.get::<T>(key).unwrap_or(None).unwrap_or(default))
    }

    pub fn set<T: Serialize>(&self, key: &str, value: &T) -> Result<(), StoreError> {
        let json = serde_json::to_string(value)?;
        let conn = self.store.lock()?;
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            params![key, json, now()],
        )?;
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        Ok(())
    }

    /// Every setting as raw JSON strings, for the settings UI to hydrate from
    /// in one round trip.
    pub fn all_raw(&self) -> Result<Vec<(String, String)>, StoreError> {
        let conn = self.store.lock()?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<(String, String)>>>()?)
    }
}
