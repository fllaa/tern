//! Session lifecycle: connect, authenticate, open shell channels with a
//! backpressure-aware output pump.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use russh::ChannelWriteHalf;
use russh::client::{self, AuthResult};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PrivateKeyWithHashAlg, PublicKey, load_secret_key};
use russh::{ChannelMsg, Disconnect};
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::{AuthMethod, SessionConfig};
use crate::error::SshError;

/// Depth of the outbound `Bytes` queue between the pump and the consumer.
/// Bounded on purpose: it is one link in the end-to-end backpressure chain.
const OUTPUT_QUEUE_DEPTH: usize = 32;

/// What a user must see before trusting a host key (TOFU).
#[derive(Debug, Clone)]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    /// Key algorithm name, e.g. `ssh-ed25519`.
    pub algorithm: String,
    /// OpenSSH-style `SHA256:…` fingerprint.
    pub fingerprint_sha256: String,
}

/// Async host-key decision callback: return `true` to trust and continue.
pub type HostKeyCallback =
    Arc<dyn Fn(HostKeyInfo) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// A callback that trusts every host key. Test/rig use only — never wire this
/// into user-facing flows.
#[must_use]
pub fn accept_any_host_key() -> HostKeyCallback {
    Arc::new(|_| Box::pin(async { true }))
}

struct ClientHandler {
    host: String,
    port: u16,
    on_host_key: HostKeyCallback,
}

impl client::Handler for ClientHandler {
    type Error = SshError;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let info = HostKeyInfo {
            host: self.host.clone(),
            port: self.port,
            algorithm: key.algorithm().to_string(),
            fingerprint_sha256: key.fingerprint(HashAlg::Sha256).to_string(),
        };
        Ok((self.on_host_key)(info).await)
    }
}

/// An authenticated SSH session. Open shells with [`SshSession::open_shell`].
pub struct SshSession {
    handle: client::Handle<ClientHandler>,
    term: String,
}

impl SshSession {
    /// Connect, verify the host key via `on_host_key`, and authenticate.
    pub async fn connect(
        cfg: SessionConfig,
        on_host_key: HostKeyCallback,
    ) -> Result<Self, SshError> {
        let config = Arc::new(client::Config {
            window_size: cfg.window_size,
            maximum_packet_size: 32 * 1024,
            channel_buffer_size: cfg.channel_buffer_size,
            keepalive_interval: cfg.keepalive_interval,
            keepalive_max: cfg.keepalive_max,
            // Nagle would add up to one RTT to every keystroke echo.
            nodelay: true,
            ..client::Config::default()
        });
        let handler = ClientHandler {
            host: cfg.host.clone(),
            port: cfg.port,
            on_host_key,
        };

        let mut handle = tokio::time::timeout(
            cfg.connect_timeout,
            client::connect(config, (cfg.host.as_str(), cfg.port), handler),
        )
        .await
        .map_err(|_| SshError::ConnectTimeout(cfg.connect_timeout))?
        .map_err(|e| match e {
            SshError::Protocol(russh::Error::UnknownKey) => SshError::HostKeyRejected,
            other => other,
        })?;

        authenticate(&mut handle, &cfg).await?;

        Ok(Self {
            handle,
            term: cfg.term,
        })
    }

    /// Open an interactive shell with a PTY of the given size.
    pub async fn open_shell(&self, cols: u16, rows: u16) -> Result<ShellChannel, SshError> {
        let channel = self.handle.channel_open_session().await?;
        let (mut read_half, write_half) = channel.split();
        write_half
            .request_pty(
                false,
                &self.term,
                u32::from(cols),
                u32::from(rows),
                0,
                0,
                &[],
            )
            .await?;
        write_half.request_shell(true).await?;

        let (out_tx, out_rx) = mpsc::channel::<Bytes>(OUTPUT_QUEUE_DEPTH);
        let (pause_tx, mut pause_rx) = watch::channel(false);
        let (exit_tx, exit_rx) = oneshot::channel::<Option<u32>>();

        tokio::spawn(async move {
            let mut exit_code = None;
            loop {
                // Flow gate: while paused we stop consuming channel messages.
                // russh's bounded delivery buffer then fills, the session loop
                // stalls, and the SSH window drains — backpressure reaches the
                // remote process without any manual window management.
                if *pause_rx.borrow() {
                    if pause_rx.changed().await.is_err() {
                        break;
                    }
                    continue;
                }
                let msg = tokio::select! {
                    m = read_half.wait() => m,
                    _ = pause_rx.changed() => continue,
                };
                match msg {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                        if out_tx.send(Bytes::copy_from_slice(&data)).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => break,
                    // Eof, Success, WindowAdjusted, …: nothing to forward.
                    Some(_) => {}
                }
            }
            let _ = exit_tx.send(exit_code);
        });

        Ok(ShellChannel {
            output: out_rx,
            write: write_half,
            pause: pause_tx,
            exit: exit_rx,
        })
    }

    /// Cleanly disconnect the whole session.
    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(Disconnect::ByApplication, "closed by user", "en")
            .await?;
        Ok(())
    }
}

/// An open interactive shell. Reads flow through a bounded queue so a stalled
/// consumer throttles the remote end (see the pump task in `open_shell`).
pub struct ShellChannel {
    output: mpsc::Receiver<Bytes>,
    write: ChannelWriteHalf<client::Msg>,
    pause: watch::Sender<bool>,
    exit: oneshot::Receiver<Option<u32>>,
}

impl ShellChannel {
    /// Next chunk of terminal output; `None` when the channel closed.
    pub async fn recv(&mut self) -> Option<Bytes> {
        self.output.recv().await
    }

    /// Send input (keystrokes) to the remote shell.
    pub async fn write(&self, data: impl Into<Bytes> + Send) -> Result<(), SshError> {
        self.write.data_bytes(data).await?;
        Ok(())
    }

    /// Propagate a terminal resize to the remote PTY.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), SshError> {
        self.write
            .window_change(u32::from(cols), u32::from(rows), 0, 0)
            .await?;
        Ok(())
    }

    /// Stop consuming output (engages end-to-end backpressure).
    pub fn pause(&self) {
        let _ = self.pause.send(true);
    }

    /// Resume consuming output.
    pub fn resume(&self) {
        let _ = self.pause.send(false);
    }

    /// Close the channel; returns the remote exit status if the server sent one.
    pub async fn close(mut self) -> Result<Option<u32>, SshError> {
        let _ = self.write.eof().await;
        let _ = self.write.close().await;
        let drain = async {
            while self.output.recv().await.is_some() {}
            self.exit.await.unwrap_or(None)
        };
        Ok(tokio::time::timeout(Duration::from_secs(5), drain)
            .await
            .unwrap_or(None))
    }
}

async fn authenticate(
    handle: &mut client::Handle<ClientHandler>,
    cfg: &SessionConfig,
) -> Result<(), SshError> {
    let user = cfg.username.clone();
    let result = match &cfg.auth {
        AuthMethod::Password(password) => {
            handle.authenticate_password(user, password.clone()).await?
        }
        AuthMethod::KeyFile { path, passphrase } => {
            let key = load_secret_key(path, passphrase.as_deref())
                .map_err(|e| SshError::KeyLoad(e.to_string()))?;
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
        }
        AuthMethod::Agent => return authenticate_with_agent(handle, &user).await,
    };
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => Err(SshError::AuthFailed(format!(
            "server accepts: {remaining_methods:?}"
        ))),
    }
}

async fn authenticate_with_agent(
    handle: &mut client::Handle<ClientHandler>,
    user: &str,
) -> Result<(), SshError> {
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| SshError::Agent(e.to_string()))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Agent(e.to_string()))?;
    if identities.is_empty() {
        return Err(SshError::Agent("no identities loaded".into()));
    }
    let hash = handle.best_supported_rsa_hash().await?.flatten();

    let mut last_failure = String::from("no usable identities");
    for identity in identities {
        let key: PublicKey = match identity {
            AgentIdentity::PublicKey { key, .. } => key,
            // Certificate auth: Phase 1+.
            AgentIdentity::Certificate { .. } => continue,
        };
        let alg = key.algorithm().to_string();
        match handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(()),
            Ok(AuthResult::Failure { .. }) => last_failure = format!("{alg} key rejected"),
            Err(e) => last_failure = format!("{alg}: {e:?}"),
        }
    }
    Err(SshError::AuthFailed(format!("agent auth: {last_failure}")))
}
