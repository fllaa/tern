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
use tern_core_vault::{KeyringAvailability, OsKeyring, VaultError};
use tracing::debug;

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

/// The keyring account this host stores its single credential under.
///
/// Taken from the whole auth chain, not just the primary method. A host's chain
/// carries at most one credential-bearing method — a password or a key
/// passphrase; agent needs none — so the account is unambiguous. Scanning the
/// chain rather than the primary is what lets an "agent, then password" host
/// store its password even though agent leads and needs nothing itself.
pub fn account_for(host: &Host) -> Option<String> {
    std::iter::once(host.auth)
        .chain(host.auth_fallbacks.iter().copied())
        .find_map(|kind| match kind {
            AuthKind::Password => Some(password_account(host.id)),
            AuthKind::KeyFile => Some(passphrase_account(host.id)),
            AuthKind::Agent => None,
        })
}

fn keyring() -> OsKeyring {
    OsKeyring::new(KEYRING_SERVICE)
}

/// The raw stored secret for a host, if the keyring holds one.
///
/// Used by the connection test to stand in for a credential field the user left
/// untouched while editing — the webview never receives the saved secret, so an
/// unchanged field arrives empty and would otherwise fail auth with an empty
/// credential. A missing or unreadable entry is simply `None`.
pub fn stored_secret(host: &Host) -> Option<String> {
    account_for(host).and_then(|account| keyring().get_password(&account).ok())
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

/// Whether the OS credential store works on this machine.
///
/// Probed rather than assumed: a Linux box with no Secret Service running
/// (headless, a bare WM, a container) fails every keyring call, and silently
/// offering to "remember" a password that is then discarded is worse than
/// saying up front that it cannot be.
pub fn keyring_availability() -> KeyringAvailability {
    keyring().availability()
}

/// Fetch a stored credential, separating "nothing saved" from "could not ask".
///
/// Returns the secret (if any) and a note explaining any degradation.
fn read_secret(account: &str) -> (Option<String>, Option<String>) {
    match keyring().get_password(account) {
        Ok(secret) => (Some(secret), None),
        Err(VaultError::NotFound) => (None, None),
        Err(VaultError::Store(reason)) => (
            None,
            Some(format!(
                "a credential is saved for this host but the credential store could \
                 not be read ({reason}); connecting without it"
            )),
        ),
    }
}

/// The auth to attempt, plus anything the user needs told about how it was
/// assembled.
pub struct ResolvedAuth {
    /// The host's primary method followed by its configured fallbacks, in the
    /// order `core-ssh` should try them.
    pub methods: Vec<AuthMethod>,
    /// Set when a credential was expected but could not be read. Carried
    /// alongside rather than turned into an error, because the connection
    /// should still be attempted — an agent or a key with no passphrase may
    /// well succeed regardless.
    pub degraded: Option<String>,
}

/// Build the transport auth for a host, pulling any credential from the
/// keyring at the last moment.
///
/// A *missing* keyring entry is not an error. `secret_ref` records that a
/// credential was stored once; the keyring can legitimately say otherwise (the
/// user cleared it, a different machine, a keyring that failed to unlock). The
/// honest result is auth without a secret, which fails with a real
/// authentication error rather than a confusing storage-layer one.
///
/// An *unreadable* keyring is different, and worth separating. "Authentication
/// failed" for a password the user is certain they saved sends them to check
/// the password; "the credential store could not be read" sends them to check
/// the credential store. Only the second is actionable, so the reason travels
/// with the attempt.
pub fn auth_for_host(host: &Host) -> ResolvedAuth {
    let (stored, degraded) = match host.secret_ref.as_deref() {
        None => (None, None),
        Some(account) => read_secret(account),
    };

    // Every step of the chain shares the host's single key_path and secret_ref,
    // which is what lets the fallbacks be stored as an ordering over kinds
    // rather than as rows with their own credentials.
    let build = |kind: AuthKind| match kind {
        AuthKind::Agent => AuthMethod::Agent,
        AuthKind::Password => AuthMethod::password(stored.clone().unwrap_or_default()),
        AuthKind::KeyFile => {
            AuthMethod::key_file(host.key_path.clone().unwrap_or_default(), stored.clone())
        }
    };

    let mut methods = vec![build(host.auth)];
    // A fallback repeating the primary would spend an auth attempt proving the
    // same thing twice, and against a server counting attempts that is not free.
    methods.extend(
        host.auth_fallbacks
            .iter()
            .filter(|k| **k != host.auth)
            .map(|k| build(*k)),
    );

    // `?methods` is safe: `AuthMethod`'s `Debug` redacts every secret and prints
    // only the key path — which is exactly what makes "is it trying the right
    // key?" answerable from the log.
    debug!(
        host_id = %host.id,
        methods = ?methods,
        degraded = degraded.is_some(),
        "auth: resolved chain for saved host",
    );
    ResolvedAuth { methods, degraded }
}

#[cfg(test)]
mod tests {
    use super::{account_for, auth_for_host, passphrase_account, password_account};
    use tern_core_store::{AuthKind, NewHost};

    fn host_with(auth: AuthKind) -> tern_core_store::Host {
        host_with_fallbacks(auth, &[])
    }

    fn host_with_fallbacks(auth: AuthKind, fallbacks: &[AuthKind]) -> tern_core_store::Host {
        // Round-tripping through an in-memory store keeps this honest about
        // the real record shape rather than a hand-built struct.
        let store = tern_core_store::Store::open_in_memory().expect("store");
        let mut draft = NewHost::manual("h", "example.com");
        draft.auth = auth;
        draft.auth_fallbacks = fallbacks.to_vec();
        let id = store.hosts().create(&draft).expect("create");
        store.hosts().get(id).expect("get").expect("exists")
    }

    /// The chain is the primary method followed by its fallbacks, in order.
    #[test]
    fn the_chain_leads_with_the_primary_method() {
        let host = host_with_fallbacks(AuthKind::Agent, &[AuthKind::Password]);
        let resolved = auth_for_host(&host);
        assert_eq!(resolved.methods.len(), 2);
        assert!(matches!(
            resolved.methods[0],
            tern_core_ssh::AuthMethod::Agent
        ));
        assert!(matches!(
            resolved.methods[1],
            tern_core_ssh::AuthMethod::Password(_)
        ));
    }

    /// A fallback repeating the primary would spend an auth attempt proving the
    /// same thing twice, which against a server counting attempts is not free.
    #[test]
    fn a_fallback_repeating_the_primary_is_dropped() {
        let host = host_with_fallbacks(AuthKind::Password, &[AuthKind::Password]);
        assert_eq!(auth_for_host(&host).methods.len(), 1);
    }

    #[test]
    fn a_host_without_fallbacks_yields_a_single_method() {
        assert_eq!(auth_for_host(&host_with(AuthKind::Agent)).methods.len(), 1);
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

    /// The reason `account_for` scans the chain rather than the primary: an
    /// agent-first host with a password fallback must still have somewhere to
    /// store that password, or the fallback is inert.
    #[test]
    fn an_agent_host_with_a_password_fallback_stores_under_the_password_account() {
        let host = host_with_fallbacks(AuthKind::Agent, &[AuthKind::Password]);
        assert_eq!(
            account_for(&host),
            Some(password_account(host.id)),
            "the credentialed fallback, not the agent primary, decides the account"
        );
    }

    /// An all-agent host has no credential anywhere in its chain, so there is
    /// nothing to store and no keyring entry to leak.
    #[test]
    fn an_agent_only_chain_has_no_account() {
        let host = host_with_fallbacks(AuthKind::Agent, &[AuthKind::Agent]);
        assert!(account_for(&host).is_none());
    }
}
