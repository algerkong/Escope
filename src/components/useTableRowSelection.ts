import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent } from 'react';
import '../styles/table-selection.css';

export type TableRowSelection = Record<string, true>;
const EMPTY_SELECTION: TableRowSelection = {};
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="separator"], [contenteditable]:not([contenteditable="false"])';

interface Options {
  /** Filtered/sorted IDs before local pagination, never mutable display positions. */
  rowIds: readonly string[];
  visibleRowIds?: readonly string[];
  scope: unknown;
  active?: boolean;
  selection?: { value: TableRowSelection; onChange: (value: TableRowSelection) => void };
}

function rangeSelection(ids: readonly string[], anchor: string, end: string, base: TableRowSelection, selected: boolean): TableRowSelection {
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(end);
  const range = from < 0 || to < 0 ? [end] : ids.slice(Math.min(from, to), Math.max(from, to) + 1);
  if (selected) return { ...base, ...Object.fromEntries(range.map((id) => [id, true])) };
  const removed = new Set(range);
  return Object.fromEntries(Object.entries(base).filter(([id]) => !removed.has(id)));
}

function scrollContainer(body: HTMLElement): HTMLElement | null {
  for (let node = body.parentElement; node !== null; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** Shared row gestures for native tables and the controlled TanStack result grid. */
export function useTableRowSelection({ rowIds, visibleRowIds = rowIds, scope, active = true, selection }: Options) {
  const body = useRef<HTMLTableSectionElement>(null);
  const [local, setLocal] = useState<{ scope: unknown; value: TableRowSelection }>({ scope, value: EMPTY_SELECTION });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const finishDrag = useRef<(() => void) | null>(null);
  const pointerClick = useRef(false);
  const dragged = useRef(false);
  const value = selection?.value ?? (local.scope === scope ? local.value : EMPTY_SELECTION);
  const change = (next: TableRowSelection) => {
    latest.current.value = next;
    if (selection) selection.onChange(next);
    else setLocal({ scope, value: next });
  };
  const latest = useRef({ rowIds, visibleRowIds, value, change, active });
  latest.current = { rowIds, visibleRowIds, value, change, active };
  const previousScope = useRef(scope);

  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      anchor.current = null;
      setFocusedId(null);
      setLocal({ scope, value: EMPTY_SELECTION });
    }
    if (!active) finishDrag.current?.();
    return () => { finishDrag.current?.(); };
  }, [scope, active]);

  const rowFrom = (target: EventTarget | null): HTMLTableRowElement | null => {
    const row = target instanceof Element ? target.closest<HTMLTableRowElement>('tr[data-selection-id]') : null;
    return row?.parentElement === body.current ? row : null;
  };
  const interactive = (target: EventTarget | null) => target instanceof Element && target.closest(INTERACTIVE) !== null;
  const select = (id: string, modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const current = latest.current;
    const additive = modifiers.ctrlKey || modifiers.metaKey;
    const start = modifiers.shiftKey && anchor.current !== null ? anchor.current : id;
    const selected = modifiers.shiftKey || !additive || current.value[id] !== true;
    const base = additive ? current.value : EMPTY_SELECTION;
    current.change(rangeSelection(current.rowIds, start, id, base, selected));
    if (!modifiers.shiftKey || anchor.current === null) anchor.current = id;
    setFocusedId(id);
    return { start, base, selected };
  };

  const onMouseDown = (event: ReactMouseEvent<HTMLTableSectionElement>) => {
    finishDrag.current?.();
    pointerClick.current = false;
    dragged.current = false;
    if (!latest.current.active || event.button !== 0 || interactive(event.target) || event.altKey) return;
    const row = rowFrom(event.target);
    const id = row?.dataset.selectionId;
    if (!row || id === undefined) return;
    pointerClick.current = true;
    const range = select(id, event);
    row.focus({ preventScroll: true });
    // Ordinary same-row drags keep native text selection. Only row ranges suppress it.
    if (event.shiftKey || event.ctrlKey || event.metaKey) event.preventDefault();
    const owner = row.ownerDocument;
    const view = owner.defaultView!;
    const container = scrollContainer(row);
    let last = id;
    let x = event.clientX;
    let y = event.clientY;
    let frame = 0;
    let stopped = false;

    const extend = (target: EventTarget | null) => {
      const next = rowFrom(target)?.dataset.selectionId;
      if (next === undefined || next === last) return;
      last = next;
      dragged.current = true;
      body.current?.setAttribute('data-row-dragging', 'true');
      owner.getSelection()?.removeAllRanges();
      latest.current.change(rangeSelection(latest.current.rowIds, range.start, next, range.base, range.selected));
      setFocusedId(next);
    };
    const autoScroll = () => {
      frame = 0;
      if (stopped || !container) return;
      const rect = container.getBoundingClientRect();
      if (x < rect.left || x > rect.right) return;
      const step = y < rect.top + 28 ? -12 : y > rect.bottom - 28 ? 12 : 0;
      if (step === 0) return;
      const before = container.scrollTop;
      container.scrollTop += step;
      if (container.scrollTop === before) return;
      const rows = [...(body.current?.rows ?? [])];
      const candidates = rows.filter((item) => {
        const bounds = item.getBoundingClientRect();
        return bounds.bottom > rect.top && bounds.top < rect.bottom;
      });
      extend(step < 0 ? candidates[0] ?? null : candidates.at(-1) ?? null);
      frame = view.requestAnimationFrame(autoScroll);
    };
    const move = (moving: MouseEvent) => {
      if ((moving.buttons & 1) === 0) { finish(); return; }
      x = moving.clientX;
      y = moving.clientY;
      extend(moving.target);
      if (dragged.current) moving.preventDefault();
      if (frame === 0) frame = view.requestAnimationFrame(autoScroll);
    };
    const finish = () => {
      if (stopped) return;
      stopped = true;
      view.cancelAnimationFrame(frame);
      owner.removeEventListener('mousemove', move);
      owner.removeEventListener('mouseup', finish);
      view.removeEventListener('blur', finish);
      body.current?.removeAttribute('data-row-dragging');
      finishDrag.current = null;
    };
    finishDrag.current = finish;
    owner.addEventListener('mousemove', move, { passive: false });
    owner.addEventListener('mouseup', finish);
    view.addEventListener('blur', finish);
  };

  const clear = useCallback(() => {
    finishDrag.current?.();
    latest.current.change(EMPTY_SELECTION);
    anchor.current = null;
  }, []);
  const selectedCount = useMemo(() => Object.values(value).filter(Boolean).length, [value]);
  const focusTarget = visibleRowIds.includes(focusedId ?? '') ? focusedId
    : visibleRowIds.find((id) => value[id] === true) ?? visibleRowIds[0];
  const bodyProps: HTMLAttributes<HTMLTableSectionElement> = {
    className: 'table-selection-body',
    onMouseDown,
    onClickCapture: (event) => {
      if (dragged.current && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
        dragged.current = false;
        pointerClick.current = false;
      }
    },
    onClick: (event) => {
      const handled = pointerClick.current && event.detail !== 0;
      pointerClick.current = false;
      if (handled || !active || interactive(event.target) || event.altKey) return;
      const id = rowFrom(event.target)?.dataset.selectionId;
      if (id !== undefined) select(id, event);
    },
    onKeyDown: (event) => {
      if (!active || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || interactive(event.target)) return;
      const id = rowFrom(event.target)?.dataset.selectionId;
      if (id === undefined) return;
      const current = latest.current;
      const modifier = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        if (Object.keys(current.value).length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        current.change(Object.fromEntries(current.rowIds.map((rowId) => [rowId, true])));
        return;
      }
      if (event.key === ' ' || (event.key === 'Enter' && !modifier)) {
        event.preventDefault();
        select(id, { ctrlKey: !event.shiftKey, metaKey: false, shiftKey: event.shiftKey });
        return;
      }
      const position = current.visibleRowIds.indexOf(id);
      const next = event.key === 'ArrowDown' ? position + 1 : event.key === 'ArrowUp' ? position - 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? current.visibleRowIds.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      const nextId = current.visibleRowIds[Math.min(Math.max(next, 0), current.visibleRowIds.length - 1)];
      if (nextId === undefined) return;
      if (event.shiftKey && anchor.current === null) anchor.current = id;
      if (!modifier || event.shiftKey) select(nextId, event);
      else setFocusedId(nextId);
      const target = [...(body.current?.rows ?? [])].find((item) => item.dataset.selectionId === nextId);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
  };

  return {
    bodyRef: body, bodyProps, value, selectedCount, clear,
    rowProps: (id: string) => ({
      'data-selection-id': id,
      'aria-selected': value[id] === true,
      tabIndex: active && id === focusTarget ? 0 : -1,
    }),
  };
}
