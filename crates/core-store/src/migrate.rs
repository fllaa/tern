//! Forward-only numbered migrations.
//!
//! Each migration runs in its own transaction *together with* its
//! `schema_migrations` insert, so a version is recorded if and only if its DDL
//! committed. `schema_migrations` is the single source of truth — deliberately
//! not `PRAGMA user_version`, which cannot carry names or timestamps and would
//! be a second thing to keep in step.
//!
//! Migrations are immutable once released. Editing an applied migration would
//! leave existing databases silently diverged from new ones; add a new file.

use rusqlite::{Connection, OptionalExtension};

use crate::error::StoreError;

/// `(version, name, sql)`, ascending. Append only.
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "init", include_str!("../migrations/0001_init.sql")),
    (
        2,
        "auth_fallbacks",
        include_str!("../migrations/0002_auth_fallbacks.sql"),
    ),
    (
        3,
        "snippets",
        include_str!("../migrations/0003_snippets.sql"),
    ),
    (
        4,
        "forward_agent",
        include_str!("../migrations/0004_forward_agent.sql"),
    ),
];

/// Highest schema version this binary knows how to produce.
pub fn target_version() -> i64 {
    MIGRATIONS.last().map_or(0, |(v, _, _)| *v)
}

fn applied_version(conn: &Connection) -> Result<i64, StoreError> {
    // A fresh database has no `schema_migrations` table at all. That is
    // version 0, not an error — so the lookup is `.optional()` rather than a
    // bootstrap special case.
    let exists = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(0);
    }
    // MAX() over an empty table yields a single NULL row, hence Option.
    let version: Option<i64> =
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })?;
    Ok(version.unwrap_or(0))
}

/// Apply every migration newer than the database's current version.
pub fn run(conn: &mut Connection) -> Result<(), StoreError> {
    let current = applied_version(conn)?;
    let target = target_version();
    if current > target {
        return Err(StoreError::SchemaAhead {
            db: current,
            app: target,
        });
    }

    for (version, name, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![version, name, crate::now()],
        )?;
        tx.commit()?;
    }
    Ok(())
}
