//! Spike 1: interactive SSH shell on russh, in your real terminal.
//!
//! ```sh
//! cargo run -p tern-core-ssh --example shell -- tern@127.0.0.1:2222 --key .rig/ssh/id_ed25519
//! cargo run -p tern-core-ssh --example shell -- tern@127.0.0.1:2222 --password
//! cargo run -p tern-core-ssh --example shell -- user@host            # agent auth (default)
//! ```
//!
//! Ctrl-Q exits locally; everything else (including Ctrl-C) goes to the remote.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use crossterm::terminal;
use tern_core_ssh::{
    AuthMethod, HostKeyCallback, SessionConfig, ShellChannel, SshSession, accept_any_host_key,
};
use tokio::sync::mpsc;

const CTRL_Q: u8 = 0x11;

struct Args {
    user: String,
    host: String,
    port: u16,
    auth: AuthMethod,
    insecure_accept: bool,
}

fn usage() -> ! {
    eprintln!(
        "usage: shell <user@host[:port]> [--password | --key <path> [--passphrase <pp>] | --agent] [--insecure-accept]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(target) = argv.first() else { usage() };
    let Some((user, hostport)) = target.split_once('@') else {
        usage()
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            Err(_) => usage(),
        },
        None => (hostport.to_string(), 22),
    };

    let mut auth: Option<AuthMethod> = None;
    let mut insecure_accept = false;
    let mut key_path: Option<PathBuf> = None;
    let mut passphrase: Option<String> = None;

    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--password" => {
                let pw = rpassword::prompt_password(format!("{user}@{host}'s password: "))
                    .unwrap_or_else(|e| {
                        eprintln!("could not read password: {e}");
                        std::process::exit(1);
                    });
                auth = Some(AuthMethod::Password(pw));
            }
            "--agent" => auth = Some(AuthMethod::Agent),
            "--key" => {
                i += 1;
                key_path = Some(PathBuf::from(
                    argv.get(i).cloned().unwrap_or_else(|| usage()),
                ));
            }
            "--passphrase" => {
                i += 1;
                passphrase = Some(argv.get(i).cloned().unwrap_or_else(|| usage()));
            }
            "--insecure-accept" => insecure_accept = true,
            _ => usage(),
        }
        i += 1;
    }
    if let Some(path) = key_path {
        auth = Some(AuthMethod::KeyFile { path, passphrase });
    }

    Args {
        user: user.to_string(),
        host,
        port,
        auth: auth.unwrap_or(AuthMethod::Agent),
        insecure_accept,
    }
}

fn tofu_prompt() -> HostKeyCallback {
    Arc::new(|info| {
        Box::pin(async move {
            let answer = tokio::task::spawn_blocking(move || {
                eprintln!(
                    "Host key for {}:{} ({})",
                    info.host, info.port, info.algorithm
                );
                eprintln!("  {}", info.fingerprint_sha256);
                eprint!("Trust this key? (yes/no): ");
                std::io::stderr().flush().ok();
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).ok();
                matches!(line.trim(), "yes" | "y")
            })
            .await;
            answer.unwrap_or(false)
        })
    })
}

/// Restores the terminal even if the session loop panics.
struct RawModeGuard;

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

fn spawn_stdin_reader() -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(16);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

async fn run_session(mut shell: ShellChannel) -> Option<u32> {
    let mut stdin_rx = spawn_stdin_reader();
    let mut winch = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
        .expect("SIGWINCH stream");
    let mut stdout = std::io::stdout();

    loop {
        tokio::select! {
            out = shell.recv() => match out {
                Some(bytes) => {
                    stdout.write_all(&bytes).ok();
                    stdout.flush().ok();
                }
                None => break,
            },
            data = stdin_rx.recv() => match data {
                Some(bytes) => {
                    if bytes.contains(&CTRL_Q) {
                        break;
                    }
                    if shell.write(bytes).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            _ = winch.recv() => {
                if let Ok((cols, rows)) = terminal::size() {
                    shell.resize(cols, rows).await.ok();
                }
            }
        }
    }

    shell.close().await.ok().flatten()
}

#[tokio::main]
async fn main() {
    let args = parse_args();

    let on_host_key = if args.insecure_accept {
        accept_any_host_key()
    } else {
        tofu_prompt()
    };

    let cfg = SessionConfig {
        port: args.port,
        ..SessionConfig::new(args.host, args.user, args.auth)
    };

    let session = match SshSession::connect(cfg, on_host_key).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("connect failed: {e}");
            std::process::exit(1);
        }
    };

    let (cols, rows) = terminal::size().unwrap_or((80, 24));
    let shell = match session.open_shell(cols, rows).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("open shell failed: {e}");
            std::process::exit(1);
        }
    };

    terminal::enable_raw_mode().expect("enable raw mode");
    let guard = RawModeGuard;
    let exit_code = run_session(shell).await;
    drop(guard);

    session.disconnect().await.ok();
    match exit_code {
        Some(code) => eprintln!("\n[session closed, exit status {code}]"),
        None => eprintln!("\n[session closed]"),
    }
}
