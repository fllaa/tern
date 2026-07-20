//! Phase 0 Spike 3 smoke tests: spawn a real process on a real PTY on every OS.
//!
//! `ConPTY` caveat baked in: on Windows we assert `contains`, never exact match
//! (`ConPTY` injects escape sequences), and we gate on child exit + timeout —
//! never read-to-EOF.

use std::time::Duration;

use tern_core_pty::{LocalPty, PtyConfig};

async fn read_until(pty: &mut LocalPty, needle: &str, timeout: Duration) -> String {
    let mut acc = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timeout waiting for {needle:?}; got so far: {acc:?}"
        );
        let Ok(chunk) = tokio::time::timeout(remaining, pty.recv()).await else {
            panic!("timeout waiting for {needle:?}; got so far: {acc:?}")
        };
        match chunk {
            Some(bytes) => {
                acc.push_str(&String::from_utf8_lossy(&bytes));
                if acc.contains(needle) {
                    return acc;
                }
            }
            None => panic!("pty closed while waiting for {needle:?}; got: {acc:?}"),
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn unix_spawn_echo_and_exit() {
    let cfg = PtyConfig {
        program: Some("sh".into()),
        args: vec!["-c".into(), "printf hello-pty-%s ok".into()],
        ..PtyConfig::login_shell(80, 24)
    };
    let mut pty = LocalPty::spawn(&cfg).expect("spawn sh");
    read_until(&mut pty, "hello-pty-ok", Duration::from_secs(10)).await;
    let code = pty.wait_exit().await;
    assert_eq!(code, Some(0), "sh -c should exit 0");
}

#[cfg(unix)]
#[tokio::test]
async fn unix_resize_roundtrip() {
    let cfg = PtyConfig {
        program: Some("sh".into()),
        args: vec!["-c".into(), "sleep 2".into()],
        ..PtyConfig::login_shell(80, 24)
    };
    let pty = LocalPty::spawn(&cfg).expect("spawn sh");
    assert_eq!(pty.size().expect("size"), (80, 24));
    pty.resize(100, 40).expect("resize");
    assert_eq!(pty.size().expect("size after resize"), (100, 40));
}

#[cfg(unix)]
#[tokio::test]
async fn unix_interactive_write() {
    let cfg = PtyConfig {
        program: Some("sh".into()),
        args: vec!["-i".into()],
        ..PtyConfig::login_shell(80, 24)
    };
    let mut pty = LocalPty::spawn(&cfg).expect("spawn interactive sh");
    pty.write(b"echo write-path-$((6*7))\n".to_vec())
        .await
        .expect("write");
    read_until(&mut pty, "write-path-42", Duration::from_secs(10)).await;
    pty.write(b"exit\n".to_vec()).await.expect("write exit");
    let _ = pty.wait_exit().await;
}

#[cfg(windows)]
#[tokio::test]
async fn windows_conpty_echo() {
    let cfg = PtyConfig {
        program: Some("cmd.exe".into()),
        args: vec!["/c".into(), "echo hello-pty-ok".into()],
        ..PtyConfig::login_shell(80, 24)
    };
    let mut pty = LocalPty::spawn(&cfg).expect("spawn cmd (ConPTY)");

    // ConPTY handshake (Phase 0 finding): before releasing any child output,
    // ConPTY sends a Device Status Report (ESC[6n) and waits for the hosting
    // terminal to answer with a cursor position (ESC[row;colR). xterm.js does
    // this automatically in the app; a headless consumer must reply itself.
    let mut acc = String::new();
    let mut answered_dsr = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "timeout waiting for hello-pty-ok; got so far: {acc:?}"
        );
        let Ok(chunk) = tokio::time::timeout(remaining, pty.recv()).await else {
            panic!("timeout waiting for hello-pty-ok; got so far: {acc:?}")
        };
        let Some(bytes) = chunk else {
            panic!("pty closed early; got so far: {acc:?}")
        };
        acc.push_str(&String::from_utf8_lossy(&bytes));
        if !answered_dsr && acc.contains("\u{1b}[6n") {
            answered_dsr = true;
            pty.write(b"\x1b[1;1R".to_vec()).await.expect("answer DSR");
        }
        if acc.contains("hello-pty-ok") {
            break;
        }
    }

    let code = pty.wait_exit().await;
    assert_eq!(code, Some(0), "cmd /c echo should exit 0");
}
