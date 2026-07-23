use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use zeroize::Zeroizing;

/// A credential held in memory. Wiped on drop.
///
/// Best-effort by necessity: `russh`'s `authenticate_password` takes an owned
/// `String` it does not zeroize, and `keyring` hands back a plain `String`.
/// What this buys is that *our* long-lived copies are wiped and the plaintext
/// exists for as short a window as possible — the plain `String` is
/// materialized at the last moment inside `authenticate`.
pub type Secret = Zeroizing<String>;

/// How to authenticate a session.
///
/// `Debug` is hand-written rather than derived, and must stay that way.
/// `SessionConfig` derives `Debug` and holds one of these, so a single
/// `tracing::debug!("{cfg:?}")` — exactly the line someone adds while chasing
/// a connect bug — would otherwise print the user's password into a log.
#[derive(Clone)]
pub enum AuthMethod {
    /// Password authentication.
    Password(Secret),
    /// A private key file on disk (OpenSSH/PEM/PPK formats via russh).
    KeyFile {
        path: PathBuf,
        passphrase: Option<Secret>,
    },
    /// The system ssh-agent: `SSH_AUTH_SOCK` on unix, the OpenSSH named pipe
    /// or Pageant on Windows.
    Agent,
}

impl AuthMethod {
    /// Password auth from anything string-like, wrapped so it is wiped on drop.
    pub fn password(secret: impl Into<String>) -> Self {
        Self::Password(Zeroizing::new(secret.into()))
    }

    /// Key-file auth with an optional passphrase.
    pub fn key_file(path: impl Into<PathBuf>, passphrase: Option<String>) -> Self {
        Self::KeyFile {
            path: path.into(),
            passphrase: passphrase.map(Zeroizing::new),
        }
    }
}

impl fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password(_) => f.write_str("Password(<redacted>)"),
            Self::KeyFile { path, passphrase } => f
                .debug_struct("KeyFile")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
            Self::Agent => f.write_str("Agent"),
        }
    }
}

/// One hop in a `ProxyJump` chain: where to dial, and how to authenticate there.
///
/// Same auth shape as [`SessionConfig`] — each hop is a full SSH login in its
/// own right, just reached over the previous hop's tunnel rather than TCP.
#[derive(Debug, Clone)]
pub struct JumpHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Vec<AuthMethod>,
}

/// Everything needed to establish an SSH session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Methods to try, in order; the first that succeeds wins.
    ///
    /// A single-element chain is the common case and what [`Self::new`] builds.
    /// Longer chains exist for "use the agent, but fall back to the password" —
    /// note that `authenticate` skips any method the server has already refused
    /// to offer, so a long chain does not squander the server's `MaxAuthTries`.
    pub auth: Vec<AuthMethod>,
    /// `TERM` requested for the PTY.
    pub term: String,
    /// Protocol-level keepalives; `None` disables them.
    pub keepalive_interval: Option<Duration>,
    /// Unanswered keepalives tolerated before the connection is considered dead.
    pub keepalive_max: usize,
    pub connect_timeout: Duration,
    /// SSH flow-control window. Bounds how much data can be in flight while the
    /// consumer is paused — keep it modest or pauses take long to bite.
    pub window_size: u32,
    /// russh's bounded per-channel delivery buffer (messages, not bytes). This
    /// is the backpressure link: when the consumer stops reading, this fills,
    /// the session loop stalls, and the SSH window drains.
    pub channel_buffer_size: usize,
    /// `ProxyJump` chain in dial order, nearest jump first. Empty means a direct
    /// connection — the common case and what [`Self::new`] builds. Each hop is
    /// dialed over the previous hop's tunnel; the target session runs over the
    /// last hop.
    pub jumps: Vec<JumpHop>,
}

impl SessionConfig {
    /// A config with spike-tuned defaults: port 22, xterm-256color, 15 s
    /// keepalives (max 3 missed), 10 s connect timeout, 512 KiB window,
    /// 16-message channel buffer.
    #[must_use]
    pub fn new(host: impl Into<String>, username: impl Into<String>, auth: AuthMethod) -> Self {
        Self {
            host: host.into(),
            port: 22,
            username: username.into(),
            auth: vec![auth],
            term: "xterm-256color".into(),
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            connect_timeout: Duration::from_secs(10),
            window_size: 512 * 1024,
            channel_buffer_size: 16,
            jumps: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthMethod, SessionConfig};

    #[test]
    fn defaults_are_spike_tuned() {
        let cfg = SessionConfig::new("example.com", "user", AuthMethod::Agent);
        assert_eq!(cfg.port, 22);
        assert_eq!(cfg.term, "xterm-256color");
        assert_eq!(cfg.window_size, 512 * 1024);
        assert_eq!(cfg.channel_buffer_size, 16);
        assert!(cfg.keepalive_interval.is_some());
    }

    /// Guards the hand-written `Debug`. If someone re-derives it, this fails
    /// rather than a password quietly reaching a log file.
    #[test]
    fn debug_never_reveals_a_password() {
        let auth = AuthMethod::password("hunter2");
        assert!(!format!("{auth:?}").contains("hunter2"));

        // And through the struct that actually gets logged.
        let cfg = SessionConfig::new("example.com", "user", auth);
        assert!(!format!("{cfg:?}").contains("hunter2"));
        assert!(format!("{cfg:?}").contains("<redacted>"));
    }

    #[test]
    fn debug_never_reveals_a_key_passphrase() {
        let auth = AuthMethod::key_file("/home/me/.ssh/id_ed25519", Some("correct horse".into()));
        let rendered = format!("{auth:?}");
        assert!(!rendered.contains("correct horse"));
        // The path is not a secret and stays visible — it is what makes a
        // failed key load diagnosable.
        assert!(rendered.contains("id_ed25519"));
    }

    #[test]
    fn debug_distinguishes_a_missing_passphrase_from_a_redacted_one() {
        let none = AuthMethod::key_file("/k", None);
        let some = AuthMethod::key_file("/k", Some("x".into()));
        assert!(format!("{none:?}").contains("None"));
        assert!(format!("{some:?}").contains("<redacted>"));
    }
}
