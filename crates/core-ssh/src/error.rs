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
}
