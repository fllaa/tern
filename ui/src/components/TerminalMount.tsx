// Renders each tab's pane tree, layered, with only the active tab visible.
//
// Terminals are owned by `terminal/pool.ts`; this only parents each pane's host
// into its leaf and lays the leaves out with nested resizable panels. A tab
// switch is a visibility flip on the whole layer — nothing is torn down, so
// scrollback and in-flight output survive (ADR-0016), now per pane rather than
// per tab.

import { Fragment, type ReactNode, useEffect, useRef } from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import * as controller from "../session/controller";
import { collectPaneIds, type LayoutNode } from "../store/layout";
import { type Tab, useSessions } from "../store/sessions";
import * as pool from "../terminal/pool";
import { SessionOverlay } from "./SessionStatus";

export function TerminalMount({
  onReconnectPane,
}: {
  onReconnectPane: (paneId: string) => void;
}) {
  const order = useSessions((s) => s.order);
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const activeTab = activeId ? tabs[activeId] : null;

  // Ration WebGL contexts to the visible (active-tab) panes, focused first, and
  // move keyboard focus to the active pane once the tree settles.
  useEffect(() => {
    if (!activeTab) {
      pool.reconcileRenderers([]);
      return;
    }
    const ids = collectPaneIds(activeTab.root);
    const focusFirst = [
      activeTab.activePaneId,
      ...ids.filter((id) => id !== activeTab.activePaneId),
    ];
    pool.reconcileRenderers(focusFirst);
    pool.get(activeTab.activePaneId)?.term.focus();
  }, [activeTab]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {order.map((tabId) => {
        const tab = tabs[tabId];
        if (!tab) return null;
        // All tabs stay mounted; only the active layer is visible. visibility
        // (not display:none) keeps background trees laid out so FitAddon still
        // measures every pane correctly.
        return (
          <div
            key={tabId}
            className="absolute inset-0"
            style={{ visibility: tabId === activeId ? "visible" : "hidden" }}
          >
            {renderNode(
              tab.root,
              tab,
              collectPaneIds(tab.root).length > 1,
              onReconnectPane,
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderNode(
  node: LayoutNode,
  tab: Tab,
  split: boolean,
  onReconnectPane: (paneId: string) => void,
): ReactNode {
  if (node.type === "leaf") {
    return (
      <PaneLeafView
        key={node.paneId}
        paneId={node.paneId}
        tabId={tab.id}
        ringed={split && tab.activePaneId === node.paneId}
        onReconnect={() => onReconnectPane(node.paneId)}
      />
    );
  }
  const layout = Object.fromEntries(
    node.children.map((child, i) => [panelId(child), node.sizes[i]]),
  );
  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
      defaultLayout={layout}
      onLayoutChanged={(next, meta) => {
        // Only a real drag persists; the library relayouts (mount, resize) do not.
        if (!meta.isUserInteraction) return;
        useSessions.getState().setSplitSizes(
          tab.id,
          node.id,
          node.children.map((child) => next[panelId(child)] ?? 0),
        );
      }}
    >
      {node.children.map((child, i) => (
        <Fragment key={panelId(child)}>
          {i > 0 && <ResizableHandle withHandle />}
          <ResizablePanel id={panelId(child)} minSize={72}>
            {renderNode(child, tab, split, onReconnectPane)}
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

/** A leaf's panel/group id: the pane id for a leaf, the node id for a split. */
function panelId(node: LayoutNode): string {
  return node.type === "leaf" ? node.paneId : node.id;
}

function PaneLeafView({
  paneId,
  tabId,
  ringed,
  onReconnect,
}: {
  paneId: string;
  tabId: string;
  ringed: boolean;
  onReconnect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pane = useSessions((s) => s.panes[paneId]);

  // Parent the pooled host into this leaf and open it (once per leaf mount).
  useEffect(() => {
    const container = ref.current;
    const handle = pool.get(paneId);
    if (!container || !handle) return;
    if (handle.host.parentElement !== container) {
      container.appendChild(handle.host);
      pool.ensureOpen(handle);
      pool.safeFit(handle);
    }
  }, [paneId]);

  // Re-fit on this leaf's own resize — split-divider drags, sidebar resize and
  // window resize all change a leaf's box, and each fires here.
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const handle = pool.get(paneId);
      if (handle && pool.safeFit(handle)) {
        controller.resize(paneId, handle.term.cols, handle.term.rows);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [paneId]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* The pooled host is appended here. Mousedown (capture) claims focus for
          this pane before xterm processes the click. */}
      <div
        ref={ref}
        className="absolute inset-0"
        onMouseDownCapture={() => useSessions.getState().setActivePane(tabId, paneId)}
      />
      {ringed && (
        <div className="pointer-events-none absolute inset-0 z-10 ring-1 ring-inset ring-[var(--lilt-focus)]" />
      )}
      {pane && <SessionOverlay pane={pane} onReconnect={onReconnect} />}
    </div>
  );
}
