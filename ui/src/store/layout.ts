// The per-tab pane layout tree.
//
// A tab is no longer a single terminal but a tree: leaves are panes (each bound
// to its own session), internal nodes are splits along one axis. These helpers
// are pure — like `neighbourOf` in the store — so the tree logic is testable
// without React.

import type { PaneId } from "./sessions";

export type SplitDir = "row" | "column";
export type NodeId = string;

export type LayoutNode =
  | { type: "leaf"; paneId: PaneId }
  | {
      type: "split";
      id: NodeId;
      dir: SplitDir;
      children: LayoutNode[];
      /** Percentages parallel to `children`, summing to ~100. */
      sizes: number[];
    };

let nextNodeId = 0;
/** Monotonic split-node id; also the id of its ResizablePanelGroup. */
export function newNodeId(): NodeId {
  nextNodeId += 1;
  return `n-${nextNodeId}`;
}

/** A one-leaf tree — what a fresh tab starts as. */
export function leaf(paneId: PaneId): LayoutNode {
  return { type: "leaf", paneId };
}

/** Every pane id in the tree, left to right (DFS order). */
export function collectPaneIds(node: LayoutNode): PaneId[] {
  if (node.type === "leaf") return [node.paneId];
  return node.children.flatMap(collectPaneIds);
}

/**
 * Replace `target`'s leaf with a split of [target, new] along `dir`. If the
 * target's parent split already runs `dir`, the new leaf joins it as a sibling
 * instead of nesting — keeping trees shallow (the tmux behaviour).
 */
export function splitLeaf(
  node: LayoutNode,
  target: PaneId,
  newPaneId: PaneId,
  dir: SplitDir,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.paneId !== target) return node;
    return {
      type: "split",
      id: newNodeId(),
      dir,
      children: [leaf(target), leaf(newPaneId)],
      sizes: evenSizes(2),
    };
  }
  if (node.dir === dir) {
    const idx = node.children.findIndex((c) => c.type === "leaf" && c.paneId === target);
    if (idx !== -1) {
      const children = [...node.children];
      children.splice(idx + 1, 0, leaf(newPaneId));
      return { ...node, children, sizes: evenSizes(children.length) };
    }
  }
  return {
    ...node,
    children: node.children.map((c) => splitLeaf(c, target, newPaneId, dir)),
  };
}

/**
 * Remove a leaf. A split left with a single child collapses into that child,
 * and the survivors are resized evenly. Returns null if the whole tree was the
 * removed leaf.
 */
export function removeLeaf(node: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (node.type === "leaf") return node.paneId === paneId ? null : node;
  const kept: LayoutNode[] = [];
  for (const child of node.children) {
    const next = removeLeaf(child, paneId);
    if (next) kept.push(next);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept, sizes: evenSizes(kept.length) };
}

/** Update the sizes of the split node with `nodeId`, if present. */
export function setSizes(node: LayoutNode, nodeId: NodeId, sizes: number[]): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === nodeId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => setSizes(c, nodeId, sizes)) };
}

/** The next leaf after `paneId` in DFS order, wrapping; null if it is the only leaf. */
export function neighbourPane(node: LayoutNode, paneId: PaneId): PaneId | null {
  const ids = collectPaneIds(node);
  if (ids.length <= 1) return null;
  const i = ids.indexOf(paneId);
  if (i === -1) return ids[0] ?? null;
  return ids[(i + 1) % ids.length];
}

function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}
