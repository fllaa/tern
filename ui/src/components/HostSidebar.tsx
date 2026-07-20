// Host sidebar: search, folder tree, hosts.
//
// Built from Tree + ScrollArea + Input rather than Lilt's Sidebar component,
// which registers a global (meta|ctrl)+B keydown listener. Ctrl+B is the tmux
// prefix key — in an SSH client that listener would swallow the most-pressed
// chord of the target audience on every keystroke.

import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TreeView } from "@/components/ui/tree";
import type { TreeNode } from "@/lib/tree";

import type { Folder, Host } from "../lib/hosts-ipc";

/**
 * Build the tree from flat host and folder lists.
 *
 * Pure and exported so the shaping is unit-testable without rendering: folders
 * nest by `parentId`, hosts hang off their folder, and anything whose parent is
 * missing surfaces at the root rather than vanishing.
 */
export function buildTree(hosts: Host[], folders: Folder[]): TreeNode[] {
  const folderNodes = new Map<number, TreeNode & { children: TreeNode[] }>();
  for (const f of folders) {
    folderNodes.set(f.id, {
      value: `folder:${f.id}`,
      label: f.name,
      children: [],
    });
  }

  const roots: TreeNode[] = [];
  for (const f of folders) {
    const node = folderNodes.get(f.id);
    if (!node) continue;
    const parent = f.parentId === null ? undefined : folderNodes.get(f.parentId);
    // An orphaned folder (parent deleted mid-refresh) surfaces at the root
    // rather than disappearing along with everything inside it.
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const h of hosts) {
    const node: TreeNode = {
      value: `host:${h.id}`,
      label: h.name,
    };
    const parent = h.folderId === null ? undefined : folderNodes.get(h.folderId);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** `host:12` -> 12. Anything else (a folder, a malformed value) -> null. */
export function hostIdOf(value: string | undefined): number | null {
  if (!value?.startsWith("host:")) return null;
  const id = Number(value.slice("host:".length));
  return Number.isFinite(id) ? id : null;
}

export function HostSidebar({
  hosts,
  folders,
  query,
  onQueryChange,
  onOpenHost,
  header,
  footer,
}: {
  hosts: Host[];
  folders: Folder[];
  query: string;
  onQueryChange: (q: string) => void;
  onOpenHost: (hostId: number) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const items = useMemo(() => buildTree(hosts, folders), [hosts, folders]);
  // Searching should reveal matches, not make the user expand folders to find
  // them, so every folder opens while a query is active.
  const expanded = useMemo(
    () => (query ? folders.map((f) => `folder:${f.id}`) : undefined),
    [query, folders],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--lilt-surface-2)]">
      {header}
      <div className="px-2 pb-2">
        <Input
          placeholder="Search hosts"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        {hosts.length === 0 ? (
          <p className="px-2 py-6 text-xs text-[var(--lilt-text-subtle)]">
            {query
              ? "No hosts match."
              : "No hosts yet. Add one, or import your ssh_config."}
          </p>
        ) : (
          <TreeView
            aria-label="Hosts"
            items={items}
            guides
            expanded={expanded}
            onSelectedChange={(selected) => {
              const id = hostIdOf(selected[0]);
              if (id !== null) onOpenHost(id);
            }}
          />
        )}
      </ScrollArea>

      {footer}
    </div>
  );
}
