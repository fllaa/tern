//! Local shell tabs via `portable-pty` (`ConPTY` on Windows, `openpty` elsewhere).
//!
//! Phase 0 Spike 3 lands the real API here.
//! This crate must never depend on `tauri`.

/// Placeholder until Spike 3 lands the PTY API.
pub fn crate_name() -> &'static str {
    "tern-core-pty"
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_harness_wiring() {
        assert_eq!(super::crate_name(), "tern-core-pty");
    }
}
