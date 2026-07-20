//! OpenSSH client-config tokenizer.
//!
//! The grammar is small but has more corners than it looks:
//!
//! * keywords are case-insensitive (`HostName`, `hostname`, `HOSTNAME`);
//! * a keyword and its argument may be separated by whitespace, `=`, or both
//!   (`Port 22`, `Port=22`, `Port = 22`);
//! * arguments may be double-quoted, and a quoted argument may contain spaces;
//! * `#` starts a comment, but not inside quotes;
//! * blank lines and comments are ignored entirely.
//!
//! Nothing here knows what any keyword *means* — that is `parse`'s job.

/// One `keyword args...` line, with its 1-based line number for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directive {
    pub line: usize,
    /// Lowercased, so callers compare against lowercase literals.
    pub keyword: String,
    pub args: Vec<String>,
}

/// Split a config file into directives, skipping blanks and comments.
///
/// Malformed lines are dropped rather than failing the file: an `ssh_config` is
/// user-authored and frequently contains things we do not model, and refusing
/// to import 40 good hosts over one bad line is the wrong trade.
pub fn tokenize(input: &str) -> Vec<Directive> {
    input
        .lines()
        .enumerate()
        .filter_map(|(idx, raw)| {
            tokenize_line(raw).map(|(keyword, args)| Directive {
                line: idx + 1,
                keyword,
                args,
            })
        })
        .collect()
}

fn tokenize_line(raw: &str) -> Option<(String, Vec<String>)> {
    let mut fields = split_fields(raw);
    if fields.is_empty() {
        return None;
    }
    let keyword = fields.remove(0).to_lowercase();
    if keyword.is_empty() {
        return None;
    }
    Some((keyword, fields))
}

/// Split one line into fields, honouring quotes, `=` separators and comments.
fn split_fields(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    // OpenSSH accepts `Keyword=value`, but only as the *first* separator —
    // after that an `=` is an ordinary character (it appears in, say,
    // SetEnv FOO=bar).
    let mut separator_used = !out.is_empty();

    for ch in raw.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                // A quoted empty string is a real, if odd, argument.
                if !in_quotes && current.is_empty() {
                    out.push(String::new());
                    separator_used = true;
                }
            }
            '#' if !in_quotes => break,
            '=' if !in_quotes && !separator_used && out.len() == 1 && current.is_empty() => {
                // `Keyword = value` — the space already ended the keyword, so
                // this `=` is just the separator.
                separator_used = true;
            }
            '=' if !in_quotes && !separator_used && out.is_empty() && !current.is_empty() => {
                // `Keyword=value`
                out.push(std::mem::take(&mut current));
                separator_used = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Directive, tokenize};

    fn one(input: &str) -> Directive {
        tokenize(input).into_iter().next().expect("a directive")
    }

    #[test]
    fn keywords_are_lowercased() {
        assert_eq!(one("HostName example.com").keyword, "hostname");
        assert_eq!(one("HOSTNAME example.com").keyword, "hostname");
        assert_eq!(one("hostname example.com").keyword, "hostname");
    }

    #[test]
    fn equals_and_whitespace_both_separate() {
        for input in ["Port 2222", "Port=2222", "Port = 2222", "Port  2222"] {
            let d = one(input);
            assert_eq!(d.keyword, "port", "{input}");
            assert_eq!(d.args, vec!["2222".to_string()], "{input}");
        }
    }

    #[test]
    fn comments_and_blank_lines_disappear() {
        let out = tokenize("# leading\n\n  \nHost a\n  Port 22 # trailing\n");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].keyword, "host");
        assert_eq!(out[1].args, vec!["22".to_string()]);
    }

    #[test]
    fn quotes_protect_spaces_and_hashes() {
        let d = one(r#"IdentityFile "/home/me/my keys/id_ed25519""#);
        assert_eq!(d.args, vec!["/home/me/my keys/id_ed25519".to_string()]);
        let d = one(r#"ProxyCommand "sh -c 'x #1'""#);
        assert_eq!(d.args, vec!["sh -c 'x #1'".to_string()]);
    }

    #[test]
    fn multiple_arguments_survive() {
        let d = one("Host web1 web2 !web3");
        assert_eq!(d.keyword, "host");
        assert_eq!(d.args, vec!["web1", "web2", "!web3"]);
    }

    #[test]
    fn line_numbers_are_one_based_and_count_skipped_lines() {
        // Diagnostics point at the real file line, so a comment or blank must
        // still advance the count.
        let out = tokenize("# c\n\nHost a\n");
        assert_eq!(out[0].line, 3);
    }

    #[test]
    fn an_equals_after_the_separator_is_ordinary_text() {
        let d = one("SetEnv FOO=bar");
        assert_eq!(d.keyword, "setenv");
        assert_eq!(d.args, vec!["FOO=bar".to_string()]);
    }

    #[test]
    fn a_bare_keyword_with_no_arguments_still_tokenizes() {
        let d = one("ForwardAgent");
        assert_eq!(d.keyword, "forwardagent");
        assert!(d.args.is_empty());
    }
}
