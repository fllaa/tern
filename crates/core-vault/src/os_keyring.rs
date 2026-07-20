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

    /// Whether this machine has a working credential store.
    ///
    /// Worth probing because the failure is common and silent: a Linux box with
    /// no Secret Service running (headless, a bare WM, a container) fails every
    /// keyring call, and without this the app would keep offering to "remember"
    /// passwords that are quietly discarded. The honest move is to say so up
    /// front and fall back to prompting.
    ///
    /// The probe is a read of an account that should not exist, so it is
    /// side-effect free — no entry is created just to find out. The distinction
    /// it turns on is that a *working* backend reports [`VaultError::NotFound`],
    /// whereas a missing or locked one fails at the platform level.
    #[must_use]
    pub fn availability(&self) -> KeyringAvailability {
        match self.get_password(PROBE_ACCOUNT) {
            // A hit would be bizarre, but proves the store works just as well.
            Ok(_) | Err(VaultError::NotFound) => KeyringAvailability::Available,
            Err(VaultError::Store(reason)) => KeyringAvailability::Unavailable { reason },
        }
    }
}

/// Account name used only by [`OsKeyring::availability`]. Never written.
const PROBE_ACCOUNT: &str = "__tern_backend_probe";

/// Result of [`OsKeyring::availability`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyringAvailability {
    Available,
    /// No usable backend. `reason` is the platform's own message, which is the
    /// only thing that distinguishes "D-Bus is not running" from "the keyring
    /// is locked" — different problems with different fixes.
    Unavailable {
        reason: String,
    },
}

impl KeyringAvailability {
    #[must_use]
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }
}

#[cfg(test)]
mod tests {
    use super::{KeyringAvailability, OsKeyring};

    /// Asserts the shape of the answer, not which one — CI runners differ
    /// (Linux has gnome-keyring installed, a bare container would not), and a
    /// test that demanded one outcome would encode the runner, not the code.
    #[test]
    fn availability_probe_answers_without_creating_an_entry() {
        let keyring = OsKeyring::new("io.github.fllaa.tern.test");
        match keyring.availability() {
            KeyringAvailability::Available => {}
            KeyringAvailability::Unavailable { reason } => {
                assert!(!reason.is_empty(), "unavailability must carry a reason");
            }
        }
        // The probe must not have left anything behind.
        assert!(keyring.get_password(super::PROBE_ACCOUNT).is_err());
    }
}
