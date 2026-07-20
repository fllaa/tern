//! Secret storage: OS keyring wrapper (Phase 0 Spike 4) and the encrypted
//! vault — `argon2id` KDF + `XChaCha20-Poly1305`, `zeroize` on buffers
//! (Phase 5). No plaintext secrets on disk, ever.
//!
//! This crate must never depend on `tauri`.

mod os_keyring;

pub use os_keyring::OsKeyring;

/// Errors from vault/keyring operations.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    /// No credential stored under that service/account.
    #[error("no matching credential")]
    NotFound,
    /// Any other credential-store failure (backend unavailable, access denied…).
    #[error("credential store: {0}")]
    Store(String),
}

impl From<keyring::Error> for VaultError {
    fn from(err: keyring::Error) -> Self {
        match err {
            keyring::Error::NoEntry => Self::NotFound,
            other => Self::Store(other.to_string()),
        }
    }
}
