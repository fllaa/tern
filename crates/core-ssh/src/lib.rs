//! russh-based SSH session management: connect, auth (password / key / agent),
//! shell channels with PTY, resize, and keepalives.
//!
//! Phase 0 Spike 1 lands the real API here.
//! This crate must never depend on `tauri`.

/// Placeholder until Spike 1 lands the session API.
pub fn crate_name() -> &'static str {
    "tern-core-ssh"
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_harness_wiring() {
        assert_eq!(super::crate_name(), "tern-core-ssh");
    }
}
