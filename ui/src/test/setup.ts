import { vi } from "vitest";

// Route every import of the Tauri core API to the fake. Doing it globally
// means a test never accidentally hits real IPC.
vi.mock("@tauri-apps/api/core", async () => {
  const mock = await import("./tauri-mock");
  return { invoke: mock.invoke, Channel: mock.Channel };
});
