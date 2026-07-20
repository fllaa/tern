// Renders every open tab's terminal, stacked, with only the active one visible.
//
// Each terminal's host element is created and owned by `terminal/pool.ts`; this
// component only parents them and toggles which is visible. That is what lets
// a tab switch be a visibility change rather than a teardown — scrollback,
// cursor position and in-flight output all survive because nothing is
// destroyed.

import { useEffect, useRef } from "react";

import * as controller from "../session/controller";
import { useSessions } from "../store/sessions";
import * as pool from "../terminal/pool";

export function TerminalMount() {
  const order = useSessions((s) => s.order);
  const activeId = useSessions((s) => s.activeId);
  const stack = useRef<HTMLDivElement>(null);

  // Parent any terminal that is not yet in the stack.
  useEffect(() => {
    const container = stack.current;
    if (!container) return;
    for (const id of order) {
      const handle = pool.get(id);
      if (!handle) continue;
      if (handle.host.parentElement !== container) {
        container.appendChild(handle.host);
        pool.ensureOpen(handle);
      }
    }
  }, [order]);

  // Show exactly one, and give it the WebGL context.
  useEffect(() => {
    for (const id of order) {
      const handle = pool.get(id);
      if (!handle) continue;
      if (id === activeId) {
        pool.activate(handle);
      } else {
        pool.deactivate(handle);
      }
    }
  }, [order, activeId]);

  // Re-fit on container resize. ResizeObserver rather than a window listener,
  // because the sidebar is resizable and the window never changes size for it.
  useEffect(() => {
    const container = stack.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const id = useSessions.getState().activeId;
      if (!id) return;
      const handle = pool.get(id);
      if (!handle) return;
      if (pool.safeFit(handle)) {
        controller.resize(id, handle.term.cols, handle.term.rows);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return <div className="relative h-full w-full" ref={stack} />;
}
