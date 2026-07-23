// Scrollback search bar (Cmd/Ctrl+Shift+F).
//
// Drives the SearchAddon on the focused pane's terminal via the pool. Match
// highlighting and the result count come from the addon; this is just the
// input, the count readout, and the next/previous controls.

import { useCallback, useEffect, useRef, useState } from "react";

import { ChevronIcon, CloseIcon } from "@/components/ui/icons";

import type { PaneId } from "../store/sessions";
import * as pool from "../terminal/pool";

const iconButton =
  "flex h-7 w-7 items-center justify-center rounded-[var(--radius-control-sm)] text-[var(--lilt-text-subtle)] outline-none hover:bg-[var(--lilt-surface)] hover:text-[var(--lilt-text)] focus-visible:ring-2 focus-visible:ring-[var(--lilt-focus)]";

export function TerminalSearch({
  paneId,
  onClose,
}: {
  paneId: PaneId;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<pool.SearchResults>({
    resultIndex: -1,
    resultCount: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on open and whenever the target pane changes under an open bar.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // The count is reported asynchronously by the addon, per terminal.
  useEffect(() => pool.onSearchResults(paneId, setResults), [paneId]);

  const run = useCallback(
    (direction: "next" | "prev") => {
      if (!query) {
        pool.searchClear(paneId);
        setResults({ resultIndex: -1, resultCount: 0 });
        return;
      }
      if (direction === "next") pool.searchNext(paneId, query);
      else pool.searchPrev(paneId, query);
    },
    [paneId, query],
  );

  // Incremental: re-search as the query changes so highlighting tracks typing.
  useEffect(() => {
    run("next");
  }, [run]);

  const close = () => {
    pool.searchClear(paneId);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const count =
    results.resultCount === 0
      ? query
        ? "no results"
        : ""
      : `${results.resultIndex + 1}/${results.resultCount}`;

  return (
    <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-[var(--radius-control)] border border-[var(--lilt-border)] bg-[var(--lilt-surface-2)] p-1 shadow-lg">
      <input
        ref={inputRef}
        // biome-ignore lint/a11y/noAutofocus: a search bar the user just opened
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search scrollback"
        aria-label="Search terminal scrollback"
        className="min-h-8 w-48 bg-transparent px-2 text-sm outline-none placeholder:text-[var(--lilt-text-subtle)]"
      />
      <span className="min-w-14 px-1 text-right font-mono text-xs text-[var(--lilt-text-subtle)]">
        {count}
      </span>
      <button
        type="button"
        className={iconButton}
        aria-label="Previous match"
        onClick={() => run("prev")}
      >
        <ChevronIcon size={16} className="rotate-180" />
      </button>
      <button
        type="button"
        className={iconButton}
        aria-label="Next match"
        onClick={() => run("next")}
      >
        <ChevronIcon size={16} />
      </button>
      <button
        type="button"
        className={iconButton}
        aria-label="Close search"
        onClick={close}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  );
}
