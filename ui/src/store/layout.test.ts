import { describe, expect, it } from "vitest";

import { collectPaneIds, leaf, neighbourPane, removeLeaf, splitLeaf } from "./layout";

describe("splitLeaf", () => {
  it("turns a leaf into a two-child split along the given axis", () => {
    const node = splitLeaf(leaf("p1"), "p1", "p2", "row");
    expect(node.type).toBe("split");
    if (node.type !== "split") return;
    expect(node.dir).toBe("row");
    expect(collectPaneIds(node)).toEqual(["p1", "p2"]);
    expect(node.sizes).toEqual([50, 50]);
  });

  it("inserts as a sibling when the parent split shares the axis", () => {
    let root = splitLeaf(leaf("p1"), "p1", "p2", "row"); // [p1 | p2]
    root = splitLeaf(root, "p2", "p3", "row"); // same axis -> [p1 | p2 | p3]
    expect(root.type).toBe("split");
    if (root.type !== "split") return;
    expect(root.children).toHaveLength(3);
    expect(collectPaneIds(root)).toEqual(["p1", "p2", "p3"]);
  });

  it("nests a new split when the axis differs", () => {
    let root = splitLeaf(leaf("p1"), "p1", "p2", "row"); // [p1 | p2]
    root = splitLeaf(root, "p2", "p3", "column"); // p2 becomes [p2 / p3]
    expect(collectPaneIds(root)).toEqual(["p1", "p2", "p3"]);
    if (root.type !== "split") return;
    expect(root.children[1].type).toBe("split");
  });

  it("leaves the tree unchanged for an unknown target", () => {
    const root = leaf("p1");
    expect(splitLeaf(root, "nope", "p2", "row")).toEqual(root);
  });
});

describe("removeLeaf", () => {
  it("returns null when the whole tree is the removed leaf", () => {
    expect(removeLeaf(leaf("p1"), "p1")).toBeNull();
  });

  it("collapses a split left with one surviving child into that child", () => {
    const root = splitLeaf(leaf("p1"), "p1", "p2", "row");
    expect(removeLeaf(root, "p2")).toEqual(leaf("p1"));
  });

  it("keeps siblings and re-sizes them evenly", () => {
    let root = splitLeaf(leaf("p1"), "p1", "p2", "row");
    root = splitLeaf(root, "p2", "p3", "row"); // [p1 | p2 | p3]
    const next = removeLeaf(root, "p2");
    expect(next && collectPaneIds(next)).toEqual(["p1", "p3"]);
    if (next?.type === "split") expect(next.sizes).toEqual([50, 50]);
  });
});

describe("neighbourPane", () => {
  it("returns the next leaf in DFS order, wrapping", () => {
    let root = splitLeaf(leaf("p1"), "p1", "p2", "row");
    root = splitLeaf(root, "p2", "p3", "row"); // p1, p2, p3
    expect(neighbourPane(root, "p1")).toBe("p2");
    expect(neighbourPane(root, "p3")).toBe("p1"); // wrap
  });

  it("is null for a single-leaf tree", () => {
    expect(neighbourPane(leaf("p1"), "p1")).toBeNull();
  });
});

describe("collectPaneIds", () => {
  it("lists every pane left to right across nested splits", () => {
    let root = splitLeaf(leaf("a"), "a", "b", "row");
    root = splitLeaf(root, "b", "c", "column");
    expect(collectPaneIds(root)).toEqual(["a", "b", "c"]);
  });
});
