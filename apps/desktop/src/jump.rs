//! Resolve a host's `ProxyJump` spec into a chain of dialable hops.
//!
//! This lives in the desktop layer, like `auth.rs`, because resolving a jump
//! touches both the store (does a saved host match this hop?) and the keyring
//! (reuse that host's credential) — and `core-ssh` may depend on neither.

use tern_core_ssh::{AuthMethod, JumpHop};
use tern_core_store::{Host, HostFilter, Store};

/// A parsed `[user@]host[:port]` jump spec.
struct HopSpec {
    user: Option<String>,
    host: String,
    port: Option<u16>,
}

/// Parse one `[user@]host[:port]`; `None` for an empty spec.
fn parse_hop(raw: &str) -> Option<HopSpec> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let (user, rest) = match raw.split_once('@') {
        Some((u, r)) => (Some(u.to_owned()), r),
        None => (None, raw),
    };
    // Split a trailing `:port` only when the tail actually parses as one, which
    // leaves bare IPv6 literals (full of colons) alone.
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() => match p.parse::<u16>() {
            Ok(port) => (h.to_owned(), Some(port)),
            Err(_) => (rest.to_owned(), None),
        },
        _ => (rest.to_owned(), None),
    };
    Some(HopSpec { user, host, port })
}

/// Resolve a comma-separated `ProxyJump` spec into dialable hops, in order.
///
/// A hop that matches a saved host reuses that host's auth chain and keyring
/// secret; an unmatched hop falls back to the SSH agent, taking its username
/// from the spec or, absent that, from `default_user` (the target's user).
#[must_use]
pub fn resolve_jumps(store: &Store, spec: &str, default_user: &str) -> Vec<JumpHop> {
    spec.split(',')
        .filter_map(parse_hop)
        .map(|hop| resolve_one(store, &hop, default_user))
        .collect()
}

fn resolve_one(store: &Store, hop: &HopSpec, default_user: &str) -> JumpHop {
    match find_saved_host(store, hop) {
        Some(host) => JumpHop {
            host: host.hostname.clone(),
            port: hop.port.unwrap_or(host.port),
            username: hop.user.clone().unwrap_or_else(|| host.username.clone()),
            auth: crate::auth::auth_for_host(&host).methods,
        },
        None => JumpHop {
            host: hop.host.clone(),
            port: hop.port.unwrap_or(22),
            username: hop.user.clone().unwrap_or_else(|| default_user.to_owned()),
            auth: vec![AuthMethod::Agent],
        },
    }
}

/// A saved host whose hostname exactly matches the hop — and whose user and
/// port match too, when the spec pinned them. The `LIKE` query only narrows the
/// candidates; the exact match is done here.
fn find_saved_host(store: &Store, hop: &HopSpec) -> Option<Host> {
    let filter = HostFilter {
        query: Some(hop.host.clone()),
        ..HostFilter::default()
    };
    store.hosts().list(&filter).ok()?.into_iter().find(|h| {
        h.hostname == hop.host
            && hop.user.as_ref().is_none_or(|u| &h.username == u)
            && hop.port.is_none_or(|p| h.port == p)
    })
}

#[cfg(test)]
mod tests {
    use super::resolve_jumps;
    use tern_core_ssh::AuthMethod;
    use tern_core_store::{NewHost, Store};

    fn store_with_bastion() -> Store {
        let store = Store::open_in_memory().expect("store");
        let mut draft = NewHost::manual("bastion", "bastion.example.com");
        draft.username = "jump".into();
        draft.port = 2222;
        store.hosts().create(&draft).expect("create");
        store
    }

    #[test]
    fn an_unmatched_hop_falls_back_to_the_agent_and_the_default_user() {
        let store = Store::open_in_memory().expect("store");
        let hops = resolve_jumps(&store, "bastion.example.com", "deploy");
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].host, "bastion.example.com");
        assert_eq!(hops[0].port, 22);
        assert_eq!(hops[0].username, "deploy");
        assert!(matches!(hops[0].auth.as_slice(), [AuthMethod::Agent]));
    }

    #[test]
    fn a_matched_hop_takes_its_user_and_port_from_the_saved_host() {
        let hops = resolve_jumps(&store_with_bastion(), "bastion.example.com", "deploy");
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].username, "jump");
        assert_eq!(hops[0].port, 2222);
    }

    #[test]
    fn the_spec_overrides_the_saved_user_and_port() {
        let hops = resolve_jumps(
            &store_with_bastion(),
            "root@bastion.example.com:2200",
            "deploy",
        );
        assert_eq!(hops[0].username, "root");
        assert_eq!(hops[0].port, 2200);
    }

    #[test]
    fn a_comma_list_yields_a_hop_per_element_in_order() {
        let store = Store::open_in_memory().expect("store");
        let hops = resolve_jumps(&store, "a.example.com, b.example.com", "deploy");
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0].host, "a.example.com");
        assert_eq!(hops[1].host, "b.example.com");
    }
}
