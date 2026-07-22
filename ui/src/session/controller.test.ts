// controller.connectLocal wiring.
//
// The backend already speaks `Target::LocalPty` end-to-end; the only new
// surface is that `connectLocal` builds that target correctly and reaches
// `open_session` without a host-key callback. That is what these assert.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenSessionReq } from "../lib/ipc";
import { invokeHandlers, resetTauriMock } from "../test/tauri-mock";

// A pooled handle is required for `establish` to proceed; only `term.cols` /
// `term.rows` are read, and `term.write` is never called in these paths.
vi.mock("../terminal/pool", () => ({
  get: () => ({ term: { cols: 80, rows: 24, write: () => {} } }),
}));

import * as controller from "./controller";

function captureOpenSession(): { req: OpenSessionReq | null } {
  const box: { req: OpenSessionReq | null } = { req: null };
  invokeHandlers.set("open_session", (args) => {
    box.req = (args as { req: OpenSessionReq }).req;
    return "s-1";
  });
  return box;
}

beforeEach(() => {
  resetTauriMock();
});

describe("connectLocal", () => {
  it("opens a local_pty session with the default shell and no explicit program", async () => {
    const captured = captureOpenSession();

    await controller.connectLocal({ tabId: "t-local-default" });

    expect(captured.req?.target).toEqual({ kind: "local_pty", program: null });
  });

  it("passes an explicit program and args through to the target", async () => {
    const captured = captureOpenSession();

    await controller.connectLocal({
      tabId: "t-local-explicit",
      program: "/bin/bash",
      args: ["-l"],
    });

    expect(captured.req?.target).toEqual({
      kind: "local_pty",
      program: "/bin/bash",
      args: ["-l"],
    });
  });
});
