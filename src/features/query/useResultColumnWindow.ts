import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type HTMLAttributes, type RefObject } from 'react';

export const VIRTUAL_COLUMN_THRESHOLD = 24;
export const COLUMN_OVERSCAN = 2;
const UNMEASURED_COLUMN_COUNT = 8;

export interface ResultColumnLayout {
  id: string;
  size: number;
  headerFocusable: boolean;
  bodyFocusable: boolean;
}

interface Options {
  viewport: RefObject<HTMLDivElement | null>;
  columns: readonly ResultColumnLayout[];
  active: boolean;
  initialOffset: number;
  dragColumns: readonly string[];
}

export type ResultColumnSlot =
  | { kind: 'column'; key: string; index: number; size: number }
  | { kind: 'spacer'; key: string; size: number };

function columnElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('th[data-column-id], td[data-column-id]') ?? null;
}

/** Virtual owns the range; Table owns the widths. Spacers also allow isolated retained columns. */
export function useResultColumnWindow({ viewport, columns, active, initialOffset, dragColumns }: Options) {
  const [focus, setFocus] = useState<{ id: string | null; within: boolean; header: boolean }>({
    id: null, within: false, header: false,
  });
  const [pressedColumn, setPressedColumn] = useState<string | null>(null);
  const [selectionColumns, setSelectionColumns] = useState<readonly string[]>([]);
  const windowed = columns.length > VIRTUAL_COLUMN_THRESHOLD;
  const totalSize = useMemo(() => columns.reduce((sum, column) => sum + column.size, 0), [columns]);

  const captureSelection = useCallback(() => {
    const element = viewport.current;
    const selection = element?.ownerDocument.getSelection();
    const start = selection?.rangeCount === 1 && !selection.isCollapsed ? columnElement(selection.anchorNode) : null;
    const end = selection?.rangeCount === 1 && !selection.isCollapsed ? columnElement(selection.focusNode) : null;
    const next = start && end && element?.contains(start) && element.contains(end)
      ? [start.dataset.columnId!, end.dataset.columnId!] : [];
    setSelectionColumns((previous) => previous.length === next.length && previous.every((id, index) => id === next[index])
      ? previous : next);
  }, [viewport]);

  useEffect(() => {
    const element = viewport.current;
    if (!active || !element) {
      setFocus({ id: null, within: false, header: false });
      setPressedColumn(null);
      setSelectionColumns([]);
      return;
    }
    const owner = element.ownerDocument;
    const release = () => { captureSelection(); setPressedColumn(null); };
    owner.addEventListener('selectionchange', captureSelection);
    owner.addEventListener('mouseup', release);
    owner.addEventListener('pointerup', release);
    owner.addEventListener('pointercancel', release);
    owner.addEventListener('touchend', release);
    owner.addEventListener('touchcancel', release);
    owner.defaultView?.addEventListener('blur', release);
    return () => {
      owner.removeEventListener('selectionchange', captureSelection);
      owner.removeEventListener('mouseup', release);
      owner.removeEventListener('pointerup', release);
      owner.removeEventListener('pointercancel', release);
      owner.removeEventListener('touchend', release);
      owner.removeEventListener('touchcancel', release);
      owner.defaultView?.removeEventListener('blur', release);
    };
  }, [active, viewport, captureSelection]);

  const retained = useMemo(() => {
    const indexes = new Map(columns.map((column, index) => [column.id, index]));
    const keep = new Set<number>();
    const retain = (id: string | null) => {
      const index = id === null ? undefined : indexes.get(id);
      if (index !== undefined) keep.add(index);
    };
    retain(focus.id);
    retain(pressedColumn);
    selectionColumns.forEach(retain);
    for (const id of dragColumns) {
      const index = indexes.get(id);
      if (index === undefined) continue;
      for (let next = Math.max(0, index - 1); next <= Math.min(columns.length - 1, index + 1); next += 1) keep.add(next);
    }
    if (focus.within) {
      const headers: number[] = [];
      const body: number[] = [];
      columns.forEach((column, index) => {
        if (column.headerFocusable) headers.push(index);
        if (column.bodyFocusable) body.push(index);
      });
      // Native Tab order must include the next/previous logical control, even across a gap or row.
      for (const list of [headers, body]) {
        if (list.length) { keep.add(list[0]!); keep.add(list[list.length - 1]!); }
      }
      const controls = focus.header ? headers : body;
      const position = controls.indexOf(indexes.get(focus.id ?? '') ?? -1);
      if (position >= 0) {
        if (position > 0) keep.add(controls[position - 1]!);
        if (position + 1 < controls.length) keep.add(controls[position + 1]!);
      }
    }
    return [...keep];
  }, [columns, focus, pressedColumn, selectionColumns, dragColumns]);

  const rangeExtractor = useCallback((range: Range) => [...new Set([...defaultRangeExtractor(range), ...retained])]
    .sort((left, right) => left - right), [retained]);
  // Changing this lookup with the authoritative layout invalidates Virtual's size estimates.
  // The keys themselves stay column IDs, so resizing/reordering never reuses another field's node.
  const getItemKey = useCallback((index: number) => columns[index]!.id, [columns]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableCellElement>({
    horizontal: true,
    enabled: windowed,
    count: columns.length,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => columns[index]!.size,
    getItemKey,
    // New fields can enable Virtual after the user has already scrolled the narrow table.
    initialOffset: () => viewport.current?.scrollLeft ?? initialOffset,
    overscan: COLUMN_OVERSCAN,
    rangeExtractor,
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || element.clientWidth <= 0) return;
    const maximum = Math.max(0, totalSize - element.clientWidth);
    if (element.scrollLeft > maximum) {
      element.scrollLeft = maximum;
      if (windowed) virtualizer.scrollToOffset(maximum);
    }
  }, [totalSize, viewport, virtualizer, windowed]);

  const virtualIndexes = virtualizer.getVirtualIndexes();
  const rendered = new Set(windowed
    ? virtualIndexes.length ? virtualIndexes : rangeExtractor({
      startIndex: 0, endIndex: Math.min(columns.length, UNMEASURED_COLUMN_COUNT) - 1, count: columns.length, overscan: 0,
    })
    : columns.map((_, index) => index));
  const slots: ResultColumnSlot[] = [];
  let gap = 0;
  columns.forEach((column, index) => {
    if (!rendered.has(index)) { gap += column.size; return; }
    if (gap > 0) {
      slots.push({ kind: 'spacer', key: `gap-before:${column.id}`, size: gap });
      gap = 0;
    }
    slots.push({ kind: 'column', key: column.id, index, size: column.size });
  });
  if (gap > 0) slots.push({ kind: 'spacer', key: 'gap-end', size: gap });

  const retainPressed = (target: EventTarget | null) => {
    const cell = target instanceof Node ? columnElement(target) : null;
    setPressedColumn(cell?.dataset.columnId ?? null);
  };
  const viewportProps: HTMLAttributes<HTMLDivElement> = !active ? {} : {
    onFocusCapture: (event) => {
      const cell = columnElement(event.target);
      setFocus((previous) => ({
        id: cell?.dataset.columnId ?? previous.id, within: true, header: cell?.tagName === 'TH',
      }));
    },
    onBlurCapture: (event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        setFocus((previous) => ({ ...previous, within: false }));
      }
    },
    onMouseDownCapture: (event) => retainPressed(event.target),
    onTouchStartCapture: (event) => retainPressed(event.target),
    onScrollCapture: captureSelection,
  };
  return { slots, totalSize, windowed, viewportProps };
}
