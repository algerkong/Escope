import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  columnOrderingFeature, columnResizingFeature, columnSizingFeature, columnVisibilityFeature, constructSortFn,
  createPaginatedRowModel, createSortedRowModel, rowPaginationFeature, rowSelectionFeature, rowSortingFeature, tableFeatures, useTable,
  type ColumnDef, type Header,
} from '@tanstack/react-table';
import {
  ALargeSmall, ArrowLeft, ArrowRight, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, Columns3,
  FileSearch, GripVertical, ListRestart, RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import { TableSelectionStatus } from '../../components/TableSelectionStatus';
import { useTableRowSelection } from '../../components/useTableRowSelection';
import type { ResultColumn } from '../../domain/query-result';
import { formatFieldValue, type DataViewFieldFormats } from '../../domain/field-formats';
import {
  ID_COLUMN_ID, INDEX_COLUMN_ID, LOCKED_COLUMN_IDS, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, NULL_GRID_VALUE,
  RESULT_GRID_PAGE_SIZE, ROW_COLUMN_ID, ROW_COLUMN_WIDTH, WIDTH_SAMPLE_ROWS,
  activeSorting, clampColumnWidth, clampPageIndex, compareGridValues, cycleSorting,
  estimateColumnWidth, fieldColumnId, fieldNameOfColumnId, pageCountOf, reconcileColumnOrder,
  reorderColumns, restoreColumnWidth, sanitizeColumnSizing, sortValueOf,
  type GridCellValue, type ResultGridRow, type ResultGridState,
} from '../../domain/result-grid';
import '../../styles/result-grid.css';

/**
 * Read-only document grid.
 *
 * TanStack Table drives sorting, column order/sizing/visibility and the 50-row page, while dnd-kit
 * provides genuine pointer and keyboard drag handles for column order. Sorting stays local: it only
 * re-orders the documents already received, so no helper here sends a request or rewrites the query,
 * and numeric order uses the exact decimal tokens instead of `Number`.
 */

interface Props {
  active?: boolean;
  scrollPosition?: GridScrollPosition;
  onScrollPositionChange?: (position: GridScrollPosition) => void;
  rows: readonly ResultGridRow[];
  fieldNames: readonly string[];
  state: ResultGridState;
  onStateChange: (next: ResultGridState) => void;
  onDocument: (row: ResultGridRow) => void;
  executionKey: string;
  fieldFormats?: DataViewFieldFormats;
  footerActions?: ReactNode;
}

export interface GridScrollPosition { top: number; left: number }

/** Registration key for the shared exact comparator; TanStack looks it up on the features registry. */
const exactValueSort = constructSortFn({
  sort: (dataValueA, dataValueB) => compareGridValues(dataValueA as GridCellValue, dataValueB as GridCellValue),
});

const gridFeatures = tableFeatures({
  columnOrderingFeature,
  columnSizingFeature,
  columnResizingFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  sortFns: { gridValue: exactValueSort },
});

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, input, label, a, [role="separator"]') !== null;
}

/** Bounded full-value title: scalars get their verbatim text, nested bodies stay at preview length. */
function cellTitle(column: ResultColumn | undefined): string | undefined {
  if (column === undefined) return undefined;
  const full = column.value.kind === 'object' || column.value.kind === 'array' ? column.preview : column.value.text;
  return full.length > 2000 ? column.preview : full;
}

interface HeaderCellProps {
  header: Header<typeof gridFeatures, ResultGridRow>;
  label: string;
  chromeLabel: string;
  sortDirection: 'asc' | 'desc' | null;
  sortable: boolean;
  movable: boolean;
  loadedRowCount: number;
  onSort: (id: string) => void;
  onResize: (id: string, width: number) => void;
  onAutoFit: (id: string) => void;
}

function GridHeaderCell({ header, label, chromeLabel, sortDirection, sortable, movable, loadedRowCount, onSort, onResize, onAutoFit }: HeaderCellProps) {
  const { t } = useTranslation();
  const column = header.column;
  const size = header.getSize();
  const minSize = column.columnDef.minSize ?? MIN_COLUMN_WIDTH;
  const maxSize = column.columnDef.maxSize ?? MAX_COLUMN_WIDTH;
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: column.id, disabled: !movable });
  const startResize = header.getResizeHandler();
  const style: CSSProperties = { width: size, transform: CSS.Translate.toString(transform ? { ...transform, y: 0 } : null), transition };

  const handleResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const step = event.shiftKey ? 40 : 12;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = size - step;
    else if (event.key === 'ArrowRight') next = size + step;
    else if (event.key === 'Home') next = minSize;
    else if (event.key === 'End') next = maxSize;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onResize(column.id, next);
  };

  return <th ref={setNodeRef} style={style} scope="col" data-column-id={column.id} data-dragging={isDragging || undefined}
    aria-sort={sortDirection === 'asc' ? 'ascending' : sortDirection === 'desc' ? 'descending' : undefined}>
    <div className="rg-th-inner">
      {movable ? <button type="button" ref={setActivatorNodeRef} className="rg-drag-handle"
        aria-label={t('resultGrid:dragHandle', { name: chromeLabel })}
        title={t('resultGrid:dragHandle', { name: chromeLabel })} {...attributes} {...listeners}>
        <GripVertical size={14} aria-hidden />
      </button> : null}
      <button type="button" className="rg-sort-button" disabled={!sortable} data-sort={sortDirection ?? 'none'}
        aria-label={t('resultGrid:sortColumn', { name: chromeLabel })}
        title={sortable ? t('resultGrid:sortColumnHint', { count: loadedRowCount }) : t('resultGrid:unsortable')}
        onClick={() => onSort(column.id)} onDoubleClick={(event) => event.stopPropagation()}>
        <span className="rg-header-label" title={chromeLabel}>{label}</span>
        {sortable ? <span className="rg-sort-icon" aria-hidden>
          {sortDirection === 'asc' ? <ChevronUp size={13} /> : sortDirection === 'desc' ? <ChevronDown size={13} /> : <ChevronsUpDown size={13} />}
        </span> : null}
      </button>
      {column.getCanResize()
        ? <div className="rg-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label={t('resultGrid:resizeColumn', { name: chromeLabel })}
          aria-valuenow={Math.round(size)} aria-valuemin={minSize} aria-valuemax={maxSize}
          title={t('resultGrid:resizeHint')}
          onMouseDown={(event) => { event.stopPropagation(); startResize(event); }}
          onTouchStart={(event) => { event.stopPropagation(); startResize(event); }}
          onKeyDown={handleResizeKey}
          onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onAutoFit(column.id); }} />
        : null}
    </div>
  </th>;
}

export function QueryResultGrid({ active = true, scrollPosition, onScrollPositionChange, rows, fieldNames, state, onStateChange, onDocument, executionKey, fieldFormats, footerActions }: Props) {
  const { t } = useTranslation();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [rawExecution, setRawExecution] = useState<string | null>(null);
  const formatsEnabled = rawExecution !== executionKey;
  const formats = useMemo(() => new Map(fieldFormats?.entries.map(({ field, format }) => [field, format])), [fieldFormats]);
  const viewport = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(scrollPosition);
  const previousPage = useRef(state.pageIndex);
  useEffect(() => { if (!active) setChooserOpen(false); }, [active]);

  // Latest external state for event callbacks, so a burst of updates never merges against a stale prop.
  const stateRef = useRef(state);
  const onStateChangeRef = useRef(onStateChange);
  stateRef.current = state;
  onStateChangeRef.current = onStateChange;
  const commit = useCallback((next: ResultGridState) => {
    stateRef.current = next;
    onStateChangeRef.current(next);
  }, []);

  const discovered = useMemo(() => [ROW_COLUMN_ID, INDEX_COLUMN_ID, ID_COLUMN_ID, ...fieldNames.map(fieldColumnId)], [fieldNames]);
  const columnOrder = useMemo(() => reconcileColumnOrder(state.columnOrder, discovered), [state.columnOrder, discovered]);
  const columnVisibility = useMemo(() => ({ ...state.columnVisibility, [ROW_COLUMN_ID]: true }), [state.columnVisibility]);

  const data = useMemo(() => [...rows], [rows]);
  const rowCount = data.length;
  const pageSize = RESULT_GRID_PAGE_SIZE;
  const pageCount = pageCountOf(rowCount, pageSize);
  const pageIndex = clampPageIndex(state.pageIndex, rowCount, pageSize);
  useLayoutEffect(() => {
    if (!viewport.current) return;
    const pageChanged = previousPage.current !== pageIndex;
    previousPage.current = pageIndex;
    viewport.current.scrollTop = pageChanged ? 0 : initialScroll.current?.top ?? 0;
    if (!pageChanged) viewport.current.scrollLeft = initialScroll.current?.left ?? 0;
  }, [pageIndex]);

  /** Bounded default-width samples and a single scan for local sortability of every field. */
  const fieldStats = useMemo(() => {
    const stats = new Map<string, { sortable: boolean; samples: string[] }>();
    for (const name of fieldNames) stats.set(name, { sortable: false, samples: [] });
    for (const row of rows) {
      for (const column of row.hit.columns) {
        const stat = stats.get(column.name);
        if (stat === undefined) continue;
        const kind = column.value.kind;
        if (!stat.sortable && (kind === 'number' || kind === 'string' || kind === 'boolean')) stat.sortable = true;
        if (stat.samples.length < WIDTH_SAMPLE_ROWS) {
          const format = formats.get(column.name);
          const display = format ? formatFieldValue(column.value, format) : null;
          stat.samples.push(display?.status === 'formatted' ? display.text : column.preview);
        }
      }
    }
    return stats;
  }, [rows, fieldNames, formats]);
  const sortableIds = useMemo(() => discovered.filter((id) => id === ID_COLUMN_ID || id === INDEX_COLUMN_ID
    || fieldStats.get(fieldNameOfColumnId(id) ?? '')?.sortable === true), [discovered, fieldStats]);
  const sorting = useMemo(() => activeSorting(state.sorting, sortableIds), [state.sorting, sortableIds]);

  /** Per-row column lookup by the stable `pageIndex:position` key, so cells never scan `hit.columns`. */
  const columnsByRowKey = useMemo(() => {
    const map = new Map<string, Map<string, ResultColumn>>();
    for (const row of rows) {
      const inner = new Map<string, ResultColumn>();
      for (const column of row.hit.columns) inner.set(column.name, column);
      map.set(`${row.pageIndex}:${row.position}`, inner);
    }
    return map;
  }, [rows]);

  const columnDefs = useMemo(() => {
    const idSamples = rows.slice(0, WIDTH_SAMPLE_ROWS);
    const indexWidth = estimateColumnWidth('_index', idSamples.map((row) => row.hit.index ?? ''));
    const idWidth = clampColumnWidth(estimateColumnWidth('_id', idSamples.map((row) => row.hit.id)) + 24);
    return [
      {
        id: ROW_COLUMN_ID,
        header: t('resultGrid:headingRow'),
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        size: ROW_COLUMN_WIDTH,
        minSize: ROW_COLUMN_WIDTH,
        maxSize: ROW_COLUMN_WIDTH,
      },
      {
        id: INDEX_COLUMN_ID,
        header: '_index',
        accessorFn: (row: ResultGridRow): GridCellValue => (row.hit.index === null ? NULL_GRID_VALUE : { kind: 'string', text: row.hit.index }),
        sortFn: 'gridValue',
        sortUndefined: false,
        enableSorting: true,
        size: indexWidth,
        minSize: MIN_COLUMN_WIDTH,
        maxSize: MAX_COLUMN_WIDTH,
      },
      {
        id: ID_COLUMN_ID,
        header: '_id',
        accessorFn: (row: ResultGridRow): GridCellValue => ({ kind: 'string', text: row.hit.id }),
        sortFn: 'gridValue',
        sortUndefined: false,
        enableSorting: true,
        size: idWidth,
        minSize: MIN_COLUMN_WIDTH,
        maxSize: MAX_COLUMN_WIDTH,
      },
      ...fieldNames.map((name): ColumnDef<typeof gridFeatures, ResultGridRow> => ({
        id: fieldColumnId(name),
        header: name,
        accessorFn: (row: ResultGridRow): GridCellValue => sortValueOf(row, name),
        sortFn: 'gridValue',
        sortUndefined: false,
        enableSorting: fieldStats.get(name)?.sortable ?? false,
        size: estimateColumnWidth(name, fieldStats.get(name)?.samples ?? []),
        minSize: MIN_COLUMN_WIDTH,
        maxSize: MAX_COLUMN_WIDTH,
      })),
    ] as ColumnDef<typeof gridFeatures, ResultGridRow>[];
  }, [rows, fieldNames, fieldStats, t]);

  const pagination = useMemo(() => ({ pageIndex, pageSize }), [pageIndex, pageSize]);
  const tableState = useMemo(() => ({
    sorting, columnOrder, columnSizing: state.columnSizing, columnVisibility, pagination, rowSelection: state.rowSelection,
  }), [sorting, columnOrder, state.columnSizing, columnVisibility, pagination, state.rowSelection]);

  const table = useTable({
    features: gridFeatures,
    columns: columnDefs,
    data,
    state: tableState,
    getRowId: (row) => `${row.pageIndex}:${row.position}`,
    autoResetPageIndex: false,
    enableMultiSort: false,
    enableSubRowSelection: false,
    columnResizeMode: 'onChange',
    onSortingChange: (updater) => {
      const current = activeSorting(stateRef.current.sorting, sortableIds);
      commit({ ...stateRef.current, sorting: typeof updater === 'function' ? updater(current) : updater, pageIndex: 0 });
    },
    onColumnOrderChange: (updater) => {
      const current = reconcileColumnOrder(stateRef.current.columnOrder, discovered);
      commit({ ...stateRef.current, columnOrder: typeof updater === 'function' ? updater(current) : updater });
    },
    onColumnSizingChange: (updater) => {
      const current = stateRef.current.columnSizing;
      commit({ ...stateRef.current, columnSizing: sanitizeColumnSizing(typeof updater === 'function' ? updater(current) : updater) });
    },
    onColumnVisibilityChange: (updater) => {
      const current = stateRef.current.columnVisibility;
      const next = typeof updater === 'function' ? updater(current) : updater;
      commit({ ...stateRef.current, columnVisibility: { ...next, [ROW_COLUMN_ID]: true } });
    },
    onPaginationChange: (updater) => {
      const next = typeof updater === 'function' ? updater(pagination) : updater;
      commit({ ...stateRef.current, pageIndex: clampPageIndex(next.pageIndex, rowCount, pageSize) });
    },
    onRowSelectionChange: (updater) => {
      const current = stateRef.current.rowSelection;
      commit({ ...stateRef.current, rowSelection: typeof updater === 'function' ? updater(current) : updater });
    },
  });

  // A new execution keeps every stored preference and only returns to the first loaded page.
  const executionRef = useRef(executionKey);
  useEffect(() => {
    if (executionRef.current === executionKey) return;
    executionRef.current = executionKey;
    if (stateRef.current.pageIndex !== 0 || Object.keys(stateRef.current.rowSelection).length > 0) {
      commit({ ...stateRef.current, pageIndex: 0, rowSelection: {} });
    }
  }, [executionKey, commit]);

  const emit = useCallback((patch: Partial<ResultGridState>) => {
    commit({ ...stateRef.current, ...patch });
  }, [commit]);

  const headerLabelOf = useCallback((columnId: string): string => {
    if (columnId === ROW_COLUMN_ID) return t('resultGrid:headingRow');
    if (columnId === INDEX_COLUMN_ID) return '_index';
    if (columnId === ID_COLUMN_ID) return '_id';
    return fieldNameOfColumnId(columnId) ?? columnId;
  }, [t]);

  const chooserLabelOf = useCallback((columnId: string): string => {
    if (columnId === ROW_COLUMN_ID) return t('resultGrid:metaRowLabel');
    if (columnId === INDEX_COLUMN_ID) return t('resultGrid:metaIndexLabel');
    if (columnId === ID_COLUMN_ID) return t('resultGrid:metaIdLabel');
    return fieldNameOfColumnId(columnId) ?? columnId;
  }, [t]);

  const visibleLeafColumns = table.getVisibleLeafColumns();
  const movableIds = visibleLeafColumns.map((column) => column.id).filter((id) => !LOCKED_COLUMN_IDS.includes(id));
  const sortingByColumn = new Map(sorting.map((entry) => [entry.id, entry.desc ? 'desc' as const : 'asc' as const]));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const positionOf = useCallback((id: string): number => movableIds.indexOf(id) + 1, [movableIds]);

  const accessibility = useMemo((): { announcements: Announcements; screenReaderInstructions: { draggable: string } } => ({
    screenReaderInstructions: { draggable: t('resultGrid:dragInstructions') },
    announcements: {
      onDragStart: ({ active }) => t('resultGrid:dragStart', { name: chooserLabelOf(String(active.id)) }),
      onDragOver: ({ active, over }) =>
        over === null ? undefined : t('resultGrid:dragOver', { name: chooserLabelOf(String(active.id)), position: positionOf(String(over.id)) }),
      onDragEnd: ({ active, over }) =>
        over === null ? t('resultGrid:dragCancel') : t('resultGrid:dragEnd', { name: chooserLabelOf(String(active.id)), position: positionOf(String(over.id)) }),
      onDragCancel: () => t('resultGrid:dragCancel'),
    },
  }), [t, chooserLabelOf, positionOf]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    emit({ columnOrder: reorderColumns(reconcileColumnOrder(stateRef.current.columnOrder, discovered), String(active.id), String(over.id)) });
  };

  const handleSort = (id: string) => {
    if (sortableIds.includes(id)) emit({ sorting: cycleSorting(activeSorting(stateRef.current.sorting, sortableIds), id), pageIndex: 0 });
  };

  const toggleColumn = (id: string, visible: boolean) => {
    if (LOCKED_COLUMN_IDS.includes(id)) return;
    emit({ columnVisibility: { ...stateRef.current.columnVisibility, [id]: visible } });
  };

  const move = (id: string, delta: -1 | 1) => {
    const order = reconcileColumnOrder(stateRef.current.columnOrder, discovered);
    const known = new Set(discovered);
    const currentColumns = order.filter((columnId) => known.has(columnId) && !LOCKED_COLUMN_IDS.includes(columnId));
    const target = currentColumns[currentColumns.indexOf(id) + delta];
    if (target) emit({ columnOrder: reorderColumns(order, id, target) });
  };

  const resizeColumn = (id: string, width: number) => {
    emit({ columnSizing: { ...stateRef.current.columnSizing, [id]: clampColumnWidth(width) } });
  };

  /** Double-click drops the explicit width and returns to the adaptive default (auto-fit). */
  const autoFitColumn = (id: string) => {
    emit({ columnSizing: restoreColumnWidth(stateRef.current.columnSizing, id) });
  };

  const resetLayout = () => {
    emit({ columnOrder: [], columnSizing: {}, columnVisibility: {} });
  };

  const sortDescription = sorting.length === 0 ? null : sorting
    .map((entry) => t('resultGrid:sortedBy', {
      name: chooserLabelOf(entry.id),
      direction: t(entry.desc ? 'resultGrid:descending' : 'resultGrid:ascending'),
      count: rowCount,
    }))
    .join(' · ');

  const chooserColumns = useMemo(() => {
    const known = new Set(discovered);
    return columnOrder.filter((id) => known.has(id)).map((id) => ({
      id,
      label: chooserLabelOf(id),
      tag: fieldNameOfColumnId(id) === null ? null : t('resultGrid:fieldTag'),
      locked: LOCKED_COLUMN_IDS.includes(id),
      visible: id === ROW_COLUMN_ID || state.columnVisibility[id] !== false,
    }));
  }, [columnOrder, discovered, chooserLabelOf, state.columnVisibility, t]);
  const movableChooserIds = chooserColumns.filter((column) => !column.locked).map((column) => column.id);

  const rowsModel = table.getRowModel().rows;
  const orderedRows = table.getPrePaginatedRowModel().rows;
  const orderedRowIds = useMemo(() => orderedRows.map((row) => row.id), [orderedRows]);
  const visibleRowIds = useMemo(() => rowsModel.map((row) => row.id), [rowsModel]);
  const rowSelection = useTableRowSelection({
    rowIds: orderedRowIds, visibleRowIds, scope: executionKey, active,
    selection: { value: state.rowSelection, onChange: (value) => table.setRowSelection(value) },
  });

  const renderCell = (columnId: string, row: ResultGridRow, displayNumber: number) => {
    if (columnId === ROW_COLUMN_ID) return <span className="rg-cell">{displayNumber}</span>;
    if (columnId === INDEX_COLUMN_ID) return <span className="rg-cell" title={row.hit.index ?? ''}>{row.hit.index ?? '—'}</span>;
    if (columnId === ID_COLUMN_ID) return <span className="rg-id-cell">
      <span className="rg-cell" title={row.hit.id}>{row.hit.id}</span>
      <IconButton icon={FileSearch} label={t('queryLive:documentDetail', { id: row.hit.id })} onClick={() => onDocument(row)} />
    </span>;
    const field = fieldNameOfColumnId(columnId) ?? '';
    const column = columnsByRowKey.get(`${row.pageIndex}:${row.position}`)?.get(field);
    const format = formatsEnabled ? formats.get(field) : undefined;
    const display = column && format ? formatFieldValue(column.value, format) : null;
    const text = display?.status === 'formatted' ? display.text : column?.preview;
    const original = cellTitle(column);
    const title = display?.status === 'formatted' ? t('dataViews:formattedValue', { value: original })
      : display?.status === 'raw' ? t('dataViews:rawFormatValue', { value: original, reason: t(`dataViews:rawReason_${display.reason}`) }) : original;
    return <span className="rg-cell" data-field-format={display?.status} data-runtime-field={column?.runtime}
      title={column?.runtime ? t('runtimeFields:returnedValue', { value: title ?? '' }) : title}>
      {text?.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') ?? '—'}
    </span>;
  };

  const copyOriginalCells = (event: ClipboardEvent<HTMLTableElement>) => {
    const element = event.currentTarget;
    const selection = element.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    const selectedRows: string[][] = [];
    let includesFormatted = false;
    const visibleRows = new Map(rowsModel.map((row) => [row.id, row.original]));
    for (const row of element.rows) {
      const cells: string[] = [];
      const original = visibleRows.get(row.dataset.selectionId ?? '');
      for (const cell of row.cells) {
        const text = cell.querySelector('.rg-cell, .rg-header-label');
        const columnId = cell.dataset.columnId;
        if (!text || !columnId || !range.intersectsNode(text)) continue;
        includesFormatted ||= text.getAttribute('data-field-format') === 'formatted';
        cells.push(!original ? headerLabelOf(columnId) : columnId === ROW_COLUMN_ID ? text.textContent ?? ''
          : columnId === INDEX_COLUMN_ID ? original.hit.index ?? '' : columnId === ID_COLUMN_ID ? original.hit.id
            : columnsByRowKey.get(row.dataset.selectionId!)?.get(fieldNameOfColumnId(columnId) ?? '')?.value.text ?? '');
      }
      if (cells.length) selectedRows.push(cells);
    }
    // A partial selection of a formatted token has no lossless inverse. Copy whole original cells.
    if (includesFormatted) {
      event.preventDefault();
      event.clipboardData.setData('text/plain', selectedRows.map((cells) => cells.join('\t')).join('\n'));
    }
  };

  return <div className="rg-root">
    <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={accessibility} onDragEnd={handleDragEnd}>
      <SortableContext items={movableIds} strategy={horizontalListSortingStrategy}>
        <div ref={viewport} className="rg-scroll" role="region" aria-label={t('queryLive:resultGrid')} tabIndex={0}
          onScroll={(event) => onScrollPositionChange?.({ top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}>
          <table className="rg-table" style={{ width: table.getTotalSize() }} onCopy={copyOriginalCells}>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const columnId = header.column.id;
                  return <GridHeaderCell key={header.id} header={header}
                    label={headerLabelOf(columnId)} chromeLabel={chooserLabelOf(columnId)}
                    sortDirection={sortingByColumn.get(columnId) ?? null}
                    sortable={header.column.getCanSort()} movable={movableIds.includes(columnId)}
                    loadedRowCount={rowCount}
                    onSort={handleSort} onResize={resizeColumn} onAutoFit={autoFitColumn} />;
                })}
              </tr>)}
            </thead>
            <tbody ref={rowSelection.bodyRef} {...rowSelection.bodyProps}>
              {rowsModel.map((row, indexInPage) => <tr key={row.id} {...rowSelection.rowProps(row.id)}
                onDoubleClick={(event) => { if (!isInteractiveTarget(event.target)) onDocument(row.original); }}>
                {row.getVisibleCells().map((cell) => {
                  const columnId = cell.column.id;
                  const isNumber = columnId === ROW_COLUMN_ID;
                  const isNested = !isNumber && columnId !== INDEX_COLUMN_ID && columnId !== ID_COLUMN_ID
                    && columnsByRowKey.get(row.id)?.get(fieldNameOfColumnId(columnId) ?? '')?.nested === true;
                  return <td key={cell.id} data-column-id={columnId}
                    className={isNumber ? 'rg-number-cell' : isNested ? 'rg-value-cell rg-nested-cell' : 'rg-value-cell'}>
                    {renderCell(columnId, row.original, pageIndex * pageSize + indexInPage + 1)}
                  </td>;
                })}
              </tr>)}
              {rowsModel.length === 0 ? <tr><td className="rg-empty-cell" colSpan={Math.max(visibleLeafColumns.length, 1)}>{t('resultGrid:empty')}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </SortableContext>
    </DndContext>
    <div className="rg-footer">
      {sortDescription === null
        ? <span className="rg-toolbar-status" role="status">{t('resultGrid:rowsLoaded', { count: rowCount })}</span>
        : <span className="rg-toolbar-status" role="status" aria-label={sortDescription} title={sortDescription}>
          {t('resultGrid:localSortRows', { count: rowCount })}
        </span>}
      {pageCount > 1 ? <div className="rg-pager">
        <IconButton icon={ChevronLeft} label={t('resultGrid:prevPage')} disabled={pageIndex <= 0}
          onClick={() => emit({ pageIndex: clampPageIndex(pageIndex - 1, rowCount, pageSize) })} />
        <span role="status">{t('resultGrid:pageLabel', { page: pageIndex + 1, total: pageCount })}</span>
        <IconButton icon={ChevronRight} label={t('resultGrid:nextPage')} disabled={pageIndex >= pageCount - 1}
          onClick={() => emit({ pageIndex: clampPageIndex(pageIndex + 1, rowCount, pageSize) })} />
      </div> : null}
      <div className="rg-toolbar-end">
        <TableSelectionStatus count={rowSelection.selectedCount} onClear={rowSelection.clear} />
        {sorting.length > 0 ? <IconButton icon={ListRestart} label={t('resultGrid:clearSort')}
          onClick={() => emit({ sorting: [], pageIndex: 0 })} /> : null}
        {formats.size > 0 ? <IconButton icon={ALargeSmall} label={t('dataViews:toggleFormats')} aria-pressed={formatsEnabled}
          onClick={() => setRawExecution(formatsEnabled ? executionKey : null)} /> : null}
        <IconButton icon={Columns3} label={t('resultGrid:columnsButton')} aria-haspopup="dialog"
          aria-expanded={chooserOpen} onClick={() => setChooserOpen(true)} />
        {footerActions}
      </div>
    </div>
    <Modal open={active && chooserOpen} onClose={() => setChooserOpen(false)}
      title={t('resultGrid:columnsTitle')}>
      <ul className="rg-chooser">
        {chooserColumns.map((column) => {
          const position = movableChooserIds.indexOf(column.id);
          return <li key={column.id} className="rg-chooser-row">
            <label title={column.locked ? t('resultGrid:lockedColumn') : undefined}>
              <input type="checkbox" checked={column.visible} disabled={column.locked}
                aria-label={t('resultGrid:toggleColumn', { name: column.label })}
                onChange={(event) => toggleColumn(column.id, event.target.checked)} />
              <span className="rg-chooser-name">{column.label}</span>
              {column.tag === null ? null : <span className="rg-chooser-tag">{column.tag}</span>}
              {column.locked ? <span className="rg-chooser-tag">{t('resultGrid:lockedColumnLabel')}</span> : null}
            </label>
            <div className="rg-chooser-move">
              <IconButton icon={ArrowLeft} label={t('resultGrid:moveLeft', { name: column.label })}
                disabled={column.locked || position <= 0} onClick={() => move(column.id, -1)} />
              <IconButton icon={ArrowRight} label={t('resultGrid:moveRight', { name: column.label })}
                disabled={column.locked || position >= movableChooserIds.length - 1} onClick={() => move(column.id, 1)} />
            </div>
          </li>;
        })}
      </ul>
      <div className="rg-chooser-actions">
        <button type="button" className="secondary compact-button" onClick={resetLayout}>
          <RotateCcw size={14} aria-hidden />{t('resultGrid:resetLayout')}
        </button>
      </div>
    </Modal>
  </div>;
}
