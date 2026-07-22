use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("could not create store directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// The database was written by a newer Tern than this binary. Opening it
    /// anyway risks writing rows the newer schema will misread, so refuse
    /// loudly instead — a downgrade should be a visible failure, not silent
    /// corruption.
    #[error("database schema v{db} is newer than this build supports (v{app}); upgrade Tern")]
    SchemaAhead { db: i64, app: i64 },

    /// The connection mutex was poisoned by a panic in another thread. The
    /// house pattern is a typed error rather than a re-panic (`unwrap_used`
    /// is denied workspace-wide).
    #[error("store lock poisoned")]
    LockPoisoned,

    #[error("no such {entity} with id {id}")]
    NotFound { entity: &'static str, id: i64 },

    #[error("{0}")]
    Invalid(String),

    /// Reparenting a folder under its own descendant would detach the subtree
    /// from the root. `SQLite` cannot express this declaratively, so it is
    /// checked in `FolderRepo::reparent`.
    #[error("cannot move folder {id} into its own descendant {target}")]
    FolderCycle { id: i64, target: i64 },
}
