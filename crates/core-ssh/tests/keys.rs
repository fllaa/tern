//! Key inspection against real fixtures (`scripts/gen-key-fixtures.sh`).
//!
//! Fixtures live in `.rig/keys/`, which is gitignored — no private key belongs
//! in the repo, not even a throwaway one. Tests skip with a message when the
//! fixtures are absent, the same contract as `rig.rs`.

use std::path::PathBuf;

use tern_core_ssh::{KeyFormat, inspect, unlock};

/// Matches `scripts/gen-key-fixtures.sh`.
const PASS: &str = "tern-fixture-pass";

fn keys_dir() -> PathBuf {
    std::env::var("TERN_KEY_FIXTURES").map_or_else(
        |_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.rig/keys"),
        PathBuf::from,
    )
}

fn fixture(name: &str) -> PathBuf {
    keys_dir().join(name)
}

macro_rules! require_fixture {
    ($name:expr) => {{
        let path = fixture($name);
        if !path.exists() {
            eprintln!(
                "SKIP: key fixture {} missing (scripts/gen-key-fixtures.sh)",
                path.display()
            );
            return;
        }
        path
    }};
}

/// The fingerprint `ssh-keygen` wrote alongside the private key, read back
/// through the `.pub` file. Cross-checking against OpenSSH's own output is what
/// makes the fingerprint assertions meaningful rather than self-consistent.
fn fingerprint_of_pub(name: &str) -> String {
    let text = std::fs::read_to_string(fixture(&format!("{name}.pub"))).expect("read .pub");
    let key: russh::keys::ssh_key::PublicKey = text.parse().expect("parse .pub");
    key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string()
}

#[test]
fn openssh_keys_report_algorithm_and_fingerprint() {
    for (name, algorithm) in [
        ("id_ed25519", "ssh-ed25519"),
        ("id_ecdsa", "ecdsa-sha2-nistp256"),
        ("id_rsa", "ssh-rsa"),
    ] {
        let path = require_fixture!(name);
        let info = inspect(&path).expect("inspect");

        assert_eq!(info.format, KeyFormat::OpenSsh, "{name}");
        assert!(!info.encrypted, "{name} was generated without a passphrase");
        assert_eq!(info.algorithm.as_deref(), Some(algorithm), "{name}");
        assert_eq!(
            info.fingerprint.as_deref(),
            Some(fingerprint_of_pub(name).as_str()),
            "{name} fingerprint disagrees with ssh-keygen"
        );
    }
}

/// The load-bearing claim of `inspect`: an encrypted OpenSSH key still reports
/// what it is. OpenSSH leaves the public half in cleartext, so the UI can name
/// the key it is asking a passphrase for instead of showing an opaque path.
#[test]
fn encrypted_openssh_keys_are_described_without_the_passphrase() {
    for (name, algorithm) in [
        ("id_ed25519_enc", "ssh-ed25519"),
        ("id_ecdsa_enc", "ecdsa-sha2-nistp256"),
        ("id_rsa_enc", "ssh-rsa"),
    ] {
        let path = require_fixture!(name);
        let info = inspect(&path).expect("inspect");

        assert!(info.encrypted, "{name} should report as encrypted");
        assert_eq!(info.algorithm.as_deref(), Some(algorithm), "{name}");
        assert_eq!(
            info.fingerprint.as_deref(),
            Some(fingerprint_of_pub(name).as_str()),
            "{name} fingerprint disagrees with ssh-keygen"
        );
    }
}

/// The cleartext fingerprint must be the *same key* that the passphrase opens.
/// If these ever diverged, the import UI would confirm one key and store the
/// passphrase for another.
#[test]
fn the_fingerprint_shown_before_unlock_matches_the_unlocked_key() {
    let path = require_fixture!("id_ed25519_enc");
    let before = inspect(&path).expect("inspect");
    let after = unlock(&path, Some(PASS)).expect("unlock");

    assert_eq!(before.fingerprint, after.fingerprint);
    assert_eq!(before.algorithm, after.algorithm);
    assert!(
        after.encrypted,
        "unlocking does not change what the file is"
    );
}

#[test]
fn the_right_passphrase_unlocks_every_encrypted_format() {
    for name in [
        "id_ed25519_enc",
        "id_ecdsa_enc",
        "id_rsa_enc",
        "id_rsa_pem_enc",
        "id_rsa_pkcs8_sha256_enc",
    ] {
        let path = require_fixture!(name);
        let info = unlock(&path, Some(PASS)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(info.algorithm.is_some(), "{name}");
        assert!(info.fingerprint.is_some(), "{name}");
    }
}

#[test]
fn a_wrong_passphrase_says_so_rather_than_reporting_corruption() {
    let path = require_fixture!("id_ed25519_enc");
    let err = unlock(&path, Some("definitely-not-the-passphrase")).expect_err("wrong passphrase");
    assert!(
        err.to_string().contains("passphrase did not decrypt"),
        "unhelpful error: {err}"
    );
}

/// Omitting the passphrase for a locked key must not look like a wrong one —
/// the UI branches on this to decide whether to prompt or to report a typo.
#[test]
fn omitting_the_passphrase_is_distinct_from_getting_it_wrong() {
    let path = require_fixture!("id_ed25519_enc");
    let err = unlock(&path, None).expect_err("no passphrase");
    assert!(
        !err.to_string().contains("passphrase did not decrypt"),
        "a missing passphrase should not be reported as a wrong one: {err}"
    );
}

/// PEM and PKCS#8 encrypt the whole structure, so unlike OpenSSH there is
/// genuinely nothing to report until the passphrase arrives. `None` here is
/// "not knowable yet", and the test pins that distinction.
#[test]
fn whole_file_encryption_hides_details_until_unlocked() {
    for (name, format) in [
        ("id_rsa_pem_enc", KeyFormat::Pem),
        ("id_rsa_pkcs8_sha256_enc", KeyFormat::Pkcs8),
    ] {
        let path = require_fixture!(name);
        let before = inspect(&path).expect("inspect");
        assert_eq!(before.format, format, "{name}");
        assert!(before.encrypted, "{name}");
        assert!(before.algorithm.is_none(), "{name} leaked an algorithm");
        assert!(before.fingerprint.is_none(), "{name} leaked a fingerprint");

        let after = unlock(&path, Some(PASS)).expect("unlock");
        assert!(
            after.algorithm.is_some(),
            "{name} still opaque after unlock"
        );
    }
}

/// A real capability boundary, pinned so it is a known limit rather than a
/// mystery bug report.
///
/// `ssh-keygen -m PKCS8 -N …` writes PBES2/PBKDF2 with no explicit PRF OID,
/// which means the default: HMAC-SHA1. `ssh-key` reaches PBKDF2-SHA1 only via
/// the `pkcs5/sha1-insecure` feature, which it does not enable — so these keys
/// cannot be decrypted here by design, not by oversight.
///
/// What matters for the UI is that the error names the *format* as the problem.
/// Blaming the passphrase would send the user round a loop retyping a
/// passphrase that was right all along.
#[test]
fn pkcs8_with_sha1_pbkdf2_is_refused_without_blaming_the_passphrase() {
    let path = require_fixture!("id_rsa_pkcs8_enc");
    let err = unlock(&path, Some(PASS)).expect_err("sha1 pbkdf2 is unsupported");
    let msg = err.to_string();

    assert!(
        !msg.contains("passphrase did not decrypt"),
        "a correct passphrase was blamed for an unsupported format: {msg}"
    );
    assert!(
        msg.contains("unsupported"),
        "error should name the format limit: {msg}"
    );
}

#[test]
fn unencrypted_pem_and_pkcs8_are_readable_as_they_stand() {
    for (name, format) in [
        ("id_rsa_pem", KeyFormat::Pem),
        ("id_rsa_pkcs8", KeyFormat::Pkcs8),
    ] {
        let path = require_fixture!(name);
        let info = inspect(&path).expect("inspect");
        assert_eq!(info.format, format, "{name}");
        assert!(!info.encrypted, "{name}");
        assert_eq!(info.algorithm.as_deref(), Some("ssh-rsa"), "{name}");
    }
}

/// `PuTTY` keys need `puttygen` to generate, which is not installed everywhere;
/// these skip when it was unavailable. The header parsing itself is covered by
/// unit tests that carry no key material.
#[test]
fn ppk_v3_round_trips_through_inspect_and_unlock() {
    let path = require_fixture!("id_ed25519_v3_enc.ppk");
    let before = inspect(&path).expect("inspect");
    assert_eq!(before.format, KeyFormat::Ppk { version: 3 });
    assert!(before.encrypted);
    assert_eq!(before.algorithm.as_deref(), Some("ssh-ed25519"));

    let after = unlock(&path, Some(PASS)).expect("unlock");
    // Same key material as the OpenSSH original it was converted from.
    assert_eq!(
        after.fingerprint.as_deref(),
        Some(fingerprint_of_pub("id_ed25519").as_str())
    );
}

#[test]
fn ppk_v2_is_supported_alongside_v3() {
    let path = require_fixture!("id_ed25519_v2.ppk");
    let info = inspect(&path).expect("inspect");
    assert_eq!(info.format, KeyFormat::Ppk { version: 2 });
    assert!(!info.encrypted);
}
