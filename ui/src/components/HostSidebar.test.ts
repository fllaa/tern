import { describe, expect, it } from "vitest";

import type { Folder, Host } from "../lib/hosts-ipc";
import { buildTree, hostIdOf } from "./HostSidebar";

function host(id: number, name: string, folderId: number | null = null): Host {
  return {
    id,
    folderId,
    name,
    hostname: `${name}.example.com`,
    port: 22,
    username: "",
    auth: "agent",
    hasSecret: false,
    keyPath: null,
    overrides: {},
    proxyJump: null,
    source: "manual",
    color: null,
    notes: null,
    lastConnectedAt: null,
    connectCount: 0,
    tags: [],
  };
}

function folder(id: number, name: string, parentId: number | null = null): Folder {
  return { id, name, parentId, position: 0 };
}

describe("buildTree", () => {
  it("puts unfiled hosts at the root", () => {
    const tree = buildTree([host(1, "web")], []);
    expect(tree).toHaveLength(1);
    expect(tree[0].value).toBe("host:1");
  });

  it("nests hosts under their folder", () => {
    const tree = buildTree([host(1, "web", 10)], [folder(10, "prod")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].value).toBe("folder:10");
    expect(tree[0].children?.[0].value).toBe("host:1");
  });

  it("nests folders under folders", () => {
    const tree = buildTree(
      [host(1, "web", 11)],
      [folder(10, "prod"), folder(11, "eu", 10)],
    );
    const prod = tree[0];
    expect(prod.value).toBe("folder:10");
    const eu = prod.children?.[0];
    expect(eu?.value).toBe("folder:11");
    expect(eu?.children?.[0].value).toBe("host:1");
  });

  it("surfaces a host whose folder is missing rather than dropping it", () => {
    // Can happen mid-refresh, between a folder delete and the host list
    // catching up. Losing the host from the sidebar entirely would look like
    // data loss.
    const tree = buildTree([host(1, "orphan", 999)], []);
    expect(tree).toHaveLength(1);
    expect(tree[0].value).toBe("host:1");
  });

  it("surfaces a folder whose parent is missing, with its contents intact", () => {
    const tree = buildTree([host(1, "web", 11)], [folder(11, "eu", 999)]);
    expect(tree).toHaveLength(1);
    expect(tree[0].value).toBe("folder:11");
    expect(tree[0].children?.[0].value).toBe("host:1");
  });

  it("handles an empty store", () => {
    expect(buildTree([], [])).toEqual([]);
  });
});

describe("hostIdOf", () => {
  it("reads a host id", () => {
    expect(hostIdOf("host:42")).toBe(42);
  });

  it("ignores folders and junk", () => {
    // Selecting a folder must not try to open a connection.
    expect(hostIdOf("folder:42")).toBeNull();
    expect(hostIdOf(undefined)).toBeNull();
    expect(hostIdOf("host:abc")).toBeNull();
  });
});
