use rusqlite::{OptionalExtension, Row, params};

use crate::db::Store;
use crate::error::StoreError;
use crate::model::{NewSnippet, Snippet, SnippetId};
use crate::now;

/// Column order shared by every `SELECT` that builds a `Snippet`.
const SNIPPET_COLUMNS: &str = "id, name, body, description, created_at, updated_at";

pub struct SnippetRepo<'a> {
    store: &'a Store,
}

fn row_to_snippet(row: &Row<'_>) -> rusqlite::Result<Snippet> {
    Ok(Snippet {
        id: row.get(0)?,
        name: row.get(1)?,
        body: row.get(2)?,
        description: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

impl<'a> SnippetRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    /// Every snippet, by name. Small enough to list wholesale — the palette
    /// and the manager both want the full set.
    pub fn list(&self) -> Result<Vec<Snippet>, StoreError> {
        let conn = self.store.lock()?;
        let sql = format!("SELECT {SNIPPET_COLUMNS} FROM snippets ORDER BY name COLLATE NOCASE");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_snippet)?;
        Ok(rows.collect::<rusqlite::Result<Vec<Snippet>>>()?)
    }

    pub fn get(&self, id: SnippetId) -> Result<Option<Snippet>, StoreError> {
        let conn = self.store.lock()?;
        let sql = format!("SELECT {SNIPPET_COLUMNS} FROM snippets WHERE id = ?1");
        Ok(conn.query_row(&sql, [id], row_to_snippet).optional()?)
    }

    pub fn create(&self, draft: &NewSnippet) -> Result<SnippetId, StoreError> {
        let name = draft.name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("snippet name cannot be empty".into()));
        }
        let conn = self.store.lock()?;
        conn.execute(
            "INSERT INTO snippets (name, body, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![name, draft.body, draft.description, now()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Full-record replace, matching `HostRepo::update` — the edit form always
    /// holds the whole record, so a partial patch type would buy nothing.
    pub fn update(&self, snippet: &Snippet) -> Result<(), StoreError> {
        let name = snippet.name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("snippet name cannot be empty".into()));
        }
        let conn = self.store.lock()?;
        let changed = conn.execute(
            "UPDATE snippets SET name = ?2, body = ?3, description = ?4, updated_at = ?5
             WHERE id = ?1",
            params![snippet.id, name, snippet.body, snippet.description, now()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "snippet",
                id: snippet.id,
            });
        }
        Ok(())
    }

    pub fn delete(&self, id: SnippetId) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        let changed = conn.execute("DELETE FROM snippets WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "snippet",
                id,
            });
        }
        Ok(())
    }
}
