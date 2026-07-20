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
    AuthMethod::KeyFile {
        path: rig_key(),
        passphrase: None,
    }
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
    let session = connect(OPENSSH_PORT, AuthMethod::Password("tern123".into())).await;
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
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::Password("wrong".into()))
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
