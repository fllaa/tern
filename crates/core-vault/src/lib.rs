//! Secret storage: OS keyring wrapper (Phase 0 Spike 4 lands here) and the
//! encrypted vault — `argon2id` KDF + `XChaCha20-Poly1305`, `zeroize` on buffers
//! (Phase 5). No plaintext secrets on disk, ever.
//!
//! This crate must never depend on `tauri`.
