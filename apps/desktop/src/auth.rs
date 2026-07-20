//! Credential resolution: store record → OS keyring → transport auth.
//!
//! This lives in the desktop layer rather than any core crate because it is
//! the one place that legitimately knows about all three: `core-store` (which
//! auth method, which keyring account), `core-vault` (fetch), and `core-ssh`
//! (use). None of those may depend on each other.
//!
//! Secrets are resolved **per connect attempt** and dropped immediately after.
//! That is deliberate: a reconnect re-reads the keyring rather than holding
//! plaintext for the session's lifetime, so a credential the user revokes
//! mid-session causes the next reconnect to fail loudly instead of succeeding
//! with a stale copy.

use tern_core_ssh::AuthMethod;
use tern_core_store::{AuthKind, Host, HostId};
use tern_core_vault::{OsKeyring, VaultError};

/// Keyring service name. The bundle identifier, so entries are attributable in
/// Keychain Access / Credential Manager / seahorse.
pub const KEYRING_SERVICE: &str = "io.github.fllaa.tern";

/// Keyring account for a host's password.
pub fn password_account(host_id: HostId) -> String {
    format!("host/{host_id}/password")
}

/// Keyring account for a host's key passphrase.
pub fn passphrase_account(host_id: HostId) -> String {
    format!("host/{host_id}/passphrase")
}

/// The account a host's `secret_ref` should point at, given its auth method.
pub fn account_for(host: &Host) -> Option<String> {
    match host.auth {
        AuthKind::Password => Some(password_account(host.id)),
        AuthKind::KeyFile => Some(passphrase_account(host.id)),
        // Agent auth has nothing to store.
        AuthKind::Agent => None,
    }
}

fn keyring() -> OsKeyring {
    OsKeyring::new(KEYRING_SERVICE)
}

/// Store (or replace) a host's credential.
pub fn set_secret(account: &str, secret: &str) -> Result<(), VaultError> {
    keyring().set_password(account, secret)
}

/// Remove a host's credential. A missing entry is success — the caller's
/// intent was "no credential stored", and that is now true either way.
pub fn clear_secret(account: &str) -> Result<(), VaultError> {
    match keyring().delete(account) {
        Ok(()) | Err(VaultError::NotFound) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Build the transport auth for a host, pulling any credential from the
/// keyring at the last moment.
///
/// A missing keyring entry is not an error here. `secret_ref` records that a
/// credential *was* stored; the keyring can still say otherwise (the user
/// cleared it, a different machine, a keyring that failed to unlock). The
/// honest result is auth without a secret, which fails with a real
/// authentication error the user can act on — rather than a confusing
/// storage-layer error at connect time.
pub fn auth_for_host(host: &Host) -> AuthMethod {
    let stored = host
        .secret_ref
        .as_deref()
        .and_then(|account| keyring().get_password(account).ok());

    match host.auth {
        AuthKind::Agent => AuthMethod::Agent,
        AuthKind::Password => AuthMethod::password(stored.unwrap_or_default()),
        AuthKind::KeyFile => {
            let path = host.key_path.clone().unwrap_or_default();
            AuthMethod::key_file(path, stored)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{account_for, passphrase_account, password_account};
    use tern_core_store::{AuthKind, NewHost};

    fn host_with(auth: AuthKind) -> tern_core_store::Host {
        // Round-tripping through an in-memory store keeps this honest about
        // the real record shape rather than a hand-built struct.
        let store = tern_core_store::Store::open_in_memory().expect("store");
        let mut draft = NewHost::manual("h", "example.com");
        draft.auth = auth;
        let id = store.hosts().create(&draft).expect("create");
        store.hosts().get(id).expect("get").expect("exists")
    }

    #[test]
    fn accounts_are_namespaced_by_host_and_kind() {
        assert_eq!(password_account(12), "host/12/password");
        assert_eq!(passphrase_account(12), "host/12/passphrase");
    }

    #[test]
    fn agent_hosts_have_nothing_to_store() {
        assert!(account_for(&host_with(AuthKind::Agent)).is_none());
    }

    #[test]
    fn password_and_key_hosts_get_distinct_accounts() {
        let pw = account_for(&host_with(AuthKind::Password)).expect("account");
        let key = account_for(&host_with(AuthKind::KeyFile)).expect("account");
        assert_ne!(pw, key);
    }
}
