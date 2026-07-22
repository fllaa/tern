//! Compose a `SessionConfig` from stored host settings.
//!
//! Layering, lowest precedence first:
//!
//! 1. `SessionConfig::new` defaults (the Phase 0 spike-tuned values)
//! 2. per-host overrides, where set
//! 3. `OpenSessionReq` fields, which the caller set explicitly for this session
//!
//! This lives in the desktop layer so `core-store` needs no `core-ssh`
//! dependency — the store returns records, and the mapping happens here.

use std::time::Duration;

use tern_core_ssh::{AuthMethod, SessionConfig};
use tern_core_store::Host;

/// Build the connection config for a stored host.
///
/// `auth` is the full chain: the host's primary method followed by its
/// fallbacks, already resolved against the keyring by `auth::auth_for_host`.
///
/// `req_window` is the session request's window-size override (the benchmark
/// harness drives it); it wins over the host record when set. Passed as a bare
/// value rather than the whole request so the reconnect supervisor can rebuild
/// the config without a request to hand it.
pub fn for_host(host: &Host, auth: Vec<AuthMethod>, req_window: Option<u32>) -> SessionConfig {
    let mut cfg = SessionConfig::new(
        host.hostname.clone(),
        host.username.clone(),
        // Replaced wholesale below; `new` needs something to build from.
        AuthMethod::Agent,
    );
    cfg.auth = auth;
    cfg.port = host.port;

    let o = &host.overrides;
    if let Some(term) = o.term.clone() {
        cfg.term = term;
    }
    if let Some(secs) = o.keepalive_secs {
        // Zero disables keepalives, matching OpenSSH's ServerAliveInterval 0.
        cfg.keepalive_interval = if secs == 0 {
            None
        } else {
            Some(Duration::from_secs(u64::from(secs)))
        };
    }
    if let Some(max) = o.keepalive_max {
        cfg.keepalive_max = max as usize;
    }
    if let Some(secs) = o.connect_timeout_secs {
        cfg.connect_timeout = Duration::from_secs(u64::from(secs));
    }
    if let Some(window) = o.window_size {
        cfg.window_size = window;
    }

    // The request wins over the host record: these are data-path tuning knobs
    // the caller set for this specific session (the benchmark harness relies
    // on being able to drive them).
    if let Some(window) = req_window {
        cfg.window_size = window;
    }
    cfg
}

#[cfg(test)]
mod tests {
    use super::for_host;
    use tern_core_ssh::AuthMethod;
    use tern_core_store::{NewHost, Store};
    fn host_with(f: impl FnOnce(&mut NewHost)) -> tern_core_store::Host {
        let store = Store::open_in_memory().expect("store");
        let mut draft = NewHost::manual("h", "example.com");
        draft.port = 2222;
        draft.username = "deploy".into();
        f(&mut draft);
        let id = store.hosts().create(&draft).expect("create");
        store.hosts().get(id).expect("get").expect("exists")
    }

    #[test]
    fn unset_overrides_leave_the_defaults_alone() {
        let host = host_with(|_| {});
        let cfg = for_host(&host, vec![AuthMethod::Agent], None);
        let defaults = tern_core_ssh::SessionConfig::new("x", "y", AuthMethod::Agent);

        assert_eq!(cfg.host, "example.com");
        assert_eq!(cfg.port, 2222);
        assert_eq!(cfg.username, "deploy");
        assert_eq!(cfg.term, defaults.term);
        assert_eq!(cfg.keepalive_interval, defaults.keepalive_interval);
        assert_eq!(cfg.window_size, defaults.window_size);
    }

    #[test]
    fn overrides_are_applied_when_set() {
        let host = host_with(|d| {
            d.overrides.term = Some("xterm".into());
            d.overrides.keepalive_secs = Some(45);
            d.overrides.keepalive_max = Some(7);
            d.overrides.connect_timeout_secs = Some(3);
            d.overrides.window_size = Some(64 * 1024);
        });
        let cfg = for_host(&host, vec![AuthMethod::Agent], None);

        assert_eq!(cfg.term, "xterm");
        assert_eq!(
            cfg.keepalive_interval,
            Some(std::time::Duration::from_secs(45))
        );
        assert_eq!(cfg.keepalive_max, 7);
        assert_eq!(cfg.connect_timeout, std::time::Duration::from_secs(3));
        assert_eq!(cfg.window_size, 64 * 1024);
    }

    #[test]
    fn zero_keepalive_disables_rather_than_hammering() {
        // Matching OpenSSH's ServerAliveInterval 0. Treating it as "every 0
        // seconds" would spin.
        let host = host_with(|d| d.overrides.keepalive_secs = Some(0));
        let cfg = for_host(&host, vec![AuthMethod::Agent], None);
        assert_eq!(cfg.keepalive_interval, None);
    }

    #[test]
    fn request_window_beats_the_host_override() {
        // The benchmark harness drives window_size per run; it must win over
        // whatever the stored host happens to say.
        let host = host_with(|d| d.overrides.window_size = Some(64 * 1024));
        let cfg = for_host(&host, vec![AuthMethod::Agent], Some(512 * 1024));
        assert_eq!(cfg.window_size, 512 * 1024);
    }
}
