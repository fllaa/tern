//! Phase 0 Spike 4: prove the OS keyring round-trip on all three OSes.
//!
//! macOS/Windows run natively; Linux CI needs a Secret Service
//! (gnome-keyring unlocked under a session D-Bus — see ci.yml).

use tern_core_vault::{OsKeyring, VaultError};

/// One serialized test so parallel cases never race the credential store.
#[test]
fn keyring_roundtrip() {
    // Unique per run so concurrent CI jobs / stale leftovers can't collide.
    let service = format!("io.github.fllaa.tern.test-{}", std::process::id());
    let ring = OsKeyring::new(service);
    let account = "spike4";

    // set -> get
    ring.set_password(account, "first-secret")
        .expect("set_password");
    assert_eq!(
        ring.get_password(account).expect("get_password"),
        "first-secret"
    );

    // overwrite -> get
    ring.set_password(account, "second-secret")
        .expect("overwrite password");
    assert_eq!(
        ring.get_password(account).expect("get after overwrite"),
        "second-secret"
    );

    // binary round-trip (includes NUL and high bytes)
    let blob: Vec<u8> = vec![0, 1, 2, 254, 255, 42, 0, 7];
    ring.set_secret(account, &blob).expect("set_secret");
    assert_eq!(ring.get_secret(account).expect("get_secret"), blob);

    // delete -> NotFound
    ring.delete(account).expect("delete");
    match ring.get_password(account) {
        Err(VaultError::NotFound) => {}
        other => panic!("expected NotFound after delete, got: {other:?}"),
    }

    // deleting again is also NotFound, not a panic
    match ring.delete(account) {
        Err(VaultError::NotFound) => {}
        other => panic!("expected NotFound on double delete, got: {other:?}"),
    }
}
