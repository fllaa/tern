use std::time::Duration;

/// Errors from `core-ssh` session management.
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connect timed out after {0:?}")]
    ConnectTimeout(Duration),
    #[error("host key rejected")]
    HostKeyRejected,
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("ssh-agent: {0}")]
    Agent(String),
    #[error("could not load key: {0}")]
    KeyLoad(String),
    #[error(transparent)]
    Protocol(#[from] russh::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The transport is gone. Writes are rejected rather than buffered — see
    /// `SshError::is_retryable`.
    #[error("not connected")]
    NotConnected,
}

impl SshError {
    /// Whether a reconnect attempt could plausibly succeed.
    ///
    /// The two `false` cases matter more than the `true` ones:
    ///
    /// * `AuthFailed` — a backoff loop against a wrong password is an
    ///   account-lockout generator, and trips fail2ban on the far end.
    /// * `HostKeyRejected` — if the key changed between attempts, retrying
    ///   turns a security event into background noise.
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::ConnectTimeout(_) | Self::Io(_) | Self::Protocol(_) => true,
            Self::HostKeyRejected
            | Self::AuthFailed(_)
            | Self::Agent(_)
            | Self::KeyLoad(_)
            | Self::NotConnected => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SshError;
    use std::time::Duration;

    #[test]
    fn credential_and_trust_failures_are_never_retried() {
        assert!(!SshError::AuthFailed("bad password".into()).is_retryable());
        assert!(!SshError::HostKeyRejected.is_retryable());
        assert!(!SshError::KeyLoad("encrypted".into()).is_retryable());
        assert!(!SshError::Agent("no identities".into()).is_retryable());
    }

    #[test]
    fn transport_failures_are_retried() {
        assert!(SshError::ConnectTimeout(Duration::from_secs(10)).is_retryable());
        assert!(
            SshError::Io(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "reset"
            ))
            .is_retryable()
        );
    }
}
