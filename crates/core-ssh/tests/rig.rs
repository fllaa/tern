//! Integration tests against the local sshd rig (`scripts/sshd-rig.sh up`).
//!
//! Tests skip (with a message) when the rig isn't running, so `cargo test`
//! stays green on machines without Docker. CI brings the rig up on Linux.

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use tern_core_ssh::{AuthMethod, SessionConfig, ShellChannel, SshSession, accept_any_host_key};

const OPENSSH_PORT: u16 = 2222;
const DROPBEAR_PORT: u16 = 2223;

fn rig_host() -> String {
    std::env::var("TERN_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into())
}

fn rig_key() -> PathBuf {
    std::env::var("TERN_SSH_KEY").map_or_else(
        |_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.rig/ssh/id_ed25519"),
        PathBuf::from,
    )
}

fn rig_up(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

macro_rules! require_rig {
    ($port:expr) => {
        if !rig_up($port) {
            eprintln!(
                "SKIP: sshd rig not up on port {} (scripts/sshd-rig.sh up)",
                $port
            );
            return;
        }
    };
}

fn key_auth() -> AuthMethod {
    AuthMethod::key_file(rig_key(), None)
}

async fn connect(port: u16, auth: AuthMethod) -> SshSession {
    let cfg = SessionConfig {
        port,
        ..SessionConfig::new(rig_host(), "tern", auth)
    };
    SshSession::connect(cfg, accept_any_host_key())
        .await
        .expect("connect to rig")
}

async fn read_until(shell: &mut ShellChannel, needle: &str, timeout: Duration) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timeout waiting for {needle:?}; got so far: {acc:?}"
        );
        let Ok(chunk) = tokio::time::timeout(remaining, shell.recv()).await else {
            panic!("timeout waiting for {needle:?}; got so far: {acc:?}")
        };
        match chunk {
            Some(bytes) => {
                acc.push_str(&String::from_utf8_lossy(&bytes));
                if acc.contains(needle) {
                    return acc;
                }
            }
            None => panic!("channel closed while waiting for {needle:?}; got: {acc:?}"),
        }
    }
}

#[tokio::test]
async fn password_auth_and_echo() {
    require_rig!(OPENSSH_PORT);
    let session = connect(OPENSSH_PORT, AuthMethod::password("tern123")).await;
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("echo tern-$((2+3))\n").await.expect("write");
    read_until(&mut shell, "tern-5", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
    session.disconnect().await.expect("disconnect");
}

#[tokio::test]
async fn key_auth_and_echo() {
    require_rig!(OPENSSH_PORT);
    let session = connect(OPENSSH_PORT, key_auth()).await;
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("echo key-ok-$((10*2))\n").await.expect("write");
    read_until(&mut shell, "key-ok-20", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
}

#[tokio::test]
async fn wrong_password_fails() {
    require_rig!(OPENSSH_PORT);
    let cfg = SessionConfig {
        port: OPENSSH_PORT,
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::password("wrong"))
    };
    let result = SshSession::connect(cfg, accept_any_host_key()).await;
    assert!(result.is_err(), "auth with a wrong password must fail");
}

#[tokio::test]
async fn resize_is_reflected_by_stty() {
    require_rig!(OPENSSH_PORT);
    let session = connect(OPENSSH_PORT, key_auth()).await;
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("stty size\n").await.expect("write");
    read_until(&mut shell, "24 80", Duration::from_secs(10)).await;

    shell.resize(120, 40).await.expect("resize");
    // SIGWINCH delivery is asynchronous; poll until the PTY reports the new size.
    let mut ok = false;
    for _ in 0..10 {
        shell.write("stty size\n").await.expect("write");
        let out = read_until(&mut shell, "\n", Duration::from_secs(5)).await;
        if out.contains("40 120") {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(ok, "PTY did not report 40x120 after resize");
    shell.close().await.expect("close");
}

#[tokio::test]
async fn ctrl_c_interrupts_remote_sleep() {
    require_rig!(OPENSSH_PORT);
    let session = connect(OPENSSH_PORT, key_auth()).await;
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("sleep 100\n").await.expect("write");
    tokio::time::sleep(Duration::from_millis(500)).await;
    shell.write(&b"\x03"[..]).await.expect("write ctrl-c");
    shell.write("echo after-int\n").await.expect("write");
    read_until(&mut shell, "after-int", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
}

#[tokio::test]
async fn dropbear_key_auth_and_echo() {
    require_rig!(DROPBEAR_PORT);
    let session = connect(DROPBEAR_PORT, key_auth()).await;
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("echo dropbear-ok\n").await.expect("write");
    read_until(&mut shell, "dropbear-ok", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
}

/// The 2-minute idle gate from the spike definition. Slow by design, so it is
/// `#[ignore]`d; run explicitly with:
/// `cargo test -p tern-core-ssh --test rig -- --ignored`
#[tokio::test]
#[ignore = "takes >2 minutes; keepalive idle-survival gate"]
async fn survives_two_minutes_idle_with_keepalives() {
    require_rig!(OPENSSH_PORT);
    let session = connect(OPENSSH_PORT, key_auth()).await;
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("echo before-idle\n").await.expect("write");
    read_until(&mut shell, "before-idle", Duration::from_secs(10)).await;

    tokio::time::sleep(Duration::from_secs(130)).await;

    shell.write("echo after-idle\n").await.expect("write");
    read_until(&mut shell, "after-idle", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
}

/// The M1 exit behaviour, end to end against a real server: an unknown host
/// prompts once, and every connect after that is silent.
///
/// This exercises the real integration — `KnownHostsFile` driven from inside
/// an actual `HostKeyCallback` during a live handshake — rather than the
/// parser in isolation. The desktop layer wraps the same two calls.
#[tokio::test]
async fn tofu_prompts_once_then_trusts_silently() {
    require_rig!(OPENSSH_PORT);

    let dir = std::env::temp_dir().join(format!("tern-tofu-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let kh_path = dir.join("known_hosts");
    let _ = std::fs::remove_file(&kh_path);

    // Counts how many times the user would have been asked.
    let prompts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let make_callback = |accept: bool| {
        let path = kh_path.clone();
        let prompts = std::sync::Arc::clone(&prompts);
        std::sync::Arc::new(move |info: tern_core_ssh::HostKeyInfo| {
            let path = path.clone();
            let prompts = std::sync::Arc::clone(&prompts);
            Box::pin(async move {
                let file = tern_core_ssh::KnownHostsFile::at(&path);
                match file.verify(&info.host, info.port, &info.public_key) {
                    Ok(tern_core_ssh::HostKeyVerdict::Trusted) => true,
                    Ok(tern_core_ssh::HostKeyVerdict::Unknown) => {
                        prompts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if accept {
                            file.learn(&info.host, info.port, &info.public_key, false)
                                .expect("record host key");
                        }
                        accept
                    }
                    _ => false,
                }
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        }) as tern_core_ssh::HostKeyCallback
    };

    let cfg = || SessionConfig {
        port: OPENSSH_PORT,
        ..SessionConfig::new(rig_host(), "tern", key_auth())
    };

    // First contact: prompted, accepted, recorded.
    let first = SshSession::connect(cfg(), make_callback(true)).await;
    assert!(
        first.is_ok(),
        "first connect should succeed after accepting"
    );
    assert_eq!(
        prompts.load(std::sync::atomic::Ordering::Relaxed),
        1,
        "first connect should prompt exactly once"
    );
    drop(first);

    // Second connect: the key is on file, so the callback must not ask again.
    // A callback that would refuse any prompt proves it never reached one.
    let second = SshSession::connect(cfg(), make_callback(false)).await;
    assert!(
        second.is_ok(),
        "second connect should be trusted silently, not re-prompted"
    );
    assert_eq!(
        prompts.load(std::sync::atomic::Ordering::Relaxed),
        1,
        "second connect must not prompt again"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A host whose key changed is refused, and stays refused until the entry is
/// explicitly removed — never a "trust anyway" in the same flow.
#[tokio::test]
async fn changed_host_key_is_refused_until_removed() {
    require_rig!(OPENSSH_PORT);

    let dir = std::env::temp_dir().join(format!("tern-changed-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let kh_path = dir.join("known_hosts");
    let _ = std::fs::remove_file(&kh_path);

    let host = rig_host();
    let file = tern_core_ssh::KnownHostsFile::at(&kh_path);

    // Record a *different* key for this host, standing in for a server that
    // was rebuilt (or an attacker).
    let wrong: russh::keys::ssh_key::PublicKey = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/known_hosts/key_a.pub"
    ))
    .expect("read fixture")
    .trim()
    .parse()
    .expect("parse fixture key");
    file.learn(&host, OPENSSH_PORT, &wrong, false)
        .expect("seed a stale entry");

    let saw_changed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cb = {
        let path = kh_path.clone();
        let saw = std::sync::Arc::clone(&saw_changed);
        std::sync::Arc::new(move |info: tern_core_ssh::HostKeyInfo| {
            let path = path.clone();
            let saw = std::sync::Arc::clone(&saw);
            Box::pin(async move {
                let verdict = tern_core_ssh::KnownHostsFile::at(&path)
                    .verify(&info.host, info.port, &info.public_key)
                    .expect("verify");
                if matches!(verdict, tern_core_ssh::HostKeyVerdict::Changed { .. }) {
                    saw.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                matches!(verdict, tern_core_ssh::HostKeyVerdict::Trusted)
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        }) as tern_core_ssh::HostKeyCallback
    };

    let cfg = SessionConfig {
        port: OPENSSH_PORT,
        ..SessionConfig::new(host.clone(), "tern", key_auth())
    };
    let refused = SshSession::connect(cfg, cb).await;
    assert!(
        refused.is_err(),
        "a changed host key must refuse the connect"
    );
    assert!(
        saw_changed.load(std::sync::atomic::Ordering::Relaxed),
        "the verdict should be Changed, not merely Unknown"
    );

    // Recovery is explicit removal, after which it is ordinary first contact.
    let removed = file.remove(&host, OPENSSH_PORT).expect("remove");
    assert_eq!(removed, 1);
    let verdict = file
        .verify(&host, OPENSSH_PORT, &wrong)
        .expect("verify after removal");
    assert_eq!(verdict, tern_core_ssh::HostKeyVerdict::Unknown);

    let _ = std::fs::remove_dir_all(&dir);
}
