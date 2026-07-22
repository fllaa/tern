//! Tern's own `known_hosts` file.
//!
//! Tern never writes the user's `~/.ssh/known_hosts` — it keeps its own file
//! and offers a one-way, read-only import (ADR-0013). A young client holding a
//! write handle on the file every other SSH tool depends on is exactly the
//! trust-killer the risk register warns about.
//!
//! Entry *parsing* comes from `ssh-key`, which already handles `|1|` hashed
//! hostnames, `[host]:port` bracket forms, comma-separated pattern lists, and
//! the `@cert-authority` / `@revoked` markers. Matching and the verdict are
//! ours, because that is the part neither library provides:
//!
//! * russh's own `known_hosts` matches only exact and hashed names — no `*`/`?`
//!   wildcards, which real files use.
//! * It also mis-parses marker lines: `@revoked host ssh-ed25519 AAAA…` shifts
//!   the field positions, so the marker is read as the host pattern, never
//!   matches, and the line is silently ignored. A revoked key would present as
//!   *unknown* and get a friendly first-contact prompt.
//! * Its check returns a bare bool, so the recorded fingerprint cannot reach
//!   the changed-key UI, which is the one place a user needs it.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use hmac::{Hmac, KeyInit as _, Mac};
use russh::keys::ssh_key::known_hosts::{Entry, HostPatterns, Marker};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

#[derive(Debug, thiserror::Error)]
pub enum KnownHostsError {
    #[error("known_hosts io ({path}): {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not encode host key: {0}")]
    Encode(String),
}

/// What the file says about a host key we were just offered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// An entry matches this exact key. Connect silently.
    Trusted,
    /// Nothing on file. First contact — prompt (TOFU).
    Unknown,
    /// An entry matches the host *and the same algorithm*, with different key
    /// bytes. This is the alarming one: either the server was rebuilt or
    /// someone is between you and it.
    Changed {
        line: usize,
        recorded_algorithm: String,
        recorded_fingerprint: String,
    },
    /// An `@revoked` entry matches. Refuse regardless of anything else.
    Revoked { line: usize },
}

/// One parsed entry, for the known-hosts management UI.
#[derive(Debug, Clone)]
pub struct KnownHostEntry {
    pub line: usize,
    pub patterns: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub marker: Option<String>,
    /// Hashed entries cannot be reversed, so the UI cannot show a hostname.
    pub hashed: bool,
}

/// Result of importing another `known_hosts` file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportReport {
    pub total: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub skipped_cert_authority: usize,
    pub malformed: usize,
}

pub struct KnownHostsFile {
    path: PathBuf,
}

impl KnownHostsFile {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<String, KnownHostsError> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(s),
            // A file that does not exist yet simply knows no hosts.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(source) => Err(KnownHostsError::Io {
                path: self.path.clone(),
                source,
            }),
        }
    }

    /// Decide whether `key` is the key we expect for `host:port`.
    ///
    /// A malformed line is skipped rather than failing the whole file: one
    /// corrupt entry must not lock the user out of every host they know.
    pub fn verify(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<HostKeyVerdict, KnownHostsError> {
        let contents = self.read()?;
        let target = match_target(host, port);
        let offered_alg = key.algorithm().to_string();

        let mut changed: Option<HostKeyVerdict> = None;

        for (line_no, entry) in parsed_entries(&contents) {
            if !patterns_match(entry.host_patterns(), &target, host) {
                continue;
            }
            match entry.marker() {
                // "should not be allowed to connect regardless of any other
                // entry" — so this short-circuits even a matching good key.
                Some(Marker::Revoked) => return Ok(HostKeyVerdict::Revoked { line: line_no }),
                // Certificate authorities are Phase 2; an unrecognised CA line
                // must not be mistaken for a mismatched host key.
                Some(Marker::CertAuthority) => continue,
                None => {}
            }
            // Compare key *material*, not the whole PublicKey: its derived
            // PartialEq includes the comment field, so an entry carrying a
            // comment would never match the same key without one.
            if entry.public_key().key_data() == key.key_data() {
                return Ok(HostKeyVerdict::Trusted);
            }
            // Only a *same-algorithm* mismatch is a changed key. A host with an
            // ed25519 entry that now offers RSA has simply not been recorded
            // under that algorithm — that is first contact, not an attack.
            let recorded_alg = entry.public_key().algorithm().to_string();
            if recorded_alg == offered_alg && changed.is_none() {
                changed = Some(HostKeyVerdict::Changed {
                    line: line_no,
                    recorded_algorithm: recorded_alg,
                    recorded_fingerprint: entry
                        .public_key()
                        .fingerprint(HashAlg::Sha256)
                        .to_string(),
                });
            }
        }

        Ok(changed.unwrap_or(HostKeyVerdict::Unknown))
    }

    /// Append a trusted key. Called after the user accepts a TOFU prompt.
    ///
    /// Writes unhashed unless asked otherwise: this is Tern's own file, and an
    /// unhashed entry is far easier to inspect and support.
    pub fn learn(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
        hashed: bool,
    ) -> Result<(), KnownHostsError> {
        let target = match_target(host, port);
        let pattern = if hashed {
            hash_pattern(&target)
        } else {
            target
        };
        let key_part = openssh_key_part(key)?;

        if let Some(dir) = self.path.parent()
            && !dir.exists()
        {
            std::fs::create_dir_all(dir).map_err(|source| KnownHostsError::Io {
                path: dir.to_path_buf(),
                source,
            })?;
        }

        // A file whose last line lacks a newline would otherwise get our entry
        // glued onto the end of it, silently corrupting both.
        let existing = self.read()?;
        let needs_newline = !existing.is_empty() && !existing.ends_with('\n');

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path)
            .map_err(|source| KnownHostsError::Io {
                path: self.path.clone(),
                source,
            })?;
        let mut line = String::new();
        if needs_newline {
            line.push('\n');
        }
        line.push_str(&pattern);
        line.push(' ');
        line.push_str(&key_part);
        line.push('\n');
        file.write_all(line.as_bytes())
            .map_err(|source| KnownHostsError::Io {
                path: self.path.clone(),
                source,
            })?;
        Ok(())
    }

    /// Drop every entry matching `host:port`. Returns how many were removed.
    ///
    /// This is the deliberate second step out of a changed-key state: the
    /// changed-key dialog must never offer "trust anyway" inline, so recovery
    /// is remove-then-reconnect, which re-prompts as first contact.
    pub fn remove(&self, host: &str, port: u16) -> Result<usize, KnownHostsError> {
        let contents = self.read()?;
        let target = match_target(host, port);

        let mut kept = String::with_capacity(contents.len());
        let mut removed = 0;
        for line in contents.lines() {
            let matched = parse_entry(line)
                .is_some_and(|entry| patterns_match(entry.host_patterns(), &target, host));
            if matched {
                removed += 1;
            } else {
                kept.push_str(line);
                kept.push('\n');
            }
        }
        if removed > 0 {
            std::fs::write(&self.path, kept).map_err(|source| KnownHostsError::Io {
                path: self.path.clone(),
                source,
            })?;
        }
        Ok(removed)
    }

    /// Every parseable entry, for the management UI.
    pub fn entries(&self) -> Result<Vec<KnownHostEntry>, KnownHostsError> {
        let contents = self.read()?;
        Ok(parsed_entries(&contents)
            .map(|(line, entry)| KnownHostEntry {
                line,
                patterns: patterns_display(entry.host_patterns()),
                algorithm: entry.public_key().algorithm().to_string(),
                fingerprint: entry.public_key().fingerprint(HashAlg::Sha256).to_string(),
                marker: entry.marker().map(|m| m.as_str().to_string()),
                hashed: matches!(entry.host_patterns(), HostPatterns::HashedName { .. }),
            })
            .collect())
    }

    /// Copy entries in from another `known_hosts` file. The source is opened
    /// read-only and never modified.
    pub fn import_from(&self, source: &Path) -> Result<ImportReport, KnownHostsError> {
        let incoming = match std::fs::read_to_string(source) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ImportReport::default());
            }
            Err(err) => {
                return Err(KnownHostsError::Io {
                    path: source.to_path_buf(),
                    source: err,
                });
            }
        };

        let existing = self.read()?;
        let mut known: Vec<String> = existing
            .lines()
            .filter_map(|l| parse_entry(l).map(|e| entry_identity(&e)))
            .collect();

        let mut report = ImportReport::default();
        let mut appended = String::new();

        for line in incoming.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            report.total += 1;
            let Some(entry) = parse_entry(line) else {
                report.malformed += 1;
                continue;
            };
            if entry.marker() == Some(&Marker::CertAuthority) {
                report.skipped_cert_authority += 1;
                continue;
            }
            let identity = entry_identity(&entry);
            if known.contains(&identity) {
                report.duplicates += 1;
                continue;
            }
            known.push(identity);
            appended.push_str(trimmed);
            appended.push('\n');
            report.imported += 1;
        }

        if !appended.is_empty() {
            let needs_newline = !existing.is_empty() && !existing.ends_with('\n');
            let mut out = existing;
            if needs_newline {
                out.push('\n');
            }
            out.push_str(&appended);
            if let Some(dir) = self.path.parent()
                && !dir.exists()
            {
                std::fs::create_dir_all(dir).map_err(|source| KnownHostsError::Io {
                    path: dir.to_path_buf(),
                    source,
                })?;
            }
            std::fs::write(&self.path, out).map_err(|source| KnownHostsError::Io {
                path: self.path.clone(),
                source,
            })?;
        }
        Ok(report)
    }
}

/// OpenSSH records a non-default port as `[host]:port`, and hashed entries
/// hash exactly that literal — so the bracket form must be built before
/// hashing, not after.
fn match_target(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// Line number (1-based) paired with each entry that parses.
fn parsed_entries(contents: &str) -> impl Iterator<Item = (usize, Entry)> + '_ {
    contents
        .lines()
        .enumerate()
        .filter_map(|(idx, line)| parse_entry(line).map(|entry| (idx + 1, entry)))
}

fn parse_entry(line: &str) -> Option<Entry> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    trimmed.parse::<Entry>().ok()
}

/// Host patterns + algorithm + key fingerprint, ignoring the comment.
///
/// The patterns are part of the identity on purpose. Keying on the key alone
/// would treat every host that shares a key as one entry, so importing a
/// `known_hosts` file where several hosts present the same key would silently
/// drop all but the first — data loss on the file the whole trust model rests
/// on. The comment is excluded because it carries no trust meaning.
fn entry_identity(entry: &Entry) -> String {
    format!(
        "{}|{}|{}",
        entry.host_patterns().to_string(),
        entry.public_key().algorithm(),
        entry.public_key().fingerprint(HashAlg::Sha256)
    )
}

fn patterns_display(patterns: &HostPatterns) -> String {
    match patterns {
        HostPatterns::Patterns(list) => list.join(","),
        HostPatterns::HashedName { .. } => "(hashed)".to_string(),
    }
}

/// `alg base64key`, dropping any comment — `known_hosts` allows one but it adds
/// nothing here.
fn openssh_key_part(key: &PublicKey) -> Result<String, KnownHostsError> {
    let line = key
        .to_openssh()
        .map_err(|e| KnownHostsError::Encode(e.to_string()))?;
    let mut fields = line.split_whitespace();
    match (fields.next(), fields.next()) {
        (Some(alg), Some(data)) => Ok(format!("{alg} {data}")),
        _ => Err(KnownHostsError::Encode("malformed public key".into())),
    }
}

fn hash_pattern(target: &str) -> String {
    use base64ct::{Base64, Encoding as _};
    use getrandom::fill;

    let mut salt = [0u8; 20];
    // A failure here means the OS RNG is unavailable, which is not a
    // recoverable condition for a security feature — fall back to writing the
    // entry unhashed rather than with a predictable salt.
    if fill(&mut salt).is_err() {
        return target.to_string();
    }
    let hash = hmac_sha1(&salt, target.as_bytes());
    format!(
        "|1|{}|{}",
        Base64::encode_string(&salt),
        Base64::encode_string(&hash)
    )
}

fn hmac_sha1(salt: &[u8], message: &[u8]) -> [u8; 20] {
    // `new_from_slice` only fails for key sizes this construction cannot
    // produce, so the fallback is unreachable in practice.
    let Ok(mut mac) = HmacSha1::new_from_slice(salt) else {
        return [0u8; 20];
    };
    mac.update(message);
    let bytes = mac.finalize().into_bytes();
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes[..20]);
    out
}

/// Does any pattern on this line name our target?
///
/// `host` is passed alongside `target` because OpenSSH matches a bare hostname
/// pattern against the bare host even when a port made the target bracketed.
fn patterns_match(patterns: &HostPatterns, target: &str, host: &str) -> bool {
    match patterns {
        HostPatterns::HashedName { salt, hash } => hmac_sha1(salt, target.as_bytes()) == *hash,
        HostPatterns::Patterns(list) => {
            let mut matched = false;
            for pattern in list {
                if let Some(negated) = pattern.strip_prefix('!') {
                    // A single negation disqualifies the whole line, even if
                    // another pattern on it matched.
                    if glob_match(negated, target) || glob_match(negated, host) {
                        return false;
                    }
                } else if glob_match(pattern, target) || glob_match(pattern, host) {
                    matched = true;
                }
            }
            matched
        }
    }
}

/// OpenSSH host-pattern globbing: `*` spans any run of characters, `?` exactly
/// one. Iterative with backtracking, so a pathological pattern cannot blow the
/// stack on untrusted file contents.
fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let v: Vec<char> = value.chars().collect();
    let (mut pi, mut vi) = (0usize, 0usize);
    let (mut star, mut resume) = (usize::MAX, 0usize);

    while vi < v.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == v[vi]) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            resume = vi;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            resume += 1;
            vi = resume;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::{glob_match, match_target};

    #[test]
    fn target_uses_bracket_form_only_for_non_default_ports() {
        assert_eq!(match_target("example.com", 22), "example.com");
        assert_eq!(match_target("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn glob_handles_star_and_question() {
        assert!(glob_match("*.example.com", "web.example.com"));
        assert!(glob_match("web?.example.com", "web1.example.com"));
        assert!(!glob_match("web?.example.com", "web12.example.com"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "exactly"));
    }

    #[test]
    fn glob_backtracks_rather_than_matching_greedily() {
        // A naive greedy matcher fails this: the first `*` must give ground.
        assert!(glob_match("*.example.com", "a.b.example.com"));
        assert!(glob_match("a*c", "abcbc"));
        assert!(!glob_match("a*d", "abcbc"));
    }

    #[test]
    fn glob_matches_bracketed_targets() {
        assert!(glob_match("[*.example.com]:2222", "[web.example.com]:2222"));
        assert!(!glob_match("[*.example.com]:2222", "[web.example.com]:22"));
    }
}
