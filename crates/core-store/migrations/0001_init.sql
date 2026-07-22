-- Phase 1 initial schema.
--
-- Two standing rules for everything in this file:
--   * No secrets. `hosts.secret_ref` is a keyring *account string*, never a
--     credential. Key material never touches SQLite.
--   * No host keys. Tern's own known_hosts file is the sole authority for
--     trust decisions; mirroring it here would create a second source of
--     truth for a security decision (ADR-0013).

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A table-level UNIQUE(parent_id, name) would NOT do the job: SQLite treats
-- NULLs as distinct, so two *root* folders could share a name. Folding NULL
-- to a sentinel in an expression index closes that hole.
CREATE UNIQUE INDEX folders_parent_name
  ON folders(ifnull(parent_id, -1), name COLLATE NOCASE);

CREATE TABLE hosts (
  id                     INTEGER PRIMARY KEY,
  folder_id              INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  name                   TEXT    NOT NULL,
  hostname               TEXT    NOT NULL,
  port                   INTEGER NOT NULL DEFAULT 22
                           CHECK (port BETWEEN 1 AND 65535),
  username               TEXT    NOT NULL DEFAULT '',

  -- Deliberately no CHECK constraint: keyboard-interactive is a known future
  -- value, and SQLite cannot ALTER a CHECK without a full table rebuild.
  -- Validated in Rust via `TryFrom<&str> for AuthKind` instead.
  auth_method            TEXT    NOT NULL DEFAULT 'agent',
  -- Keyring ACCOUNT string, e.g. "host/12/password". Never a secret itself.
  -- NULL means "prompt every time".
  secret_ref             TEXT,
  key_path               TEXT,

  -- Per-host overrides. NULL = inherit the global setting. These map 1:1 onto
  -- fields SessionConfig already has, so no new SessionConfig fields exist.
  term                   TEXT,
  keepalive_secs         INTEGER CHECK (keepalive_secs IS NULL OR keepalive_secs >= 0),
  keepalive_max          INTEGER,
  connect_timeout_secs   INTEGER,
  window_size            INTEGER,
  reconnect_enabled      INTEGER CHECK (reconnect_enabled IN (0, 1)),
  reconnect_max_attempts INTEGER,

  -- Parsed and stored in Phase 1; executed in Phase 2.
  proxy_jump             TEXT,

  -- Provenance, so re-importing ~/.ssh/config updates instead of duplicating.
  source                 TEXT    NOT NULL DEFAULT 'manual',
  source_alias           TEXT,

  color                  TEXT,
  notes                  TEXT,
  last_connected_at      INTEGER,
  connect_count          INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX hosts_folder         ON hosts(folder_id);
CREATE INDEX hosts_last_connected ON hosts(last_connected_at DESC);

-- Partial unique index: only ssh_config-sourced rows are keyed by alias, so
-- hand-created hosts are free to collide with an alias name.
CREATE UNIQUE INDEX hosts_source_alias
  ON hosts(source_alias) WHERE source = 'ssh_config';

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  color      TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX tags_name_nocase ON tags(name COLLATE NOCASE);

CREATE TABLE host_tags (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (host_id, tag_id)
) WITHOUT ROWID;

CREATE INDEX host_tags_tag ON host_tags(tag_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,   -- JSON scalar or object
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
