//! Thin wrapper over the OS credential store (macOS Keychain, Windows
//! Credential Manager, Secret Service on Linux) via the `keyring` crate.
//!
//! This stores *small unlock secrets* (vault master-key material, per-host
//! passphrases the user opted to remember) — never bulk data. The encrypted
//! vault itself is Phase 5.

use keyring::Entry;

use crate::VaultError;

/// Handle to a named service scope in the OS credential store.
pub struct OsKeyring {
    service: String,
}

impl OsKeyring {
    #[must_use]
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<Entry, VaultError> {
        Entry::new(&self.service, account).map_err(VaultError::from)
    }

    /// Store (or overwrite) a UTF-8 secret.
    pub fn set_password(&self, account: &str, password: &str) -> Result<(), VaultError> {
        self.entry(account)?
            .set_password(password)
            .map_err(VaultError::from)
    }

    /// Fetch a UTF-8 secret.
    pub fn get_password(&self, account: &str) -> Result<String, VaultError> {
        self.entry(account)?
            .get_password()
            .map_err(VaultError::from)
    }

    /// Store (or overwrite) a binary secret.
    pub fn set_secret(&self, account: &str, secret: &[u8]) -> Result<(), VaultError> {
        self.entry(account)?
            .set_secret(secret)
            .map_err(VaultError::from)
    }

    /// Fetch a binary secret.
    pub fn get_secret(&self, account: &str) -> Result<Vec<u8>, VaultError> {
        self.entry(account)?.get_secret().map_err(VaultError::from)
    }

    /// Delete the stored credential for `account`.
    pub fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.entry(account)?
            .delete_credential()
            .map_err(VaultError::from)
    }
}
