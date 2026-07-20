use rusqlite::{OptionalExtension, params};

use crate::db::Store;
use crate::error::StoreError;
use crate::model::{Tag, TagId};
use crate::now;

pub struct TagRepo<'a> {
    store: &'a Store,
}

impl<'a> TagRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn list(&self) -> Result<Vec<Tag>, StoreError> {
        let conn = self.store.lock()?;
        let mut stmt = conn
            .prepare("SELECT id, name, color, created_at FROM tags ORDER BY name COLLATE NOCASE")?;
        let rows = stmt.query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<Tag>>>()?)
    }

    /// Create a tag, or return the existing one if the name is already taken.
    ///
    /// Idempotent by design: tags get created as a side effect of typing in a
    /// tag field, and "you already have that tag" is not an error worth
    /// surfacing to someone mid-edit.
    pub fn get_or_create(&self, name: &str, color: Option<&str>) -> Result<TagId, StoreError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("tag name cannot be empty".into()));
        }
        let conn = self.store.lock()?;
        let existing: Option<TagId> = conn
            .query_row(
                "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                [name],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        conn.execute(
            "INSERT INTO tags (name, color, created_at) VALUES (?1, ?2, ?3)",
            params![name, color, now()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn delete(&self, id: TagId) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        // host_tags rows cascade; hosts themselves are untouched.
        let changed = conn.execute("DELETE FROM tags WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::NotFound { entity: "tag", id });
        }
        Ok(())
    }
}
