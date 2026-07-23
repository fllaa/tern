//! Integration tests against the local sshd rig (`scripts/sshd-rig.sh up`).
//!
//! Tests skip (with a message) when the rig isn't running, so `cargo test`
//! stays green on machines without Docker. The `integration` CI job brings the
//! rig up on Linux and runs them for real; the macOS and Windows legs have no
//! Docker and keep skipping.

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tern_core_ssh::{
    AuthMethod, HostKeyCallback, JumpHop, SessionConfig, ShellChannel, SshSession,
    accept_any_host_key,
};

const OPENSSH_PORT: u16 = 2222;
const DROPBEAR_PORT: u16 = 2223;
/// `PasswordAuthentication no`; see the compose service of the same name.
const NOPASSWORD_PORT: u16 = 2224;
/// Bastion for the `ProxyJump` tests; fronts the port-less `openssh-internal`.
const JUMP_PORT: u16 = 2225;

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

/// A real key that the rig does *not* authorise, from the key fixtures. Needed
/// to make an attempt the server actually rejects, rather than one that fails
/// locally before it is ever sent.
macro_rules! require_key_fixture {
    ($name:expr) => {{
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.rig/keys")
            .join($name);
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

/// The fallback case worth having: the first method cannot even be attempted
/// (the key file does not exist) and the chain moves on rather than giving up.
#[tokio::test]
async fn a_local_failure_falls_through_to_the_next_method() {
    require_rig!(OPENSSH_PORT);
    let cfg = SessionConfig {
        port: OPENSSH_PORT,
        auth: vec![
            AuthMethod::key_file("/nonexistent/key", None),
            AuthMethod::password("tern123"),
        ],
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::Agent)
    };
    let session = SshSession::connect(cfg, accept_any_host_key())
        .await
        .expect("password should carry the connection after the key file fails");
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("echo chain-ok\n").await.expect("write");
    read_until(&mut shell, "chain-ok", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
}

/// Order matters: a working first method must not be skipped in favour of a
/// later one, or "prefer the key, fall back to the password" would silently
/// become "always use the password".
#[tokio::test]
async fn the_first_working_method_wins() {
    require_rig!(OPENSSH_PORT);
    let cfg = SessionConfig {
        port: OPENSSH_PORT,
        // A wrong password after a good key: if the chain ran to the end, or ran
        // out of order, this would fail.
        auth: vec![key_auth(), AuthMethod::password("definitely-wrong")],
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::Agent)
    };
    let session = SshSession::connect(cfg, accept_any_host_key())
        .await
        .expect("the key should authenticate before the password is reached");
    session.disconnect().await.expect("disconnect");
}

/// When everything fails, the error has to say what was tried — one line per
/// method, with the key path. "Authentication failed" alone is unactionable
/// when three methods were involved.
#[tokio::test]
async fn an_exhausted_chain_reports_every_attempt() {
    require_rig!(OPENSSH_PORT);
    let cfg = SessionConfig {
        port: OPENSSH_PORT,
        auth: vec![
            AuthMethod::key_file("/nonexistent/key", None),
            AuthMethod::password("wrong"),
        ],
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::Agent)
    };
    // `SshSession` has no `Debug`, so `expect_err` is unavailable here.
    let msg = match SshSession::connect(cfg, accept_any_host_key()).await {
        Ok(_) => panic!("both methods are bad; the connect must fail"),
        Err(e) => e.to_string(),
    };

    assert!(
        msg.contains("/nonexistent/key"),
        "the failing key path should be named: {msg}"
    );
    assert!(
        msg.contains("password"),
        "the password attempt should be named: {msg}"
    );
}

/// The skip branch, against a server that really does refuse passwords.
///
/// The first key is real but not authorised, so it reaches the server and is
/// rejected — which is what populates the remaining-methods list. (A
/// *nonexistent* key would fail locally, never reach the server, and leave
/// nothing to skip against.) The list then says publickey only, so the password
/// is skipped rather than attempted.
///
/// Worth a dedicated server: on the main rig, which offers both methods, this
/// branch never executes, and a wrong `method_kind` mapping would go unnoticed
/// while silently skipping methods that would have worked.
#[tokio::test]
async fn a_method_the_server_refuses_is_skipped_not_attempted() {
    require_rig!(NOPASSWORD_PORT);
    let unauthorised = require_key_fixture!("id_ed25519");
    let cfg = SessionConfig {
        port: NOPASSWORD_PORT,
        auth: vec![
            AuthMethod::key_file(unauthorised, None),
            AuthMethod::password("tern123"),
        ],
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::Agent)
    };
    let msg = match SshSession::connect(cfg, accept_any_host_key()).await {
        Ok(_) => panic!("password auth is disabled on this server; connect must fail"),
        Err(e) => e.to_string(),
    };

    assert!(
        msg.contains("password: not offered by server"),
        "the password should have been skipped, not attempted: {msg}"
    );
}

/// The other half of that pairing: a method the server *does* offer is still
/// attempted after an earlier failure. Without this, the test above would pass
/// just as happily if the chain skipped everything.
#[tokio::test]
async fn an_offered_method_is_still_attempted_after_an_earlier_failure() {
    require_rig!(NOPASSWORD_PORT);
    let cfg = SessionConfig {
        port: NOPASSWORD_PORT,
        auth: vec![AuthMethod::key_file("/nonexistent/key", None), key_auth()],
        ..SessionConfig::new(rig_host(), "tern", AuthMethod::Agent)
    };
    let session = SshSession::connect(cfg, accept_any_host_key())
        .await
        .expect("the real key is publickey, which this server does offer");
    session.disconnect().await.expect("disconnect");
}

/// A slow host-key decision must not surface as a connect timeout. The connect
/// timeout bounds the network handshake; the human at the TOFU dialog is not
/// the network, and their thinking time cannot count against it.
///
/// The callback here deliberately blocks three times the connect timeout before
/// accepting. Without the re-arm, that delay would trip `ConnectTimeout`; with
/// it, the connect waits for the decision and then succeeds.
#[tokio::test]
async fn a_slow_host_key_decision_does_not_trip_the_connect_timeout() {
    require_rig!(OPENSSH_PORT);
    let cfg = SessionConfig {
        port: OPENSSH_PORT,
        connect_timeout: Duration::from_millis(400),
        ..SessionConfig::new(rig_host(), "tern", key_auth())
    };
    let slow_accept: HostKeyCallback = Arc::new(|_| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            true
        })
    });
    let session = SshSession::connect(cfg, slow_accept)
        .await
        .expect("a slow but eventual host-key accept must connect, not time out");
    session.disconnect().await.expect("disconnect");
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

/// `ProxyJump` execution, end to end: the target (`openssh-internal`) publishes no
/// port and its name resolves only on the segmented docker network, so the one
/// way to reach it is by tunneling through the bastion. A wrong direct-tcpip
/// chain cannot connect at all — which is exactly what this asserts works.
#[tokio::test]
async fn reaches_a_segmented_host_only_via_proxy_jump() {
    require_rig!(JUMP_PORT);
    let cfg = SessionConfig {
        jumps: vec![JumpHop {
            host: rig_host(),
            port: JUMP_PORT,
            username: "tern".into(),
            auth: vec![key_auth()],
        }],
        // The docker service name, resolvable only from inside the jump.
        ..SessionConfig::new("openssh-internal", "tern", key_auth())
    };
    let session = SshSession::connect(cfg, accept_any_host_key())
        .await
        .expect("connect to the segmented host through the jump");
    let mut shell = session.open_shell(80, 24).await.expect("open shell");
    shell.write("echo jumped-$((6*7))\n").await.expect("write");
    read_until(&mut shell, "jumped-42", Duration::from_secs(10)).await;
    shell.close().await.expect("close");
    session.disconnect().await.expect("disconnect");
}

/// The negative control: without the jump the segmented host is unreachable —
/// its name does not resolve on the host and it has no published port. This is
/// what makes the test above about the *jump*, not about mere connectivity.
#[tokio::test]
async fn the_segmented_host_is_unreachable_without_the_jump() {
    require_rig!(JUMP_PORT);
    let cfg = SessionConfig {
        connect_timeout: Duration::from_secs(3),
        ..SessionConfig::new("openssh-internal", "tern", key_auth())
    };
    let result = SshSession::connect(cfg, accept_any_host_key()).await;
    assert!(
        result.is_err(),
        "the segmented host must be unreachable without the jump"
    );
}
