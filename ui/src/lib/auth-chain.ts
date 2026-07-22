// Auth-chain shaping for the host form. Pure and separate from the dialog so
// the one-credential rule is unit-testable without rendering.
//
// The rule mirrors the Rust side: a host's chain carries at most one
// credential-bearing method (a password or a key passphrase), because a host
// stores a single secret. The agent needs no secret, so it composes freely.

import type { AuthKind } from "./hosts-ipc";

/** A method that needs a stored secret. */
export type CredentialedKind = "key_file" | "password";

/**
 * Which methods may follow `first` as the single fallback slot.
 *
 * A credentialed primary (password or key) can only fall back to the agent,
 * which carries no secret of its own — a second credentialed method would need
 * a second secret the host cannot hold. An agent primary, needing nothing
 * itself, may fall back to one credentialed method.
 */
export function fallbackOptions(first: AuthKind): AuthKind[] {
  return first === "agent" ? ["key_file", "password"] : ["agent"];
}

/** The one credential-bearing method in a chain, if any. */
export function credentialedKind(chain: AuthKind[]): CredentialedKind | null {
  for (const kind of chain) {
    if (kind === "key_file" || kind === "password") return kind;
  }
  return null;
}

/** The chain as an ordered list, dropping the empty fallback slot. */
export function toChain(first: AuthKind, then: AuthKind | "none"): AuthKind[] {
  return then === "none" ? [first] : [first, then];
}

/** Human label for a method, for buttons and summaries. */
export function methodLabel(kind: AuthKind): string {
  switch (kind) {
    case "agent":
      return "ssh-agent";
    case "key_file":
      return "Private key";
    case "password":
      return "Password";
  }
}
