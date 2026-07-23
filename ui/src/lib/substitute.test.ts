import { describe, expect, it } from "vitest";

import { hostContext, substitute, variablesIn } from "./substitute";

describe("variablesIn", () => {
  it("finds each distinct placeholder once, in first-appearance order", () => {
    expect(variablesIn("systemctl {{action}} {{unit}} && echo {{action}}")).toEqual([
      { name: "action", fallback: "" },
      { name: "unit", fallback: "" },
    ]);
  });

  it("captures a default and tolerates inner spacing", () => {
    expect(variablesIn("ssh -p {{ port : 22 }} {{host}}")).toEqual([
      { name: "port", fallback: " 22 " },
      { name: "host", fallback: "" },
    ]);
  });

  it("returns nothing for a body with no placeholders", () => {
    expect(variablesIn("uptime")).toEqual([]);
  });
});

describe("substitute", () => {
  it("replaces every occurrence of a placeholder", () => {
    expect(substitute("{{a}}-{{a}}-{{b}}", { a: "x", b: "y" })).toBe("x-x-y");
  });

  it("falls back to the written default when a key is absent", () => {
    expect(substitute("tail -n {{lines:100}} log", {})).toBe("tail -n 100 log");
  });

  it("lets a supplied empty value win over the default", () => {
    // Clearing a prompted field is a deliberate "substitute nothing"; silently
    // reinstating the default would send a command the user did not see.
    expect(substitute("run {{flag:-v}}", { flag: "" })).toBe("run ");
  });

  it("substitutes nothing for an unknown placeholder with no default", () => {
    expect(substitute("echo {{nope}}", {})).toBe("echo ");
  });

  it("leaves non-placeholder braces alone", () => {
    expect(substitute("awk '{print $1}'", {})).toBe("awk '{print $1}'");
  });
});

describe("hostContext", () => {
  it("exposes host, user and port for a connected pane", () => {
    expect(
      hostContext({ hostname: "web1.example.com", username: "deploy", port: 2222 }),
    ).toEqual({ host: "web1.example.com", user: "deploy", port: "2222" });
  });

  it("is empty for a local shell, which has no host", () => {
    expect(hostContext(null)).toEqual({});
  });
});
