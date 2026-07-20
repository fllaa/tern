//! Output coalescing (time/size-based frame batching), the pause/resume flow
//! gate, and stream statistics — shared by the SSH and local-PTY data paths.
//!
//! This is the CI-benchable heart of the terminal data path: it must be
//! exercisable without a webview. Phase 0 Spikes 1–2 land the real code here.
//! This crate must never depend on `tauri`.

/// Placeholder until the coalescer lands with Spike 1/2.
pub fn crate_name() -> &'static str {
    "tern-term-stream"
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_harness_wiring() {
        assert_eq!(super::crate_name(), "tern-term-stream");
    }
}
