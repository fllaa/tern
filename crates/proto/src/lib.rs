//! Serde types shared across the Tern IPC boundary.
//!
//! Rule: terminal byte streams NEVER appear here — raw output bytes ride the
//! binary IPC channel untouched. Everything low-frequency (session control,
//! events, bench stats) is serde JSON defined in this crate.
//!
//! This crate must never depend on `tauri`.

use serde::{Deserialize, Serialize};

/// Opaque identifier for a terminal session (SSH or local PTY).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::SessionId;

    #[test]
    fn session_id_serde_round_trip() {
        let id = SessionId("s-1".into());
        let json = serde_json::to_string(&id).expect("serialize");
        let back: SessionId = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(id, back);
    }
}
