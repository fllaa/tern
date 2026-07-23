-- Snippets: reusable command bodies with `{{variable}}` placeholders.
--
-- Plaintext by design, and documented as such: a snippet is a command you would
-- have typed, not a credential. Secrets stay in the OS keyring behind a host
-- record — nothing in this table is encrypted, redacted, or kept out of an
-- export, so a password pasted in here would be a password on disk.
--
-- No index, for the same reason hosts has no FTS5 (see 0001): this is a list of
-- a few hundred rows at most, ordered by name, and an index would be a
-- migration liability for no measurable gain.
CREATE TABLE snippets (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
