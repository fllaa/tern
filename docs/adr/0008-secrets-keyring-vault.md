# ADR-0008: Secrets — OS keyring + argon2id/XChaCha20-Poly1305 vault, zeroize

- Status: Accepted
- Date: 2026-07-20

## Context

An SSH client lives or dies on trust: no plaintext secrets on disk, ever. Two
storage modes are needed — OS-native convenience and a portable encrypted vault
(which Phase 5's file-based sync rides on).

## Decision

We use the **keyring** crate (v4; default `v1` feature = macOS Keychain,
Windows Credential Manager, Secret Service via zbus) for OS-native storage of
passphrases/unlock keys, and an encrypted vault — **argon2id** KDF +
**XChaCha20-Poly1305** AEAD — for hosts/snippets/key references, with
**zeroize** on all secret buffers. The Phase 0 spike proves the keyring
round-trip on all three OSes; the vault format lands in Phase 5 with
golden-file tests.

## Consequences

- Good: secrets never touch disk unencrypted; the vault is sync-friendly and
  OS-independent; keyring v4's store split lets us swap Linux backends if needed.
- Bad / accepted cost: headless Linux (no Secret Service) needs the
  master-password vault path; keyring v4 is a young restructure of a mature
  crate (fallback pin: v3.6 with the old feature names).
- Revisit when: Linux backend fragmentation (keyutils vs Secret Service) bites
  real users, or the v4 line proves unstable.
