use std::path::PathBuf;
use std::time::Duration;

/// How to authenticate a session.
#[derive(Debug, Clone)]
pub enum AuthMethod {
    /// Password authentication.
    ///
    /// NOTE: plain `String` for the Phase 0 spike; the vault's zeroizing secret
    /// type replaces this in Phase 5.
    Password(String),
    /// A private key file on disk (OpenSSH/PEM formats via russh).
    KeyFile {
        path: PathBuf,
        passphrase: Option<String>,
    },
    /// The system ssh-agent via `SSH_AUTH_SOCK`.
    ///
    /// Windows OpenSSH named pipe / Pageant support is Phase 1 work.
    Agent,
}

/// Everything needed to establish an SSH session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
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
            auth,
            term: "xterm-256color".into(),
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            connect_timeout: Duration::from_secs(10),
            window_size: 512 * 1024,
            channel_buffer_size: 16,
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
}
