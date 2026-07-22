// Fake @tauri-apps/api/core, so tests can drive the IPC boundary directly.
//
// The Channel fake is what makes the flow-control test possible: real frames
// arrive from Rust, and there is no other way to inject them.

import { vi } from "vitest";

/** Every invoke() call made since the last reset, in order. */
export const invokeCalls: Array<{ cmd: string; args: unknown }> = [];

/** Per-command handlers. Unhandled commands resolve to undefined. */
export const invokeHandlers = new Map<string, (args: unknown) => unknown>();

export const invoke = vi.fn(async (cmd: string, args?: unknown) => {
  invokeCalls.push({ cmd, args });
  const handler = invokeHandlers.get(cmd);
  return handler ? handler(args) : undefined;
});

/** Stand-in for tauri's Channel: tests push messages in via `emit`. */
export class Channel<T> {
  onmessage: ((msg: T) => void) | null = null;
  emit(msg: T): void {
    this.onmessage?.(msg);
  }
}

export function resetTauriMock(): void {
  invokeCalls.length = 0;
  invokeHandlers.clear();
  invoke.mockClear();
}

/** Count invocations of a given command. */
export function callsTo(cmd: string): number {
  return invokeCalls.filter((c) => c.cmd === cmd).length;
}
