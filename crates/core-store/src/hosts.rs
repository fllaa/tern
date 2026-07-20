use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::db::Store;
use crate::error::StoreError;
use crate::model::{AuthKind, Host, HostFilter, HostId, HostOverrides, HostSource, NewHost, TagId};
use crate::now;

/// Column order shared by every `SELECT` that builds a `Host`, so `row_to_host`
/// has exactly one layout to know about.
const HOST_COLUMNS: &str = "id, folder_id, name, hostname, port, username, auth_method, \
     secret_ref, key_path, term, keepalive_secs, keepalive_max, connect_timeout_secs, \
     window_size, reconnect_enabled, reconnect_max_attempts, proxy_jump, source, \
     source_alias, color, notes, last_connected_at, connect_count, created_at, updated_at";

pub struct HostRepo<'a> {
    store: &'a Store,
}

fn row_to_host(row: &Row<'_>) -> rusqlite::Result<Host> {
    let auth: String = row.get(6)?;
    let source: String = row.get(17)?;
    // Column type mismatches are a programming error, not user input, so map
    // them onto rusqlite's own error rather than inventing a variant.
    let to_sql_err = |e: StoreError| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    };
    Ok(Host {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        name: row.get(2)?,
        hostname: row.get(3)?,
        port: row.get(4)?,
        username: row.get(5)?,
        auth: AuthKind::try_from(auth.as_str()).map_err(to_sql_err)?,
        secret_ref: row.get(7)?,
        key_path: row.get(8)?,
        overrides: HostOverrides {
            term: row.get(9)?,
            keepalive_secs: row.get(10)?,
            keepalive_max: row.get(11)?,
            connect_timeout_secs: row.get(12)?,
            window_size: row.get(13)?,
            reconnect_enabled: row.get::<_, Option<i64>>(14)?.map(|v| v != 0),
            reconnect_max_attempts: row.get(15)?,
        },
        proxy_jump: row.get(16)?,
        source: HostSource::try_from(source.as_str()).map_err(to_sql_err)?,
        source_alias: row.get(18)?,
        color: row.get(19)?,
        notes: row.get(20)?,
        last_connected_at: row.get(21)?,
        connect_count: row.get(22)?,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
        // Filled by `attach_tags`; a JOIN here would fan out the host rows.
        tags: Vec::new(),
    })
}

fn tags_for(conn: &Connection, host_id: HostId) -> Result<Vec<TagId>, StoreError> {
    let mut stmt =
        conn.prepare("SELECT tag_id FROM host_tags WHERE host_id = ?1 ORDER BY tag_id")?;
    let rows = stmt.query_map([host_id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<TagId>>>()?)
}

impl<'a> HostRepo<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, draft: &NewHost) -> Result<HostId, StoreError> {
        let conn = self.store.lock()?;
        let ts = now();
        conn.execute(
            "INSERT INTO hosts (
                folder_id, name, hostname, port, username, auth_method, secret_ref, key_path,
                term, keepalive_secs, keepalive_max, connect_timeout_secs, window_size,
                reconnect_enabled, reconnect_max_attempts, proxy_jump, source, source_alias,
                color, notes, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21, ?21
             )",
            params![
                draft.folder_id,
                draft.name,
                draft.hostname,
                draft.port,
                draft.username,
                draft.auth.as_str(),
                draft.secret_ref,
                draft.key_path,
                draft.overrides.term,
                draft.overrides.keepalive_secs,
                draft.overrides.keepalive_max,
                draft.overrides.connect_timeout_secs,
                draft.overrides.window_size,
                draft.overrides.reconnect_enabled.map(i64::from),
                draft.overrides.reconnect_max_attempts,
                draft.proxy_jump,
                draft.source.as_str(),
                draft.source_alias,
                draft.color,
                draft.notes,
                ts,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn get(&self, id: HostId) -> Result<Option<Host>, StoreError> {
        let conn = self.store.lock()?;
        let sql = format!("SELECT {HOST_COLUMNS} FROM hosts WHERE id = ?1");
        let host = conn.query_row(&sql, [id], row_to_host).optional()?;
        match host {
            Some(mut h) => {
                h.tags = tags_for(&conn, id)?;
                Ok(Some(h))
            }
            None => Ok(None),
        }
    }

    pub fn list(&self, filter: &HostFilter) -> Result<Vec<Host>, StoreError> {
        let conn = self.store.lock()?;

        let mut sql = format!("SELECT {HOST_COLUMNS} FROM hosts WHERE 1 = 1");
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(q) = filter.query.as_ref().filter(|q| !q.trim().is_empty()) {
            sql.push_str(
                " AND (name LIKE ?* ESCAPE '\\' OR hostname LIKE ?* ESCAPE '\\' \
                 OR username LIKE ?* ESCAPE '\\')",
            );
            let pattern = format!("%{}%", escape_like(q.trim()));
            // Same pattern bound three times; positional placeholders are
            // rewritten below once the count is known.
            args.push(Box::new(pattern.clone()));
            args.push(Box::new(pattern.clone()));
            args.push(Box::new(pattern));
        }
        if let Some(folder) = filter.folder_id {
            sql.push_str(" AND folder_id = ?*");
            args.push(Box::new(folder));
        }
        for tag in &filter.tag_ids {
            // AND semantics: one EXISTS per tag, so a host must carry them all.
            sql.push_str(" AND EXISTS (SELECT 1 FROM host_tags ht WHERE ht.host_id = hosts.id AND ht.tag_id = ?*)");
            args.push(Box::new(*tag));
        }
        sql.push_str(" ORDER BY last_connected_at DESC NULLS LAST, name COLLATE NOCASE ASC");
        if let Some(limit) = filter.limit {
            sql.push_str(" LIMIT ?*");
            args.push(Box::new(i64::from(limit)));
        }

        let sql = number_placeholders(&sql);
        let mut stmt = conn.prepare(&sql)?;
        let params = rusqlite::params_from_iter(args.iter().map(AsRef::as_ref));
        let rows = stmt.query_map(params, row_to_host)?;
        let mut hosts = rows.collect::<rusqlite::Result<Vec<Host>>>()?;
        for host in &mut hosts {
            host.tags = tags_for(&conn, host.id)?;
        }
        Ok(hosts)
    }

    /// Full-record replace.
    ///
    /// A partial-patch type was considered and cut: nullable per-host
    /// overrides would need `Option<Option<T>>` tri-state on every field, and
    /// the edit form always holds the whole record anyway.
    pub fn update(&self, host: &Host) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        let changed = conn.execute(
            "UPDATE hosts SET
                folder_id = ?2, name = ?3, hostname = ?4, port = ?5, username = ?6,
                auth_method = ?7, secret_ref = ?8, key_path = ?9, term = ?10,
                keepalive_secs = ?11, keepalive_max = ?12, connect_timeout_secs = ?13,
                window_size = ?14, reconnect_enabled = ?15, reconnect_max_attempts = ?16,
                proxy_jump = ?17, source = ?18, source_alias = ?19, color = ?20,
                notes = ?21, updated_at = ?22
             WHERE id = ?1",
            params![
                host.id,
                host.folder_id,
                host.name,
                host.hostname,
                host.port,
                host.username,
                host.auth.as_str(),
                host.secret_ref,
                host.key_path,
                host.overrides.term,
                host.overrides.keepalive_secs,
                host.overrides.keepalive_max,
                host.overrides.connect_timeout_secs,
                host.overrides.window_size,
                host.overrides.reconnect_enabled.map(i64::from),
                host.overrides.reconnect_max_attempts,
                host.proxy_jump,
                host.source.as_str(),
                host.source_alias,
                host.color,
                host.notes,
                now(),
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound {
                entity: "host",
                id: host.id,
            });
        }
        Ok(())
    }

    pub fn delete(&self, id: HostId) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        // host_tags rows go with it via ON DELETE CASCADE. The caller is
        // responsible for best-effort deleting the keyring entry named by
        // `secret_ref` — this crate never touches the keyring.
        let changed = conn.execute("DELETE FROM hosts WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(StoreError::NotFound { entity: "host", id });
        }
        Ok(())
    }

    pub fn move_to_folder(&self, id: HostId, to: Option<i64>) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        let changed = conn.execute(
            "UPDATE hosts SET folder_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, to, now()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound { entity: "host", id });
        }
        Ok(())
    }

    pub fn set_tags(&self, id: HostId, tags: &[TagId]) -> Result<(), StoreError> {
        let mut conn = self.store.lock()?;
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM host_tags WHERE host_id = ?1", [id])?;
        {
            let mut stmt =
                tx.prepare("INSERT OR IGNORE INTO host_tags (host_id, tag_id) VALUES (?1, ?2)")?;
            for tag in tags {
                stmt.execute(params![id, tag])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Bump connection stats. Called on a successful connect, not on an
    /// attempt — a failed connect should not reorder the recent-hosts list.
    pub fn record_connection(&self, id: HostId, at: i64) -> Result<(), StoreError> {
        let conn = self.store.lock()?;
        conn.execute(
            "UPDATE hosts SET last_connected_at = ?2, connect_count = connect_count + 1 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    /// Look up an ssh_config-imported host by its alias, for idempotent
    /// re-import. Only `source = 'ssh_config'` rows are keyed this way.
    pub fn find_by_source_alias(&self, alias: &str) -> Result<Option<Host>, StoreError> {
        let conn = self.store.lock()?;
        let sql = format!(
            "SELECT {HOST_COLUMNS} FROM hosts WHERE source = 'ssh_config' AND source_alias = ?1"
        );
        let host = conn.query_row(&sql, [alias], row_to_host).optional()?;
        match host {
            Some(mut h) => {
                h.tags = tags_for(&conn, h.id)?;
                Ok(Some(h))
            }
            None => Ok(None),
        }
    }
}

/// `%`, `_` and the escape character itself are literal when a user types
/// them into the search box.
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Rewrites `?*` markers into sequential `?1`, `?2`, … so the filter builder
/// can append clauses without tracking indices by hand.
fn number_placeholders(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 16);
    let mut n = 0;
    let mut rest = sql;
    while let Some(pos) = rest.find("?*") {
        n += 1;
        out.push_str(&rest[..pos]);
        out.push('?');
        out.push_str(&n.to_string());
        rest = &rest[pos + 2..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::{escape_like, number_placeholders};

    #[test]
    fn placeholders_are_numbered_in_order() {
        assert_eq!(
            number_placeholders("a = ?* AND b = ?* AND c = ?*"),
            "a = ?1 AND b = ?2 AND c = ?3"
        );
        assert_eq!(number_placeholders("no markers"), "no markers");
    }

    #[test]
    fn like_wildcards_typed_by_the_user_are_literal() {
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        assert_eq!(escape_like("back\\slash"), "back\\\\slash");
        assert_eq!(escape_like("plain"), "plain");
    }
}
