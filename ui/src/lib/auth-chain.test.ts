import { describe, expect, it } from "vitest";

import { credentialedKind, fallbackOptions, toChain } from "./auth-chain";

describe("fallbackOptions", () => {
  it("lets an agent primary fall back to one credentialed method", () => {
    expect(fallbackOptions("agent")).toEqual(["key_file", "password"]);
  });

  it("lets a credentialed primary fall back only to the agent", () => {
    // A second credentialed method would need a second secret the host cannot
    // hold, so it is never offered.
    expect(fallbackOptions("password")).toEqual(["agent"]);
    expect(fallbackOptions("key_file")).toEqual(["agent"]);
  });
});

describe("credentialedKind", () => {
  it("finds the single credentialed method wherever it sits in the chain", () => {
    expect(credentialedKind(["agent", "password"])).toBe("password");
    expect(credentialedKind(["key_file", "agent"])).toBe("key_file");
  });

  it("returns null for an agent-only chain", () => {
    expect(credentialedKind(["agent"])).toBeNull();
  });

  it("returns the first credentialed method if somehow given two", () => {
    // The form never produces this, but the resolver must be deterministic.
    expect(credentialedKind(["password", "key_file"])).toBe("password");
  });
});

describe("toChain", () => {
  it("drops the empty fallback slot", () => {
    expect(toChain("agent", "none")).toEqual(["agent"]);
    expect(toChain("agent", "password")).toEqual(["agent", "password"]);
  });
});
