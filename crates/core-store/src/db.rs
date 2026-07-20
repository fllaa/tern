//! Connection ownership and pragmas.
//!
//! `rusqlite::Connection` is `Send` but not `Sync`, so the handle is an
//! `Arc<Mutex<Connection>>` and every repository method is **synchronous** —
//! it takes the lock and releases it before returning. Tauri commands call
//! these through `spawn_blocking`. Keeping the lock out of any `.await`
//! sidesteps clippy's `await_holding_lock` entirely and lets the repos be
//! tested without a runtime.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;

use crate::error::StoreError;
use crate::folders::FolderRepo;
use crate::hosts::HostRepo;
use crate::migrate;
use crate::settings::SettingsRepo;
use crate::tags::TagRepo;

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    /// Open (creating if absent) the database at `path` and migrate it to the
    /// current schema.
    ///
    /// The caller supplies the path — this crate resolves nothing on its own.
    /// That is what keeps it free of a `tauri` dependency (the desktop layer
    /// passes `app.path().app_config_dir()`) and makes `open_in_memory`
    /// trivially equivalent for tests.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent()
            && !dir.exists()
        {
            std::fs::create_dir_all(dir).map_err(|source| StoreError::CreateDir {
                path: dir.to_path_buf(),
                source,
            })?;
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// In-memory database, migrated. For tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut conn: Connection) -> Result<Self, StoreError> {
        // `foreign_keys` cannot be toggled inside a transaction, so all
        // pragmas are set before migrations run.
        //
        // WAL: readers never block the writer, which matters once the UI
        // lists hosts while a connect is recording `last_connected_at`.
        // synchronous=NORMAL is the standard WAL pairing — durable against
        // process crash, and the loss window on power failure is one commit
        // of host metadata, not credentials.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA synchronous = NORMAL;",
        )?;
        migrate::run(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, Connection>, StoreError> {
        self.conn.lock().map_err(|_| StoreError::LockPoisoned)
    }

    pub fn hosts(&self) -> HostRepo<'_> {
        HostRepo::new(self)
    }

    pub fn folders(&self) -> FolderRepo<'_> {
        FolderRepo::new(self)
    }

    pub fn tags(&self) -> TagRepo<'_> {
        TagRepo::new(self)
    }

    pub fn settings(&self) -> SettingsRepo<'_> {
        SettingsRepo::new(self)
    }

    /// Schema version currently applied. Exposed for diagnostics.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let conn = self.lock()?;
        let v: Option<i64> =
            conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
                r.get(0)
            })?;
        Ok(v.unwrap_or(0))
    }

    /// Every `CREATE` statement in the database, ordered deterministically.
    ///
    /// Backs the golden-schema test: migrations applied in sequence must
    /// produce byte-identical structure to what a fresh install builds, or an
    /// upgraded database and a new one silently diverge.
    pub fn schema_dump(&self) -> Result<String, StoreError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT sql FROM sqlite_master
              WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
              ORDER BY type, name",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let stmts = rows.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(stmts.join(";\n") + ";\n")
    }
}
