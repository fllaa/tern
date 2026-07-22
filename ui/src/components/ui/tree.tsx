"use client";

import type {
  ComponentProps,
  CSSProperties,
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckIcon, ChevronIcon, MinusIcon } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import type {
  TreeCheckState,
  TreeChildrenMap,
  TreeMoveDetail,
  TreeMovePosition,
  TreeNode,
  TreeParentMap,
} from "@/lib/tree";
// Vendored fix: the shadcn CLI rewrote these to "@/components/ui/tree" — this
// file — so it was importing its own types from itself. The helpers live in
// the registry's lib entry, which landed correctly at @/lib/tree.
import { cascadeSelection, getCheckState, ROOT_VALUE } from "@/lib/tree";
import { cn } from "@/lib/utils";

/** How long a typeahead buffer survives between keystrokes. */
const TYPEAHEAD_RESET_MS = 500;

/** Edge band of a row that reorders rather than reparents, in pixels. */
const REORDER_BAND_MAX = 8;
const REORDER_BAND_MIN = 4;

const ITEM_SELECTOR = '[role="treeitem"]';

/** Keys that act on the focused row rather than moving between rows. */
const ACTION_KEYS = new Set(["*", " ", "Enter", "F2"]);

interface TreeStructure {
  childrenOf: TreeChildrenMap;
  parentOf: TreeParentMap;
}

interface TreeDropTarget {
  position: TreeMovePosition;
  value: string;
}

interface TreeContextValue {
  activeValue: string | undefined;
  announce: (message: string) => void;
  checkboxSelection: boolean;
  draggingValue: string | undefined;
  dropTarget: TreeDropTarget | undefined;
  editingValue: string | undefined;
  expanded: readonly string[];
  guides: boolean;
  loadingValues: ReadonlySet<string>;
  multiSelect: boolean;
  onDropItem: (target: string, position: TreeMovePosition) => void;
  onRenameCommit: (value: string, label?: string) => void;
  register: (value: string, parent: string) => () => void;
  renamable: boolean;
  reorderable: boolean;
  rootRef: RefObject<HTMLUListElement | null>;
  selectedSet: ReadonlySet<string>;
  setActiveValue: (value: string | undefined) => void;
  setDraggingValue: (value: string | undefined) => void;
  setDropTarget: (target: TreeDropTarget | undefined) => void;
  setEditingValue: (value: string | undefined) => void;
  structure: TreeStructure;
  toggleExpanded: (value: string, next?: boolean) => void;
  toggleSelected: (value: string, event?: MouseEvent | KeyboardEvent) => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

export const useTree = () => {
  const context = useContext(TreeContext);
  if (!context) {
    throw new Error("Tree parts must be used within a Tree");
  }
  return context;
};

interface TreeItemContextValue {
  checkState: TreeCheckState | undefined;
  isBranch: boolean;
  isSelected: boolean;
  level: number;
  value: string;
}

const TreeItemContext = createContext<TreeItemContextValue | null>(null);

const useTreeItem = () => {
  const context = useContext(TreeItemContext);
  if (!context) {
    throw new Error("Tree item parts must be used within a TreeItem");
  }
  return context;
};

/** Every treeitem the user can currently reach, in document order. */
const getVisibleItems = (root: HTMLUListElement | null): HTMLElement[] => {
  if (!root) {
    return [];
  }
  return [...root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
    (element) => element.closest("[hidden]") === null,
  );
};

const getValueOf = (element: HTMLElement) => element.dataset.value ?? "";

const getLevelOf = (element: HTMLElement) =>
  Number(element.getAttribute("aria-level") ?? "1");

const isBranchElement = (element: HTMLElement) => element.hasAttribute("aria-expanded");

const isOpenElement = (element: HTMLElement) =>
  element.getAttribute("aria-expanded") === "true";

const getParentItem = (element: HTMLElement) =>
  element.parentElement?.closest<HTMLElement>(ITEM_SELECTOR) ?? undefined;

const getSiblingItems = (element: HTMLElement): HTMLElement[] =>
  [...(element.parentElement?.children ?? [])].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.getAttribute("role") === "treeitem",
  );

const findItem = (root: HTMLUListElement | null, value: string) =>
  root?.querySelector<HTMLElement>(
    `${ITEM_SELECTOR}[data-value="${CSS.escape(value)}"]`,
  ) ?? undefined;

const focusItem = (element: HTMLElement) => {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
};

/** Announcements name the row the way the user sees it, not by its value. */
const labelOf = (root: HTMLUListElement | null, value: string) =>
  findItem(root, value)?.dataset.label ?? value;

/**
 * Top and bottom bands reorder, the middle reparents. The band is capped in
 * pixels rather than left as a pure fraction so a tall custom row still gets a
 * predictable hit target.
 */
const resolveDropPosition = (
  clientY: number,
  box: DOMRect,
  canDropInside: boolean,
): TreeMovePosition => {
  const offset = clientY - box.top;
  const band = Math.max(REORDER_BAND_MIN, Math.min(box.height * 0.25, REORDER_BAND_MAX));
  if (offset < band) {
    return "before";
  }
  if (offset > box.height - band) {
    return "after";
  }
  if (canDropInside) {
    return "inside";
  }
  return offset < box.height / 2 ? "before" : "after";
};

export interface TreeProps
  extends Omit<ComponentProps<"ul">, "defaultValue" | "onChange"> {
  /**
   * Renders a tri-state checkbox on every row, bound to the selection state.
   * Checking a branch cascades to its descendants and rolls up to its parents.
   * Implies `multiSelect`.
   */
  checkboxSelection?: boolean;
  defaultExpanded?: string[];
  defaultSelected?: string[];
  expanded?: string[];
  /** Draws a hairline down each level of nesting. */
  guides?: boolean;
  /** Space added per level of depth. Any CSS length. */
  indent?: string;
  /** Allows Ctrl/Cmd-click to toggle and Shift-click to select a range. */
  multiSelect?: boolean;
  onExpandedChange?: (expanded: string[]) => void;
  /**
   * Called the first time a branch with no rendered children is expanded.
   * Return a promise and the row shows a spinner until it settles.
   */
  onLoadChildren?: (value: string) => void | Promise<void>;
  /**
   * Called after a drag-drop or an Alt+Shift+arrow move. Apply it to your data
   * with `moveNode` from `@/lib/tree`.
   */
  onMove?: (detail: TreeMoveDetail) => void;
  onRename?: (value: string, label: string) => void;
  onSelectedChange?: (selected: string[]) => void;
  /** Enables F2 and double-click label editing. */
  renamable?: boolean;
  /** Enables dragging rows — and Alt+Shift+arrows — to reorder and reparent. */
  reorderable?: boolean;
  selected?: string[];
}

/**
 * A tree view following the WAI-ARIA treeview pattern: one tab stop, arrow-key
 * navigation and type-ahead.
 *
 * Always give it an `aria-label` or `aria-labelledby` — the pattern requires a
 * named tree.
 *
 * Collapsed branches stay mounted (and `hidden`) so checkbox cascade and
 * structure lookups stay correct at any depth. That keeps the whole tree in the
 * DOM: comfortable into the low thousands of nodes, but not a substitute for
 * virtualization beyond that.
 */
export const Tree = ({
  checkboxSelection = false,
  children,
  className,
  defaultExpanded,
  defaultSelected,
  expanded: expandedProp,
  guides = false,
  indent = "1.25rem",
  multiSelect = false,
  onExpandedChange,
  onLoadChildren,
  onMove,
  onRename,
  onSelectedChange,
  renamable = false,
  reorderable = false,
  selected: selectedProp,
  style,
  ...props
}: TreeProps) => {
  const rootRef = useRef<HTMLUListElement>(null);
  const anchorRef = useRef<string | null>(null);
  const typeaheadRef = useRef({ at: 0, buffer: "" });

  const [structure, setStructure] = useState<TreeStructure>(() => ({
    childrenOf: new Map<string, string[]>(),
    parentOf: new Map<string, string>(),
  }));
  const [internalExpanded, setInternalExpanded] = useState<string[]>(
    () => defaultExpanded ?? [],
  );
  const [internalSelected, setInternalSelected] = useState<string[]>(
    () => defaultSelected ?? [],
  );
  const [activeValue, setActiveValue] = useState<string>();
  const [editingValue, setEditingValue] = useState<string>();
  const [draggingValue, setDraggingValue] = useState<string>();
  const [dropTarget, setDropTarget] = useState<TreeDropTarget>();
  const [pendingFocus, setPendingFocus] = useState<string>();
  const [loadingValues, setLoadingValues] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [announcement, setAnnouncement] = useState("");

  const allowMultiple = multiSelect || checkboxSelection;
  const expanded = expandedProp ?? internalExpanded;
  const selected = selectedProp ?? internalSelected;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const announce = useCallback((message: string) => {
    // A live region ignores an identical consecutive string, so alternate an
    // invisible suffix to make repeated rejections announce every time.
    setAnnouncement((previous) => (previous.endsWith("​") ? message : `${message}​`));
  }, []);

  const commitExpanded = useCallback(
    (next: string[]) => {
      if (expandedProp === undefined) {
        setInternalExpanded(next);
      }
      onExpandedChange?.(next);
    },
    [expandedProp, onExpandedChange],
  );

  const commitSelected = useCallback(
    (next: string[]) => {
      if (selectedProp === undefined) {
        setInternalSelected(next);
      }
      onSelectedChange?.(next);
    },
    [onSelectedChange, selectedProp],
  );

  // Every item reports its parent on mount, giving the root a full topology
  // even for branches the user has never opened — which is what makes checkbox
  // cascade correct in compound mode, where there is no data array to walk.
  const register = useCallback((value: string, parent: string) => {
    setStructure((current) => {
      const parentOf = new Map(current.parentOf).set(value, parent);
      const childrenOf = new Map(current.childrenOf);
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), value]);
      return { childrenOf, parentOf };
    });
    return () =>
      setStructure((current) => {
        const parentOf = new Map(current.parentOf);
        parentOf.delete(value);
        const childrenOf = new Map(current.childrenOf);
        childrenOf.set(
          parent,
          (childrenOf.get(parent) ?? []).filter((item) => item !== value),
        );
        return { childrenOf, parentOf };
      });
  }, []);

  // Focus is restored after the consumer has re-rendered, not synchronously: at
  // call time the old row may be about to unmount and focus would land on
  // <body>. Shared by rename commits and keyboard moves. `structure` is a
  // dependency so a moved row is retried once it remounts.
  useEffect(() => {
    if (pendingFocus === undefined) {
      return;
    }
    const element = findItem(rootRef.current, pendingFocus);
    if (element) {
      setPendingFocus(undefined);
      setActiveValue(pendingFocus);
      focusItem(element);
    }
  }, [pendingFocus, structure]);

  const loadChildren = useCallback(
    async (value: string) => {
      if (!onLoadChildren) {
        return;
      }
      const result = onLoadChildren(value);
      // A cache hit returning synchronously should not flash a spinner.
      if (typeof (result as Promise<void>)?.then !== "function") {
        return;
      }
      setLoadingValues((current) => new Set(current).add(value));
      try {
        await result;
        announce(`Loaded ${labelOf(rootRef.current, value)}.`);
      } catch {
        announce(
          `Could not load ${labelOf(rootRef.current, value)}. Collapse and expand to retry.`,
        );
      } finally {
        setLoadingValues((current) => {
          const next = new Set(current);
          next.delete(value);
          return next;
        });
      }
    },
    [announce, onLoadChildren],
  );

  const toggleExpanded = useCallback(
    (value: string, next?: boolean) => {
      const isOpen = expanded.includes(value);
      const shouldOpen = next ?? !isOpen;
      if (shouldOpen === isOpen) {
        return;
      }
      if (shouldOpen) {
        commitExpanded([...expanded, value]);
        const element = findItem(rootRef.current, value);
        if (element && !element.querySelector(ITEM_SELECTOR)) {
          void loadChildren(value);
        }
        return;
      }
      // A focused descendant loses focus to <body> once it is hidden, so hand
      // the tab stop back to the branch that is closing.
      const closing = findItem(rootRef.current, value);
      const active = rootRef.current?.querySelector<HTMLElement>(
        `${ITEM_SELECTOR}:focus`,
      );
      if (active && closing && active !== closing && closing.contains(active)) {
        setActiveValue(value);
        closing.focus({ preventScroll: true });
      }
      commitExpanded(expanded.filter((item) => item !== value));
    },
    [commitExpanded, expanded, loadChildren],
  );

  const toggleSelected = useCallback(
    (value: string, event?: MouseEvent | KeyboardEvent) => {
      const anchor = anchorRef.current;
      anchorRef.current = value;
      if (checkboxSelection) {
        const { childrenOf, parentOf } = structure;
        const isChecked = getCheckState(childrenOf, selectedSet, value) === "checked";
        commitSelected(
          cascadeSelection(childrenOf, parentOf, selected, value, !isChecked),
        );
        return;
      }
      if (!allowMultiple) {
        commitSelected([value]);
        return;
      }
      if (event?.shiftKey && anchor) {
        const values = getVisibleItems(rootRef.current).map(getValueOf);
        const from = values.indexOf(anchor);
        const to = values.indexOf(value);
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from];
          anchorRef.current = anchor;
          commitSelected(values.slice(start, end + 1));
          return;
        }
      }
      if (event?.metaKey || event?.ctrlKey) {
        commitSelected(
          selectedSet.has(value)
            ? selected.filter((item) => item !== value)
            : [...selected, value],
        );
        return;
      }
      commitSelected([value]);
    },
    [allowMultiple, checkboxSelection, commitSelected, selected, selectedSet, structure],
  );

  const move = useCallback(
    (detail: TreeMoveDetail) => {
      setPendingFocus(detail.value);
      onMove?.(detail);
      const where = detail.position === "inside" ? "into" : detail.position;
      announce(
        `Moved ${labelOf(rootRef.current, detail.value)} ${where} ${labelOf(rootRef.current, detail.targetValue)}.`,
      );
    },
    [announce, onMove],
  );

  const onDropItem = useCallback(
    (target: string, position: TreeMovePosition) => {
      if (draggingValue && draggingValue !== target) {
        move({ position, targetValue: target, value: draggingValue });
      }
      setDraggingValue(undefined);
      setDropTarget(undefined);
    },
    [draggingValue, move],
  );

  const onRenameCommit = useCallback(
    (value: string, label?: string) => {
      setEditingValue(undefined);
      setPendingFocus(value);
      const trimmed = label?.trim();
      if (trimmed) {
        onRename?.(value, trimmed);
        announce(`Renamed to ${trimmed}.`);
      } else {
        announce("Rename cancelled.");
      }
    },
    [announce, onRename],
  );

  const moveRelative = useCallback(
    (element: HTMLElement, key: string) => {
      const value = getValueOf(element);
      const siblings = getSiblingItems(element);
      const index = siblings.indexOf(element);
      if (key === "ArrowUp") {
        if (index > 0) {
          move({
            position: "before",
            targetValue: getValueOf(siblings[index - 1]),
            value,
          });
          return;
        }
        announce(`${labelOf(rootRef.current, value)} is already first.`);
        return;
      }
      if (key === "ArrowDown") {
        if (index < siblings.length - 1) {
          move({
            position: "after",
            targetValue: getValueOf(siblings[index + 1]),
            value,
          });
          return;
        }
        announce(`${labelOf(rootRef.current, value)} is already last.`);
        return;
      }
      if (key === "ArrowRight") {
        if (index > 0) {
          const parent = getValueOf(siblings[index - 1]);
          commitExpanded([...new Set([...expanded, parent])]);
          move({ position: "inside", targetValue: parent, value });
          return;
        }
        announce("Nothing to nest under.");
        return;
      }
      const parent = getParentItem(element);
      if (parent) {
        move({ position: "after", targetValue: getValueOf(parent), value });
        return;
      }
      announce(`${labelOf(rootRef.current, value)} is already at the top level.`);
    },
    [announce, commitExpanded, expanded, move],
  );

  const navigate = useCallback(
    (event: KeyboardEvent, current: HTMLElement, items: HTMLElement[]) => {
      const index = items.indexOf(current);
      const value = getValueOf(current);
      const isBranch = isBranchElement(current);
      const isOpen = isOpenElement(current);

      const focusAt = (next: number) => {
        const element = items[next];
        if (element) {
          event.preventDefault();
          setActiveValue(getValueOf(element));
          focusItem(element);
        }
      };

      if (event.key === "Home") {
        focusAt(0);
        return;
      }
      if (event.key === "End") {
        focusAt(items.length - 1);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const next = event.key === "ArrowDown" ? index + 1 : index - 1;
        if (event.shiftKey && allowMultiple && items[next]) {
          toggleSelected(getValueOf(items[next]), event);
        }
        focusAt(next);
        return;
      }
      if (event.key === "ArrowRight") {
        if (!isBranch) {
          return;
        }
        if (!isOpen) {
          event.preventDefault();
          toggleExpanded(value, true);
          return;
        }
        // An expanded but empty branch has a sibling next, not a child.
        const next = items[index + 1];
        if (next && getLevelOf(next) > getLevelOf(current)) {
          focusAt(index + 1);
        }
        return;
      }
      if (isBranch && isOpen) {
        event.preventDefault();
        toggleExpanded(value, false);
        return;
      }
      const parent = getParentItem(current);
      if (parent) {
        focusAt(items.indexOf(parent));
      }
    },
    [allowMultiple, toggleExpanded, toggleSelected],
  );

  const typeahead = useCallback(
    (event: KeyboardEvent, items: HTMLElement[], index: number) => {
      const now = Date.now();
      const state = typeaheadRef.current;
      state.buffer =
        now - state.at > TYPEAHEAD_RESET_MS
          ? event.key.toLowerCase()
          : state.buffer + event.key.toLowerCase();
      state.at = now;
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      const match = ordered.find((element) =>
        (element.dataset.label ?? "").toLowerCase().startsWith(state.buffer),
      );
      if (match) {
        event.preventDefault();
        setActiveValue(getValueOf(match));
        focusItem(match);
      }
    },
    [],
  );

  const activate = useCallback(
    (event: KeyboardEvent, current: HTMLElement, items: HTMLElement[]) => {
      const value = getValueOf(current);
      if (event.key === "Enter") {
        event.preventDefault();
        toggleSelected(value, event);
        if (isBranchElement(current)) {
          toggleExpanded(value);
        }
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        toggleSelected(value, event);
        return;
      }
      if (event.key === "*") {
        event.preventDefault();
        const branches = getSiblingItems(current).filter(isBranchElement).map(getValueOf);
        commitExpanded([...new Set([...expanded, ...branches])]);
        return;
      }
      if (event.key === "F2" && renamable) {
        event.preventDefault();
        setEditingValue(value);
        return;
      }
      if (event.key.toLowerCase() === "a" && allowMultiple) {
        event.preventDefault();
        commitSelected(items.map(getValueOf));
      }
    },
    [
      allowMultiple,
      commitExpanded,
      commitSelected,
      expanded,
      renamable,
      toggleExpanded,
      toggleSelected,
    ],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (event.nativeEvent.isComposing) {
        return;
      }
      const current = (event.target as HTMLElement).closest<HTMLElement>(ITEM_SELECTOR);
      // Only keys aimed at the row itself. Anything a consumer nests in a row —
      // the rename input, a button, a link — keeps its own keys.
      if (!current || event.target !== current) {
        return;
      }
      const items = getVisibleItems(rootRef.current);
      const modified = event.metaKey || event.ctrlKey;
      const isArrow = event.key.startsWith("Arrow");

      if (event.altKey && event.shiftKey && reorderable && isArrow) {
        event.preventDefault();
        moveRelative(current, event.key);
        return;
      }
      if (isArrow || event.key === "Home" || event.key === "End") {
        navigate(event, current, items);
        return;
      }
      if (modified || ACTION_KEYS.has(event.key)) {
        activate(event, current, items);
        return;
      }
      if (!event.altKey && event.key.length === 1) {
        typeahead(event, items, items.indexOf(current));
      }
    },
    [activate, moveRelative, navigate, reorderable, typeahead],
  );

  const contextValue = useMemo<TreeContextValue>(
    () => ({
      activeValue,
      announce,
      checkboxSelection,
      draggingValue,
      dropTarget,
      editingValue,
      expanded,
      guides,
      loadingValues,
      multiSelect: allowMultiple,
      onDropItem,
      onRenameCommit,
      register,
      renamable,
      reorderable,
      rootRef,
      selectedSet,
      setActiveValue,
      setDraggingValue,
      setDropTarget,
      setEditingValue,
      structure,
      toggleExpanded,
      toggleSelected,
    }),
    [
      activeValue,
      allowMultiple,
      announce,
      checkboxSelection,
      draggingValue,
      dropTarget,
      editingValue,
      expanded,
      guides,
      loadingValues,
      onDropItem,
      onRenameCommit,
      register,
      renamable,
      reorderable,
      selectedSet,
      structure,
      toggleExpanded,
      toggleSelected,
    ],
  );

  const handleRootFocus = (event: React.FocusEvent<HTMLUListElement>) => {
    // The root holds the tab stop until an item takes it, so the tree stays
    // reachable before we know which item should be active.
    if (event.target !== event.currentTarget) {
      return;
    }
    const items = getVisibleItems(rootRef.current);
    const first =
      items.find((element) => selectedSet.has(getValueOf(element))) ?? items[0];
    first?.focus({ preventScroll: true });
  };

  return (
    <TreeContext.Provider value={contextValue}>
      <ul
        aria-multiselectable={allowMultiple || undefined}
        className={cn(
          "m-0 flex list-none select-none flex-col p-0 text-sm text-[var(--lilt-text)]",
          className,
        )}
        onFocus={handleRootFocus}
        onKeyDown={handleKeyDown}
        ref={rootRef}
        role="tree"
        style={{ "--tree-indent": indent, ...style } as CSSProperties}
        tabIndex={activeValue === undefined ? 0 : -1}
        {...props}
      >
        {children}
      </ul>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </TreeContext.Provider>
  );
};

/**
 * The APG allows a tree to expose `aria-selected` or `aria-checked`, never
 * both: single select uses selection, multi-select uses checked.
 */
const getAriaChecked = (
  multiSelect: boolean,
  checkState: TreeCheckState | undefined,
  isSelected: boolean,
): boolean | "mixed" | undefined => {
  if (!multiSelect) {
    return;
  }
  return checkState === "indeterminate" ? "mixed" : isSelected;
};

const getTextValue = (textValue: string | undefined, children: ReactNode) => {
  if (textValue !== undefined) {
    return textValue;
  }
  return typeof children === "string" ? children : undefined;
};

export interface TreeItemProps extends Omit<ComponentProps<"li">, "value"> {
  /**
   * Forces the node to render as an expandable branch. Needed when the branch
   * has no rendered children yet — a lazily loaded folder, or an empty one.
   * Otherwise a node becomes a branch as soon as a child registers.
   */
  branch?: boolean;
  disabled?: boolean;
  /**
   * Plain text used for type-ahead. Defaults to the label when it is a string;
   * set it when the label is markup.
   */
  textValue?: string;
  /** Unique within the tree; the identity used by every callback. */
  value: string;
}

export const TreeItem = ({
  branch = false,
  children,
  className,
  disabled = false,
  textValue,
  value,
  ...props
}: TreeItemProps) => {
  const {
    activeValue,
    checkboxSelection,
    expanded,
    multiSelect,
    register,
    selectedSet,
    setActiveValue,
    structure,
  } = useTree();
  const parent = useContext(TreeItemContext);
  const level = parent ? parent.level + 1 : 1;

  const isBranch = branch || (structure.childrenOf.get(value)?.length ?? 0) > 0;
  const isOpen = isBranch && expanded.includes(value);

  const parentValue = parent?.value ?? ROOT_VALUE;
  const unregisterRef = useRef<(() => void) | null>(null);
  // Registering from the ref callback rather than an effect keeps the
  // structure map in step with what is actually mounted.
  const attachRef = useCallback(
    (element: HTMLLIElement | null) => {
      if (element) {
        unregisterRef.current = register(value, parentValue);
        return;
      }
      unregisterRef.current?.();
      unregisterRef.current = null;
    },
    [parentValue, register, value],
  );

  const checkState = checkboxSelection
    ? getCheckState(structure.childrenOf, selectedSet, value)
    : undefined;
  const isSelected = checkState ? checkState === "checked" : selectedSet.has(value);

  const contextValue = useMemo(
    () => ({ checkState, isBranch, isSelected, level, value }),
    [checkState, isBranch, isSelected, level, value],
  );

  return (
    <TreeItemContext.Provider value={contextValue}>
      <li
        aria-checked={getAriaChecked(multiSelect, checkState, isSelected)}
        aria-disabled={disabled || undefined}
        aria-expanded={isBranch ? isOpen : undefined}
        aria-level={level}
        aria-selected={multiSelect ? undefined : isSelected}
        className={cn("list-none outline-none", className)}
        data-label={getTextValue(textValue, children)}
        data-state={isOpen ? "expanded" : "collapsed"}
        data-value={value}
        onFocus={(event) => {
          // A nested control must never become the roving item.
          if (event.target === event.currentTarget) {
            setActiveValue(value);
          }
        }}
        ref={attachRef}
        role="treeitem"
        tabIndex={activeValue === value ? 0 : -1}
        {...props}
      >
        {children}
      </li>
    </TreeItemContext.Provider>
  );
};

const checkboxStateClasses: Record<TreeCheckState, string> = {
  checked:
    "border-[var(--lilt-button)] bg-[var(--lilt-button)] text-[var(--lilt-button-text)]",
  indeterminate:
    "border-[var(--lilt-button)] bg-[var(--lilt-button)] text-[var(--lilt-button-text)]",
  unchecked: "border-[var(--lilt-border-strong)] bg-[var(--lilt-field)]",
};

export interface TreeItemLabelProps extends ComponentProps<"div"> {
  /** Leading glyph, rendered between the chevron and the text. */
  icon?: ReactNode;
}

/**
 * The clickable row: chevron, optional checkbox, icon and text. Lives inside a
 * `TreeItem`, above any `TreeItemGroup`.
 */
export const TreeItemLabel = ({
  children,
  className,
  icon,
  onClick,
  onDoubleClick,
  ...props
}: TreeItemLabelProps) => {
  const {
    draggingValue,
    dropTarget,
    editingValue,
    expanded,
    loadingValues,
    onDropItem,
    onRenameCommit,
    renamable,
    reorderable,
    rootRef,
    setDraggingValue,
    setDropTarget,
    setEditingValue,
    toggleExpanded,
    toggleSelected,
  } = useTree();
  const { checkState, isBranch, isSelected, level, value } = useTreeItem();
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = expanded.includes(value);
  const isLoading = loadingValues.has(value);
  const isEditing = editingValue === value;
  const isDragging = draggingValue === value;
  const drop = dropTarget?.value === value ? dropTarget.position : undefined;
  const indentStyle = `calc(0.25rem + var(--tree-indent) * ${level - 1})`;

  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.select();
    input?.scrollIntoView({ block: "nearest" });
  }, [isEditing]);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!(reorderable && draggingValue) || draggingValue === value) {
      return;
    }
    const item = event.currentTarget.closest<HTMLElement>(ITEM_SELECTOR);
    const dragged = findItem(rootRef.current, draggingValue);
    // The li contains its own group, so containment answers "would this drop
    // put a node inside itself?" — including the drop-onto-self case.
    if (!item || dragged?.contains(item)) {
      return;
    }
    // Rows nest, so the innermost row must win and the drop must be allowed.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const position = resolveDropPosition(
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      isBranch,
    );
    if (dropTarget?.value !== value || dropTarget.position !== position) {
      setDropTarget({ position, value });
    }
  };

  return (
    <div
      className={cn(
        "group/row relative flex min-h-9 cursor-default items-center gap-1.5 rounded-[var(--radius-control-sm)] pr-2 outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]",
        isSelected
          ? "bg-[var(--lilt-primary-soft)] font-semibold text-[var(--lilt-primary-text)]"
          : "hover:bg-[var(--lilt-surface-2)]",
        isDragging && "opacity-45",
        // outline, not ring: ring is reserved for focus, and the two would
        // collide on a row that is both focused and a drop target.
        drop === "inside" &&
          "bg-[var(--lilt-primary-tint)] outline-2 -outline-offset-2 outline-[var(--lilt-primary)]",
        className,
      )}
      draggable={reorderable && !isEditing}
      onClick={(event) => {
        onClick?.(event);
        toggleSelected(value, event);
      }}
      onDoubleClick={(event) => {
        onDoubleClick?.(event);
        if (renamable) {
          setEditingValue(value);
        }
      }}
      onDragEnd={() => {
        setDraggingValue(undefined);
        setDropTarget(undefined);
      }}
      onDragLeave={(event) => {
        // Without the containment check the indicator flickers every time the
        // pointer crosses one of this row's own children.
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDropTarget(undefined);
        }
      }}
      onDragOver={handleDragOver}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        // Firefox aborts a drag that carries no payload.
        event.dataTransfer.setData("text/plain", value);
        setDraggingValue(value);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDropItem(value, drop ?? "inside");
      }}
      onMouseDown={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
      // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- the row is presentational; the enclosing role="treeitem" owns focus and every keyboard interaction, per the WAI-ARIA treeview pattern
      role="presentation"
      style={{ paddingInlineStart: indentStyle }}
      {...props}
    >
      {drop === "after" || drop === "before" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-1 left-[var(--tree-drop-inset)] h-0.5 rounded-full bg-[var(--lilt-primary)]",
            drop === "before" ? "top-0" : "bottom-0",
          )}
          style={{ "--tree-drop-inset": indentStyle } as CSSProperties}
        />
      ) : null}
      {isBranch ? (
        <button
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--lilt-text-subtle)]"
          onClick={(event) => {
            event.stopPropagation();
            toggleExpanded(value);
          }}
          // Chrome pulls focus off the row on mousedown without this.
          onMouseDown={(event) => event.preventDefault()}
          tabIndex={-1}
          type="button"
        >
          {isLoading ? (
            <Spinner label={null} size={14} />
          ) : (
            <ChevronIcon
              className={cn(
                "transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)]",
                isOpen ? "rotate-0" : "-rotate-90",
              )}
              size={16}
            />
          )}
        </button>
      ) : (
        <span aria-hidden="true" className="size-5 shrink-0" />
      )}
      {checkState ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[0.4rem] border transition-colors duration-[var(--duration-fast)]",
            checkboxStateClasses[checkState],
          )}
        >
          {checkState === "checked" ? <CheckIcon size={12} /> : null}
          {checkState === "indeterminate" ? <MinusIcon size={12} /> : null}
        </span>
      ) : null}
      {icon ? (
        <span aria-hidden="true" className="flex shrink-0 text-[var(--lilt-text-subtle)]">
          {icon}
        </span>
      ) : null}
      {isEditing ? (
        <input
          aria-label="Rename"
          className="min-w-0 flex-1 rounded-[var(--radius-control-sm)] border border-[var(--lilt-focus)] bg-[var(--lilt-field)] px-1.5 py-0.5 text-sm text-[var(--lilt-text)] outline-none"
          defaultValue={typeof children === "string" ? children : ""}
          onBlur={(event) => onRenameCommit(value, event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Keeps typeahead and arrow navigation off the edit session.
            event.stopPropagation();
            if (event.key === "Enter") {
              onRenameCommit(value, event.currentTarget.value);
            } else if (event.key === "Escape") {
              onRenameCommit(value);
            }
          }}
          ref={inputRef}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
    </div>
  );
};

export type TreeItemGroupProps = ComponentProps<"ul">;

/**
 * The nested child list. Stays mounted and `hidden` while collapsed so
 * checkbox cascade and structure lookups stay correct at any depth.
 */
export const TreeItemGroup = ({ children, className, ...props }: TreeItemGroupProps) => {
  const { expanded, guides, loadingValues } = useTree();
  const { level, value } = useTreeItem();
  const isOpen = expanded.includes(value);
  const isLoading = loadingValues.has(value);

  return (
    <ul
      className={cn(
        // [hidden] only gets display:none from the UA sheet, which the flex
        // utility would otherwise win against.
        "relative m-0 flex list-none flex-col p-0 [&[hidden]]:hidden",
        guides &&
          "before:pointer-events-none before:absolute before:inset-y-0 before:left-[var(--tree-guide)] before:w-px before:bg-[var(--lilt-border)]",
        className,
      )}
      hidden={!isOpen}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the WAI-ARIA treeview pattern puts role="group" on the nested child list; none of the suggested semantic tags (fieldset, details, ...) fit
      role="group"
      style={
        {
          "--tree-guide": `calc(0.85rem + var(--tree-indent) * ${level - 1})`,
        } as CSSProperties
      }
      {...props}
    >
      {isLoading && !children ? (
        <li
          className="flex items-center gap-2 py-1 text-[var(--lilt-text-muted)]"
          style={{
            paddingInlineStart: `calc(0.25rem + var(--tree-indent) * ${level})`,
          }}
        >
          <Spinner label="Loading" size={14} />
        </li>
      ) : (
        children
      )}
    </ul>
  );
};

export interface TreeViewProps extends Omit<TreeProps, "children"> {
  items: readonly TreeNode[];
  /** Replaces the default label rendering. */
  renderLabel?: (node: TreeNode) => ReactNode;
}

const renderNodes = (
  items: readonly TreeNode[],
  renderLabel: ((node: TreeNode) => ReactNode) | undefined,
): ReactNode =>
  items.map((node) => {
    const isBranch = Boolean(node.children || node.hasChildren);
    return (
      <TreeItem
        branch={isBranch}
        disabled={node.disabled}
        key={node.value}
        textValue={node.label}
        value={node.value}
      >
        <TreeItemLabel icon={node.icon}>
          {renderLabel ? renderLabel(node) : node.label}
        </TreeItemLabel>
        {isBranch ? (
          <TreeItemGroup>
            {node.children ? renderNodes(node.children, renderLabel) : null}
          </TreeItemGroup>
        ) : null}
      </TreeItem>
    );
  });

/** The same tree, rendered from data instead of JSX. */
export const TreeView = ({ items, renderLabel, ...props }: TreeViewProps) => (
  <Tree {...props}>{renderNodes(items, renderLabel)}</Tree>
);
