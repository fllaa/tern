import { beforeEach, describe, expect, it } from "vitest";
import type { Host } from "../lib/hosts-ipc";
import { useSessions } from "../store/sessions";
import { commandById, paletteCommands } from "./registry";

function resetStore() {
  useSessions.setState({ order: [], byId: {}, activeId: null });
}

// Only the fields the host provider reads matter here.
const WEB = {
  id: 7,
  name: "web",
  hostname: "web.example.com",
  port: 22,
  username: "deploy",
} as unknown as Host;

beforeEach(resetStore);

describe("paletteCommands", () => {
  it("emits a host command per host, with a user@host subtitle", () => {
    const host = paletteCommands([WEB], []).find((c) => c.id === "host.open:7");
    expect(host?.title).toBe("web");
    expect(host?.subtitle).toBe("deploy@web.example.com");
    expect(host?.group).toBe("hosts");
  });

  it("omits the palette-toggle command — it is chord-only", () => {
    expect(paletteCommands([], []).some((c) => c.id === "palette.toggle")).toBe(false);
  });

  it("gates action commands on tab state", () => {
    expect(paletteCommands([], []).some((c) => c.id === "tab.close")).toBe(false);
    expect(paletteCommands([], []).some((c) => c.id === "tab.next")).toBe(false);

    useSessions.getState().openTab({ hostId: 1, title: "a" });
    expect(paletteCommands([], []).some((c) => c.id === "tab.close")).toBe(true);
    expect(paletteCommands([], []).some((c) => c.id === "tab.next")).toBe(false);

    useSessions.getState().openTab({ hostId: 2, title: "b" });
    expect(paletteCommands([], []).some((c) => c.id === "tab.next")).toBe(true);
  });

  it("adds a switch command per open tab", () => {
    const id = useSessions.getState().openTab({ hostId: 1, title: "alpha" });
    const { order, byId } = useSessions.getState();
    const tabs = order.map((t) => byId[t]);
    const cmd = paletteCommands([], tabs).find((c) => c.id === `tab.switch:${id}`);
    expect(cmd?.title).toBe("alpha");
  });
});

describe("commandById", () => {
  it("resolves an enabled static command", () => {
    expect(commandById("session.newLocalShell")?.id).toBe("session.newLocalShell");
  });

  it("omits a disabled command, then finds it once enabled", () => {
    expect(commandById("tab.close")).toBeUndefined();
    useSessions.getState().openTab({ hostId: 1, title: "a" });
    expect(commandById("tab.close")?.id).toBe("tab.close");
  });

  it("returns undefined for unknown and for palette-only dynamic ids", () => {
    expect(commandById("nope")).toBeUndefined();
    expect(commandById("host.open:7")).toBeUndefined();
  });
});
