//! Private-key inspection: what a file is, whether it needs a passphrase, and
//! whether a given passphrase opens it.
//!
//! Authentication itself does not need any of this — russh's `load_secret_key`
//! already decodes OpenSSH, PEM, PKCS#8 and `PuTTY` `.ppk` transparently, so a
//! `.ppk` host has worked since the first milestone. What needs it is *import*:
//! the user picks a file and the UI has to say what it is, whether it is
//! locked, and whether the passphrase they just typed is right — all before
//! anything is written to the keyring and long before a connection is made.
//!
//! Two rules shape the API:
//!
//! * [`inspect`] never takes a passphrase and never fails because a key is
//!   encrypted. An encrypted key is a normal, expected input; refusing to
//!   describe one would leave the UI unable to explain what it is asking for.
//! * Everything past the format is best-effort. OpenSSH keeps the public key in
//!   cleartext inside the envelope, so algorithm and fingerprint survive
//!   encryption; PEM and PKCS#8 encrypt the whole structure and reveal nothing
//!   until unlocked. `None` here means "not knowable yet", not "absent".

use std::path::Path;

use russh::keys::ssh_key::{HashAlg, PrivateKey};

use crate::error::SshError;

/// On-disk encoding of a private key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyFormat {
    /// `-----BEGIN OPENSSH PRIVATE KEY-----`, the modern `ssh-keygen` default.
    OpenSsh,
    /// Legacy PEM: PKCS#1 `BEGIN RSA PRIVATE KEY`, SEC1 `BEGIN EC …`, or DSA.
    Pem,
    /// PKCS#8 `BEGIN PRIVATE KEY` / `BEGIN ENCRYPTED PRIVATE KEY`.
    Pkcs8,
    /// `PuTTY`'s format. Version is 2 or 3; they differ in KDF (v3 uses Argon2).
    Ppk { version: u8 },
}

impl KeyFormat {
    /// Stable lowercase name for IPC and logs.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenSsh => "openssh",
            Self::Pem => "pem",
            Self::Pkcs8 => "pkcs8",
            Self::Ppk { .. } => "ppk",
        }
    }
}

/// What could be learned about a key file without unlocking it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInfo {
    pub format: KeyFormat,
    /// Whether a passphrase is required to use the key.
    pub encrypted: bool,
    /// e.g. `ssh-ed25519`. `None` when encryption hides it (PEM, PKCS#8).
    pub algorithm: Option<String>,
    /// `SHA256:…`, the same string `ssh-keygen -l` prints.
    pub fingerprint: Option<String>,
    /// The key's embedded comment, when it has one and it is readable.
    pub comment: Option<String>,
}

/// PEM keys mark encryption with an RFC 1421 header rather than in the body.
const PEM_ENCRYPTED_MARKER: &str = "Proc-Type: 4,ENCRYPTED";

/// Describe a key file without unlocking it.
///
/// # Errors
/// Returns [`SshError::KeyLoad`] if the file cannot be read, is not valid
/// UTF-8, or matches no known key format. Being *encrypted* is never an error.
pub fn inspect(path: impl AsRef<Path>) -> Result<KeyInfo, SshError> {
    let path = path.as_ref();
    let text = std::fs::read_to_string(path)
        .map_err(|e| SshError::KeyLoad(format!("{}: {e}", path.display())))?;
    inspect_str(&text)
}

/// [`inspect`] on key text already in memory.
///
/// # Errors
/// Returns [`SshError::KeyLoad`] if the text matches no known key format.
pub fn inspect_str(text: &str) -> Result<KeyInfo, SshError> {
    let trimmed = text.trim_start();

    if trimmed.starts_with("PuTTY-User-Key-File-") {
        return inspect_ppk(trimmed);
    }
    if text.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return Ok(inspect_openssh(text));
    }
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return Ok(KeyInfo {
            format: KeyFormat::Pkcs8,
            encrypted: true,
            algorithm: None,
            fingerprint: None,
            comment: None,
        });
    }
    if text.contains("-----BEGIN PRIVATE KEY-----") {
        return Ok(enrich(KeyFormat::Pkcs8, false, text));
    }
    // PKCS#1/SEC1: "BEGIN RSA/DSA/EC PRIVATE KEY". Matching on the suffix keeps
    // this open to algorithms we have not enumerated.
    if text
        .lines()
        .any(|l| l.starts_with("-----BEGIN ") && l.contains(" PRIVATE KEY-----"))
    {
        let encrypted = text.contains(PEM_ENCRYPTED_MARKER);
        return Ok(enrich(KeyFormat::Pem, encrypted, text));
    }

    Err(SshError::KeyLoad(
        "not a recognised private key (expected OpenSSH, PEM, PKCS#8 or PuTTY .ppk)".into(),
    ))
}

/// Check a passphrase against a key file, and report what the unlocked key is.
///
/// Pass `None` for a key with no passphrase. This is the gate before writing a
/// passphrase to the keyring: storing one that does not work turns a typo into
/// a connection failure much later, somewhere far less obviously connected to
/// the mistake.
///
/// # Errors
/// Returns [`SshError::KeyLoad`] if the file cannot be read or decoded, or if
/// the passphrase is wrong.
pub fn unlock(path: impl AsRef<Path>, passphrase: Option<&str>) -> Result<KeyInfo, SshError> {
    let path = path.as_ref();
    let text = std::fs::read_to_string(path)
        .map_err(|e| SshError::KeyLoad(format!("{}: {e}", path.display())))?;
    unlock_str(&text, passphrase)
}

/// [`unlock`] on key text already in memory.
///
/// # Errors
/// Returns [`SshError::KeyLoad`] if the text cannot be decoded or the
/// passphrase is wrong.
pub fn unlock_str(text: &str, passphrase: Option<&str>) -> Result<KeyInfo, SshError> {
    // Format classification comes from our own reading of the headers; the
    // decode below proves the passphrase but flattens every format into one
    // `PrivateKey`, losing which encoding it arrived in.
    let declared = inspect_str(text)?;

    let key = russh::keys::decode_secret_key(text, passphrase)
        .map_err(|e| SshError::KeyLoad(describe_decode_failure(&e, &declared, passphrase)))?;

    Ok(KeyInfo {
        format: declared.format,
        encrypted: declared.encrypted,
        algorithm: Some(key.algorithm().to_string()),
        fingerprint: Some(key.fingerprint(HashAlg::Sha256).to_string()),
        comment: non_empty(key.comment().as_ref()),
    })
}

/// Turn a decode failure into something the user can act on.
///
/// The distinction worth spending code on is "you typed it wrong" versus "this
/// build cannot read this format". They lead to opposite next steps, and
/// getting it backwards is actively harmful: it sends someone round a loop
/// retyping a passphrase that was correct the first time.
///
/// The concrete case that forced this apart is an `ssh-keygen -m PKCS8 -N …`
/// key. It uses PBKDF2-HMAC-SHA1, which `ssh-key` reaches only through
/// `pkcs5/sha1-insecure` — a feature it deliberately leaves off. The right
/// passphrase fails on those keys, permanently.
fn describe_decode_failure(
    err: &russh::keys::Error,
    declared: &KeyInfo,
    passphrase: Option<&str>,
) -> String {
    use russh::keys::Error;

    // Unreadable regardless of passphrase, so this has to be checked first.
    // `pkcs5` reports an unsupported KDF wrapped in `Pkcs8` with no
    // distinguishable variant of its own, leaving the message as the only
    // signal — hence the string check alongside the typed ones.
    let unsupported = matches!(
        err,
        Error::UnsupportedKeyType { .. } | Error::UnknownAlgorithm(_)
    ) || err.to_string().to_lowercase().contains("unsupported");
    if unsupported {
        return format!("unsupported key format: {err}");
    }

    if matches!(err, Error::KeyIsEncrypted) || (declared.encrypted && passphrase.is_none()) {
        return "this key is encrypted and needs a passphrase".into();
    }

    if declared.encrypted && passphrase.is_some() {
        // russh surfaces a padding or MAC failure here, which reads as file
        // corruption; for an encrypted key the far likelier cause is a typo.
        return format!("passphrase did not decrypt the key ({err})");
    }

    err.to_string()
}

/// OpenSSH stores the public key in cleartext beside the encrypted private
/// half, so everything except the private scalar survives without a passphrase.
fn inspect_openssh(text: &str) -> KeyInfo {
    match PrivateKey::from_openssh(text) {
        Ok(key) => KeyInfo {
            format: KeyFormat::OpenSsh,
            encrypted: key.is_encrypted(),
            algorithm: Some(key.algorithm().to_string()),
            fingerprint: Some(key.fingerprint(HashAlg::Sha256).to_string()),
            comment: non_empty(key.comment().as_ref()),
        },
        // A malformed body still has an unambiguous header. Reporting the
        // format we can see beats erroring out with nothing.
        Err(_) => KeyInfo {
            format: KeyFormat::OpenSsh,
            encrypted: false,
            algorithm: None,
            fingerprint: None,
            comment: None,
        },
    }
}

/// PPK is line-oriented and its metadata headers are outside the encrypted
/// region, so the algorithm and comment read out even for a locked key.
///
/// Hand-parsed rather than routed through `ssh-key`: its PPK entry point is
/// `PrivateKey::from_ppk`, which refuses an encrypted key outright when given
/// no passphrase — exactly the case this needs to describe.
fn inspect_ppk(text: &str) -> Result<KeyInfo, SshError> {
    let mut version = 0u8;
    let mut algorithm = None;
    let mut encryption = None;
    let mut comment = None;

    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            k if k.starts_with("PuTTY-User-Key-File-") => {
                version = k
                    .trim_start_matches("PuTTY-User-Key-File-")
                    .parse()
                    .map_err(|_| SshError::KeyLoad(format!("unreadable .ppk version in {k:?}")))?;
                algorithm = non_empty(value);
            }
            "Encryption" => encryption = non_empty(value),
            "Comment" => comment = non_empty(value),
            // Everything past the headers is key material; stop before it.
            "Public-Lines" => break,
            _ => {}
        }
    }

    if version == 0 {
        return Err(SshError::KeyLoad("missing .ppk version header".into()));
    }
    // v1 was never encrypted and is long dead; v4 does not exist yet. Refusing
    // here is better than reporting a version whose semantics we do not know.
    if !(2..=3).contains(&version) {
        return Err(SshError::KeyLoad(format!(
            "unsupported .ppk version {version} (this build reads v2 and v3)"
        )));
    }

    Ok(KeyInfo {
        format: KeyFormat::Ppk { version },
        // Absent header means unencrypted; "none" is how `PuTTY` spells it.
        encrypted: !matches!(encryption.as_deref(), None | Some("none")),
        algorithm,
        // A .ppk fingerprint would require hashing the public blob, which sits
        // in the Public-Lines body. `unlock` fills it in once decoded.
        fingerprint: None,
        comment,
    })
}

/// Best-effort detail for formats that carry no cleartext public key: decode
/// with no passphrase and keep whatever comes back.
fn enrich(format: KeyFormat, encrypted: bool, text: &str) -> KeyInfo {
    let decoded = if encrypted {
        None
    } else {
        russh::keys::decode_secret_key(text, None).ok()
    };

    KeyInfo {
        format,
        encrypted,
        algorithm: decoded.as_ref().map(|k| k.algorithm().to_string()),
        fingerprint: decoded
            .as_ref()
            .map(|k| k.fingerprint(HashAlg::Sha256).to_string()),
        comment: decoded
            .as_ref()
            .and_then(|k| non_empty(k.comment().as_ref())),
    }
}

/// Blank metadata is absent metadata — an empty comment is not information.
fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{KeyFormat, inspect_str, unlock_str};

    /// Header-only PPK: enough to classify, no key material. Real .ppk parsing
    /// is covered by the fixture tests, which skip without puttygen.
    fn ppk_header(version: u8, encryption: &str) -> String {
        format!(
            "PuTTY-User-Key-File-{version}: ssh-ed25519\n\
             Encryption: {encryption}\n\
             Comment: fixture-comment\n\
             Public-Lines: 2\n\
             AAAAC3NzaC1lZDI1NTE5AAAAIExample\n"
        )
    }

    #[test]
    fn ppk_v3_encrypted_is_described_without_a_passphrase() {
        let info = inspect_str(&ppk_header(3, "aes256-cbc")).expect("parse");
        assert_eq!(info.format, KeyFormat::Ppk { version: 3 });
        assert!(info.encrypted);
        assert_eq!(info.algorithm.as_deref(), Some("ssh-ed25519"));
        assert_eq!(info.comment.as_deref(), Some("fixture-comment"));
    }

    #[test]
    fn ppk_encryption_none_is_not_encrypted() {
        let info = inspect_str(&ppk_header(2, "none")).expect("parse");
        assert_eq!(info.format, KeyFormat::Ppk { version: 2 });
        assert!(!info.encrypted);
    }

    #[test]
    fn unknown_ppk_versions_are_refused_rather_than_guessed() {
        let err = inspect_str(&ppk_header(4, "none")).expect_err("v4 is unknown");
        assert!(err.to_string().contains("unsupported .ppk version 4"));
    }

    #[test]
    fn garbage_is_not_a_key() {
        let err = inspect_str("hello, this is not a key").expect_err("not a key");
        assert!(err.to_string().contains("not a recognised private key"));
    }

    /// An encrypted PKCS#8 body is opaque, but the header is not — the UI still
    /// needs to know it must ask for a passphrase.
    #[test]
    fn encrypted_pkcs8_is_classified_without_details() {
        let info = inspect_str(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n",
        )
        .expect("parse");
        assert_eq!(info.format, KeyFormat::Pkcs8);
        assert!(info.encrypted);
        assert!(info.algorithm.is_none());
    }

    #[test]
    fn pem_encryption_is_read_from_the_proc_type_header() {
        let clear = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";
        let enc = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\
                   DEK-Info: AES-128-CBC,0123\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";
        assert!(!inspect_str(clear).expect("parse").encrypted);
        assert!(inspect_str(enc).expect("parse").encrypted);
    }

    /// Real keys live in `.rig/keys/` (gitignored) and are exercised by
    /// `tests/keys.rs`; nothing here may embed key material.
    #[test]
    fn unlocking_a_non_key_fails_before_any_decode_is_attempted() {
        let err = unlock_str("not a key at all", Some("pass")).expect_err("not a key");
        assert!(err.to_string().contains("not a recognised private key"));
    }
}
