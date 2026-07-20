//! Local shell tabs via `portable-pty` (`ConPTY` on Windows, `openpty` elsewhere).
//!
//! `portable-pty` readers/writers are blocking, so this crate bridges them to
//! tokio with dedicated threads and bounded channels. The bounds are the point:
//! a paused consumer blocks the reader thread, the kernel PTY buffer fills, and
//! the child process stalls — the same backpressure semantics as the SSH path.
//!
//! This crate must never depend on `tauri`.

use std::path::PathBuf;

use bytes::Bytes;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::{mpsc, oneshot};

/// Depth of the outbound queue between the reader thread and the consumer.
/// Bounded on purpose — one link in the backpressure chain.
const OUTPUT_QUEUE_DEPTH: usize = 32;
/// Reader thread chunk size.
const READ_CHUNK: usize = 8 * 1024;

/// Errors from local PTY management.
#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("pty: {0}")]
    Pty(String),
    #[error("pty writer closed")]
    WriterClosed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// What to run and how big the PTY starts.
#[derive(Debug, Clone)]
pub struct PtyConfig {
    /// Program to spawn; `None` picks the platform login shell
    /// (`$SHELL`/zsh `-l` on macOS, `$SHELL`/bash on Linux, pwsh→powershell→cmd
    /// on Windows).
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
}

impl PtyConfig {
    /// The platform login shell at the given size.
    #[must_use]
    pub fn login_shell(cols: u16, rows: u16) -> Self {
        Self {
            program: None,
            args: Vec::new(),
            cwd: None,
            cols,
            rows,
        }
    }
}

fn default_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        (shell, vec!["-l".into()])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        (shell, Vec::new())
    }
    #[cfg(windows)]
    {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            let found = std::env::var_os("PATH").is_some_and(|paths| {
                std::env::split_paths(&paths).any(|dir| dir.join(candidate).is_file())
            });
            if found {
                return (candidate.into(), Vec::new());
            }
        }
        ("cmd.exe".into(), Vec::new())
    }
}

/// A running local PTY with its child process.
pub struct LocalPty {
    output: mpsc::Receiver<Bytes>,
    writer: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    exit: oneshot::Receiver<u32>,
}

impl LocalPty {
    /// Spawn the configured program on a fresh PTY.
    pub fn spawn(cfg: &PtyConfig) -> Result<Self, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Pty(e.to_string()))?;

        let (program, args) = match &cfg.program {
            Some(p) => (p.clone(), cfg.args.clone()),
            None => default_shell(),
        };
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        if let Some(cwd) = &cfg.cwd {
            cmd.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Pty(e.to_string()))?;
        // ConPTY hygiene: the slave side must be dropped in the parent right
        // after spawn, or reads never observe the child's EOF.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Pty(e.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Pty(e.to_string()))?;

        let (out_tx, out_rx) = mpsc::channel::<Bytes>(OUTPUT_QUEUE_DEPTH);
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Blocks when the consumer pauses -> kernel PTY buffer
                        // fills -> child stalls. Backpressure by construction.
                        if out_tx
                            .blocking_send(Bytes::copy_from_slice(&buf[..n]))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });

        let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(16);
        std::thread::spawn(move || {
            while let Some(data) = write_rx.blocking_recv() {
                if std::io::Write::write_all(&mut writer, &data).is_err() {
                    break;
                }
                let _ = std::io::Write::flush(&mut writer);
            }
        });

        let (exit_tx, exit_rx) = oneshot::channel::<u32>();
        std::thread::spawn(move || {
            let code = child.wait().map_or(1, |status| status.exit_code());
            let _ = exit_tx.send(code);
        });

        Ok(Self {
            output: out_rx,
            writer: write_tx,
            master: pair.master,
            exit: exit_rx,
        })
    }

    /// Next chunk of terminal output; `None` once the PTY closed.
    pub async fn recv(&mut self) -> Option<Bytes> {
        self.output.recv().await
    }

    /// Send input (keystrokes) to the child.
    pub async fn write(&self, data: Vec<u8>) -> Result<(), PtyError> {
        self.writer
            .send(data)
            .await
            .map_err(|_| PtyError::WriterClosed)
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Pty(e.to_string()))
    }

    /// Current PTY size as `(cols, rows)`.
    pub fn size(&self) -> Result<(u16, u16), PtyError> {
        let size = self
            .master
            .get_size()
            .map_err(|e| PtyError::Pty(e.to_string()))?;
        Ok((size.cols, size.rows))
    }

    /// Wait for the child to exit and return its exit code.
    pub async fn wait_exit(self) -> Option<u32> {
        self.exit.await.ok()
    }
}
