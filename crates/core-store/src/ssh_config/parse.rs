//! Turn tokenized directives into host stanzas.
//!
//! Two behaviours here are load-bearing:
//!
//! **`Match` blocks.** We do not evaluate them, and the dangerous failure is
//! not "we skipped a Match" — it is that every directive *after* one would
//! otherwise be attributed to the enclosing `Host` stanza, silently producing
//! wrong imported hosts with no error anywhere. So a `Match` ends the current
//! stanza, everything until the next `Host` is discarded, and a warning names
//! the file and line.
//!
//! **`Include` cycles.** `Include` accepts globs, and a file that includes its
//! own directory includes itself. Depth is capped and the visit set is
//! carried, so a cycle produces a warning rather than a hang.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::lex::{Directive, tokenize};

/// Keywords we map onto a stored host. Everything else is reported as
/// unimported rather than silently dropped.
const UNDERSTOOD: &[&str] = &[
    "hostname",
    "port",
    "user",
    "identityfile",
    "proxyjump",
    "serveraliveinterval",
    "connecttimeout",
    "forwardagent",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Warning {
    /// A `Match` block was found; the stanza it interrupted stops there.
    MatchUnsupported { file: String, line: usize },
    /// `Include` recursion hit the depth cap or revisited a file.
    IncludeCycle { file: String, line: usize },
    /// An `Include` pattern matched nothing, or the file could not be read.
    IncludeUnreadable {
        file: String,
        line: usize,
        pattern: String,
    },
    /// A keyword we do not model. Listed so the user can see what was skipped.
    UnsupportedKeyword {
        file: String,
        line: usize,
        keyword: String,
    },
}

/// One `Host` stanza's resolved settings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stanza {
    /// The patterns as written, e.g. `["web1", "web2"]` or `["*"]`.
    pub patterns: Vec<String>,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub server_alive_interval: Option<u32>,
    pub connect_timeout: Option<u32>,
    pub forward_agent: Option<bool>,
}

impl Stanza {
    /// Does this stanza apply to `alias`?
    ///
    /// OpenSSH semantics: a stanza contributes to a host when any of its
    /// patterns matches and none of its negated patterns does. This is why
    /// wildcard stanzas cannot simply be treated as universal defaults —
    /// `Host *.legacy` applies to `web.legacy` and to nothing else.
    pub fn matches(&self, alias: &str) -> bool {
        let mut matched = false;
        for pattern in &self.patterns {
            if let Some(negated) = pattern.strip_prefix('!') {
                if glob_match(negated, alias) {
                    return false;
                }
            } else if glob_match(pattern, alias) {
                matched = true;
            }
        }
        matched
    }

    /// Fill any unset field from `other`. OpenSSH is first-obtained-value-wins,
    /// so a more specific stanza that already set a value keeps it.
    fn inherit_from(&mut self, other: &Stanza) {
        if self.hostname.is_none() {
            self.hostname.clone_from(&other.hostname);
        }
        if self.port.is_none() {
            self.port = other.port;
        }
        if self.user.is_none() {
            self.user.clone_from(&other.user);
        }
        if self.identity_file.is_none() {
            self.identity_file.clone_from(&other.identity_file);
        }
        if self.proxy_jump.is_none() {
            self.proxy_jump.clone_from(&other.proxy_jump);
        }
        if self.server_alive_interval.is_none() {
            self.server_alive_interval = other.server_alive_interval;
        }
        if self.connect_timeout.is_none() {
            self.connect_timeout = other.connect_timeout;
        }
        if self.forward_agent.is_none() {
            self.forward_agent = other.forward_agent;
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ParsedConfig {
    /// Every stanza, in file order — wildcard and concrete alike.
    ///
    /// Kept together rather than split into "hosts" and "defaults" because
    /// resolution has to walk them in order and ask each whether it matches:
    /// `Host *.legacy` is neither a host nor a universal default.
    pub stanzas: Vec<Stanza>,
    pub warnings: Vec<Warning>,
}

impl ParsedConfig {
    /// Every alias worth offering as an importable host: concrete patterns
    /// only, in file order, de-duplicated.
    pub fn aliases(&self) -> Vec<String> {
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for stanza in &self.stanzas {
            for pattern in &stanza.patterns {
                if pattern.starts_with('!') || pattern.contains('*') || pattern.contains('?') {
                    continue;
                }
                if seen.insert(pattern.clone()) {
                    out.push(pattern.clone());
                }
            }
        }
        out
    }

    /// Resolve every setting that applies to `alias`, first value winning.
    pub fn resolve(&self, alias: &str) -> Stanza {
        let mut resolved = Stanza {
            patterns: vec![alias.to_string()],
            ..Stanza::default()
        };
        for stanza in &self.stanzas {
            if stanza.matches(alias) {
                resolved.inherit_from(stanza);
            }
        }
        resolved
    }
}

/// How deep `Include` may nest before we call it a cycle.
const MAX_INCLUDE_DEPTH: usize = 16;

/// Parse a config file, following `Include` directives.
pub fn parse_file(path: &Path) -> ParsedConfig {
    let mut cfg = ParsedConfig::default();
    let mut visited = BTreeSet::new();
    parse_into(path, 0, &mut visited, &mut cfg);
    cfg
}

fn parse_into(path: &Path, depth: usize, visited: &mut BTreeSet<PathBuf>, cfg: &mut ParsedConfig) {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if depth > MAX_INCLUDE_DEPTH || !visited.insert(canonical) {
        cfg.warnings.push(Warning::IncludeCycle {
            file: path.display().to_string(),
            line: 0,
        });
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let label = path.display().to_string();
    let base = path.parent().map(Path::to_path_buf);
    absorb(
        tokenize(&text),
        &label,
        cfg,
        base.as_deref(),
        depth,
        visited,
    );
}

fn absorb(
    directives: Vec<Directive>,
    file: &str,
    cfg: &mut ParsedConfig,
    base: Option<&Path>,
    depth: usize,
    visited: &mut BTreeSet<PathBuf>,
) {
    let mut current: Option<Stanza> = None;
    // Set by a `Match`: everything until the next `Host` is unattributable.
    let mut in_match = false;

    for d in directives {
        match d.keyword.as_str() {
            "host" => {
                flush(&mut current, cfg);
                in_match = false;
                current = Some(Stanza {
                    patterns: d.args.clone(),
                    ..Stanza::default()
                });
            }
            "match" => {
                // End the stanza *here*. Without this the directives below
                // would silently land on the previous Host.
                flush(&mut current, cfg);
                in_match = true;
                cfg.warnings.push(Warning::MatchUnsupported {
                    file: file.to_string(),
                    line: d.line,
                });
            }
            "include" => {
                if let Some(base) = base {
                    for pattern in &d.args {
                        include(pattern, base, d.line, file, depth, visited, cfg);
                    }
                } else {
                    cfg.warnings.push(Warning::IncludeUnreadable {
                        file: file.to_string(),
                        line: d.line,
                        pattern: d.args.join(" "),
                    });
                }
            }
            _ if in_match => {}
            keyword => {
                let Some(stanza) = current.as_mut() else {
                    // Directives before any Host are global defaults.
                    continue;
                };
                if !UNDERSTOOD.contains(&keyword) {
                    cfg.warnings.push(Warning::UnsupportedKeyword {
                        file: file.to_string(),
                        line: d.line,
                        keyword: keyword.to_string(),
                    });
                    continue;
                }
                apply(stanza, keyword, &d.args);
            }
        }
    }
    flush(&mut current, cfg);
}

fn flush(current: &mut Option<Stanza>, cfg: &mut ParsedConfig) {
    let Some(stanza) = current.take() else { return };
    if stanza.patterns.is_empty() {
        return;
    }
    cfg.stanzas.push(stanza);
}

/// First value wins, matching OpenSSH — a later duplicate is ignored.
fn apply(stanza: &mut Stanza, keyword: &str, args: &[String]) {
    let Some(first) = args.first() else { return };
    match keyword {
        "hostname" if stanza.hostname.is_none() => {
            stanza.hostname = Some(first.clone());
        }
        "port" if stanza.port.is_none() => {
            stanza.port = first.parse().ok();
        }
        "user" if stanza.user.is_none() => stanza.user = Some(first.clone()),
        "identityfile" if stanza.identity_file.is_none() => {
            stanza.identity_file = Some(expand_tilde_str(first));
        }
        "proxyjump" if stanza.proxy_jump.is_none() => {
            stanza.proxy_jump = Some(args.join(","));
        }
        "serveraliveinterval" if stanza.server_alive_interval.is_none() => {
            stanza.server_alive_interval = first.parse().ok();
        }
        "connecttimeout" if stanza.connect_timeout.is_none() => {
            stanza.connect_timeout = first.parse().ok();
        }
        "forwardagent" if stanza.forward_agent.is_none() => {
            stanza.forward_agent = Some(matches!(
                first.to_lowercase().as_str(),
                "yes" | "true" | "on"
            ));
        }
        _ => {}
    }
}

fn include(
    pattern: &str,
    base: &Path,
    line: usize,
    file: &str,
    depth: usize,
    visited: &mut BTreeSet<PathBuf>,
    cfg: &mut ParsedConfig,
) {
    // OpenSSH resolves a relative Include against ~/.ssh; we resolve against
    // the including file's directory, which is the same thing for the usual
    // case and keeps test fixtures hermetic.
    let expanded = expand_tilde_str(pattern);
    let joined = if Path::new(&expanded).is_absolute() {
        PathBuf::from(&expanded)
    } else {
        base.join(&expanded)
    };

    let mut matched = false;
    for entry in glob_paths(&joined) {
        matched = true;
        parse_into(&entry, depth + 1, visited, cfg);
    }
    if !matched {
        cfg.warnings.push(Warning::IncludeUnreadable {
            file: file.to_string(),
            line,
            pattern: pattern.to_string(),
        });
    }
}

/// Minimal glob: only a trailing `*` in the final component, which covers the
/// `Include ~/.ssh/config.d/*` idiom without a glob dependency.
fn glob_paths(pattern: &Path) -> Vec<PathBuf> {
    let as_str = pattern.to_string_lossy().to_string();
    if !as_str.contains('*') {
        return if pattern.is_file() {
            vec![pattern.to_path_buf()]
        } else {
            Vec::new()
        };
    }
    let Some(parent) = pattern.parent() else {
        return Vec::new();
    };
    let name = pattern
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| glob_one(&name, &n.to_string_lossy()))
        })
        .collect();
    // Directory order is not stable across platforms; imports must be.
    out.sort();
    out
}

fn glob_one(pattern: &str, value: &str) -> bool {
    glob_match(pattern, value)
}

/// Host-pattern globbing: `*` spans any run of characters, `?` exactly one.
/// Iterative with backtracking, so a pathological pattern in a user-authored
/// file cannot blow the stack.
pub fn glob_match(pattern: &str, value: &str) -> bool {
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

fn expand_tilde_str(input: &str) -> String {
    let Some(rest) = input.strip_prefix("~/") else {
        return input.to_string();
    };
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(
            || input.to_string(),
            |home| Path::new(&home).join(rest).display().to_string(),
        )
}
