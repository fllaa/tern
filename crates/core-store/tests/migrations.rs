//! Migration-runner behaviour.
//!
//! The golden-schema test is the load-bearing one: it pins the exact shape the
//! migration chain produces, so a later migration that drifts from what a
//! fresh install builds fails here rather than in a user's database.

use tern_core_store::{Store, StoreError, schema_target_version};

#[test]
fn fresh_database_migrates_to_target() {
    let store = Store::open_in_memory().expect("open in-memory store");
    assert_eq!(
        store.schema_version().expect("read version"),
        schema_target_version()
    );
    assert!(
        schema_target_version() >= 1,
        "at least the init migration exists"
    );
}

#[test]
fn migrating_twice_is_a_no_op() {
    let dir = tempdir();
    let path = dir.join("tern.db");

    let first = Store::open(&path).expect("first open");
    let version = first.schema_version().expect("read version");
    drop(first);

    // Re-opening runs the migration pass again; already-applied versions must
    // be skipped rather than re-executed (which would fail on CREATE TABLE).
    let second = Store::open(&path).expect("second open");
    assert_eq!(second.schema_version().expect("read version"), version);

    let applied = rows_in(&path, "SELECT COUNT(*) FROM schema_migrations");
    assert_eq!(
        applied,
        i64::from(u32::try_from(schema_target_version()).expect("version fits")),
        "each migration recorded exactly once"
    );
}

#[test]
fn database_from_a_newer_tern_is_refused() {
    let dir = tempdir();
    let path = dir.join("tern.db");
    Store::open(&path).expect("create store");

    // Simulate a database written by a future build.
    {
        let conn = rusqlite::Connection::open(&path).expect("open raw");
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, 'future', 0)",
            [schema_target_version() + 5],
        )
        .expect("insert future migration");
    }

    match Store::open(&path) {
        Err(StoreError::SchemaAhead { db, app }) => {
            assert_eq!(db, schema_target_version() + 5);
            assert_eq!(app, schema_target_version());
        }
        Err(other) => panic!("expected SchemaAhead, got {other}"),
        Ok(_) => panic!("a newer schema must refuse to open, not silently proceed"),
    }
}

#[test]
fn foreign_keys_are_enforced() {
    let store = Store::open_in_memory().expect("open store");
    // A host pointing at a folder that does not exist must be rejected — this
    // only holds if PRAGMA foreign_keys survived the migration pass.
    let mut draft = tern_core_store::NewHost::manual("orphan", "example.com");
    draft.folder_id = Some(9999);
    assert!(
        store.hosts().create(&draft).is_err(),
        "foreign_keys pragma is not active"
    );
}

/// Pins the schema a fresh install produces. If this fails after adding a
/// migration, confirm the new shape is intended and update the golden file.
#[test]
fn schema_matches_golden() {
    let store = Store::open_in_memory().expect("open store");
    let actual = store.schema_dump().expect("dump schema");
    let golden = include_str!("golden/schema.sql");

    let normalize = |s: &str| {
        s.lines()
            .map(str::trim_end)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };

    assert_eq!(
        normalize(&actual),
        normalize(golden),
        "schema drifted from tests/golden/schema.sql"
    );
}

fn tempdir() -> std::path::PathBuf {
    // No `tempfile` dependency for this: a pid+counter directory under the
    // OS temp dir is enough, and the store crate should not grow a dev-dep
    // just to make a folder.
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tern-store-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn rows_in(path: &std::path::Path, sql: &str) -> i64 {
    let conn = rusqlite::Connection::open(path).expect("open raw");
    conn.query_row(sql, [], |r| r.get(0)).expect("count query")
}
