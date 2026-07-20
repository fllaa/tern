use rusqlite::{OptionalExtension, params};

use crate::db::Store;
use crate::error::StoreError;
use crate::model::{Folder, FolderId};
use crate::now;

pub struct FolderRepo<'a> {
    store: &'a Store,
}

impl<'a> FolderRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    /// Every folder, ordered so a parent always precedes its children —
    /// callers can build the tree in one pass without recursion.
    pub fn tree(&self) -> Result<Vec<Folder>, StoreError> {
        let conn = self.store.lock()?;
        let mut stmt = conn.prepare(
            "WITH RECURSIVE walk(id, parent_id, name, position, created_at, updated_at, depth) AS (
                 SELECT id, parent_id, name, position, created_at, updated_at, 0
                   FROM folders WHERE parent_id IS NULL
                 UNION ALL
                 SELECT f.id, f.parent_id, f.name, f.position, f.created_at, f.updated_at, walk.depth + 1
                   FROM folders f JOIN walk ON f.parent_id = walk.id
             )
             SELECT id, parent_id, name, position, created_at, updated_at
               FROM walk ORDER BY depth, position, name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                name: r.get(2)?,
                position: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<Folder>>>()?)
    }

    pub fn create(&self, parent: Option<FolderId>, name: &str) -> Result<FolderId, StoreError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("folder name cannot be empty".into()));
        }
        let conn = self.store.lock()?;
        let ts = now();
        // Append to the end of the sibling list.
        let position: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE ifnull(parent_id, -1) = ifnull(?1, -1)",
            params![parent],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO folders (parent_id, name, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![parent, name, position, ts],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn rename(&self, id: FolderId, name: &str) -> Result<(), StoreError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StoreError::Invalid("folder name cannot be empty".into()));
        }
        let conn = self.store.lock()?;
        let changed = conn.execute(
            "UPDATE folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "folder",
                id,
            });
        }
        Ok(())
    }

    /// Move a folder under a new parent.
    ///
    /// `SQLite` cannot express "no cycles" declaratively, so the ancestry walk
    /// happens here. Without it, dragging a folder into its own child silently
    /// detaches that whole subtree from the root — it stops appearing in
    /// `tree()` and becomes unreachable in the UI.
    pub fn reparent(&self, id: FolderId, to: Option<FolderId>) -> Result<(), StoreError> {
        if Some(id) == to {
            return Err(StoreError::FolderCycle { id, target: id });
        }
        let conn = self.store.lock()?;

        if let Some(target) = to {
            let is_descendant: Option<i64> = conn
                .query_row(
                    "WITH RECURSIVE anc(id) AS (
                         SELECT ?1
                         UNION ALL
                         SELECT f.parent_id FROM folders f JOIN anc ON f.id = anc.id
                          WHERE f.parent_id IS NOT NULL
                     )
                     SELECT 1 FROM anc WHERE id = ?2 LIMIT 1",
                    params![target, id],
                    |r| r.get(0),
                )
                .optional()?;
            if is_descendant.is_some() {
                return Err(StoreError::FolderCycle { id, target });
            }
        }

        let changed = conn.execute(
            "UPDATE folders SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, to, now()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "folder",
                id,
            });
        }
        Ok(())
    }

    /// Delete a folder.
    ///
    /// Sub-folders cascade. Hosts do **not** — `ON DELETE SET NULL` orphans
    /// them to the root. Deleting a folder must never destroy a host record;
    /// the credentials and history behind it are worth more than the grouping.
    pub fn delete(&self, id: FolderId) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        let changed = conn.execute("DELETE FROM folders WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "folder",
                id,
            });
        }
        Ok(())
    }
}
