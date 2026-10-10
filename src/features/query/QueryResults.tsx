import { Check, CheckCheck, ChevronDown, Copy, Download, FileDown, Info, ListTree, LoaderCircle, MonitorX, Search, TriangleAlert, XCircle } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, IconButton } from '../../components/controls';
import type { ExecutionSnapshot, ExecutionState, QueryDocument } from '../../domain/query';
import { formatRawJson } from '../../domain/query-result';
import { supportsSnapshotPaging } from '../../domain/query-pagination';
import { INITIAL_RESULT_GRID_STATE, type ResultGridState } from '../../domain/result-grid';
import type { ResultGridLayout } from '../../domain/workspace-recovery';
import { QueryResultGrid, type GridScrollPosition } from './QueryResultGrid';
import { ResultExportDialog } from './QueryLibrary';
import type { ExecutionEntry, ExecutionPage } from './useQueryExecutions';
import { executionErrorKey } from './error-message';
import { useCopyText } from './useCopyText';
import type { QueryLibraryService } from '../../services/query-library';
import type { CellFilterSelection } from '../../domain/query-filters';
import { compareLoadedDocuments, type DocumentComparisonResult } from '../../domain/document-comparison';
import { DocumentComparisonDialog } from './DocumentComparisonDialog';
import { inspectLoadedDocument, type DocumentDetailResult } from '../../domain/document-detail';
import { DocumentDetailDialog } from './DocumentDetailDialog';
import { QueryAggregations } from './QueryAggregations';

const IDLE: ExecutionState = { status: 'idle' };
const EMPTY_PAGES: readonly ExecutionPage[] = [];

interface Props {
  kind?: 'preview' | 'query';
  active?: boolean;
  documentIds?: readonly string[];
  wrapJson?: boolean;
  grouping?: boolean;
  renderToolbar?: (summary: ReactNode, controls: ReactNode) => ReactNode;
  query: QueryDocument;
  entry: ExecutionEntry | undefined;
  available: boolean;
  stale: boolean;
  endpointChanged: boolean;
  onCancel: () => void;
  onRun: () => void;
  canRun?: boolean;
  onViewChange: (view: QueryDocument['resultView']) => void;
  /** Continue the execution inside its snapshot; only offered when a cursor exists. */
  onLoadMore: () => void;
  /** When provided, the loaded rows can be exported as CSV or JSONL through this service. */
  exportService?: QueryLibraryService;
  /** Opens a separate, explicitly confirmed scan; never borrows this result's PIT. */
  onSnapshotExport?: () => void;
  onFilterCell?: (selection: CellFilterSelection) => void;
  onNestedFilters?: () => void;
  /** Persisted layout only. Pages, selection and scroll belong to this live execution. */
  layout?: ResultGridLayout;
  onLayoutChange?: (layout: ResultGridLayout) => void;
}

/**
 * Result surface for one query. The verbatim response is kept for the JSON view and every
 * copy path; the table reads lossless slices of `_source`/`fields` and never re-serializes a
 * number. Failed, cancelled and partial executions stay visually distinct from success, and
 * an unavailable (browser) workspace offers neither a request nor a retry.
 */
export function QueryResults({ kind = 'query', active = true, documentIds, wrapJson = false, grouping = true, renderToolbar, query, entry, available, stale, endpointChanged, onCancel, onRun, canRun = true, onViewChange, onLoadMore, exportService, onSnapshotExport, onFilterCell, onNestedFilters, layout, onLayoutChange }: Props) {
  const { t, i18n } = useTranslation();
  const copy = useCopyText(query.id);
  const [gridStates, setGridStates] = useState<Record<string, { executionKey: string; value: ResultGridState }>>({});
  const [selectedDetail, setDetail] = useState<{ snapshot: ExecutionSnapshot; result: DocumentDetailResult } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedComparison, setComparison] = useState<{ snapshot: ExecutionSnapshot; result: DocumentComparisonResult } | null>(null);
  const [aggregationSnapshot, setAggregationSnapshot] = useState<ExecutionSnapshot | null>(null);
  const scroll = useRef(new Map<string, { executionKey: string; table?: GridScrollPosition; json?: GridScrollPosition }>());
  const jsonViewport = useRef<HTMLPreElement>(null);
  const state = entry?.state ?? IDLE;
  const parsed = entry?.parsed ?? null;
  const pages = entry?.pages ?? EMPTY_PAGES;
  const continuing = entry?.continuing ?? false;
  const continuationError = entry?.continuationError ?? null;
  const requestKey = 'snapshot' in state ? state.snapshot.requestId : null;
  const detailSnapshot = state.status === 'success' || state.status === 'partial' ? state.snapshot : null;
  const canShowAggregations = kind === 'query' && detailSnapshot?.queryId === query.id && pages.length > 0;
  const showAggregations = active && canShowAggregations && detailSnapshot === aggregationSnapshot;
  useEffect(() => { setAggregationSnapshot(null); }, [query.id, detailSnapshot, active]);
  const detail = active && detailSnapshot?.queryId === query.id && selectedDetail?.snapshot === detailSnapshot ? selectedDetail : null;
  useEffect(() => { setDetail(null); }, [query.id, detailSnapshot, active]);
  const comparison = active && (state.status === 'success' || state.status === 'partial')
    && state.snapshot.queryId === query.id && selectedComparison?.snapshot === state.snapshot ? selectedComparison : null;
  useEffect(() => { setComparison(null); }, [query.id, requestKey, active]);
  const executionKey = requestKey ?? query.id;
  const savedGrid = gridStates[query.id];
  const liveGrid = savedGrid?.executionKey === executionKey ? savedGrid.value
    : savedGrid ? { ...savedGrid.value, pageIndex: 0, rowSelection: {} } : INITIAL_RESULT_GRID_STATE;
  const gridState = layout ? { ...liveGrid, ...layout } : liveGrid;
  const lastPage = pages[pages.length - 1];
  const savedScroll = scroll.current.get(query.id);
  const positions = savedScroll?.executionKey === executionKey ? savedScroll : undefined;
  const recordScroll = (view: 'table' | 'json', position: GridScrollPosition) => {
    const previous = scroll.current.get(query.id);
    scroll.current.set(query.id, { ...(previous?.executionKey === executionKey ? previous : {}), executionKey, [view]: position });
  };
  useLayoutEffect(() => {
    const saved = scroll.current.get(query.id);
    const position = saved?.executionKey === executionKey ? saved.json : undefined;
    if (jsonViewport.current) {
      jsonViewport.current.scrollTop = position?.top ?? 0;
      jsonViewport.current.scrollLeft = position?.left ?? 0;
    }
  }, [query.id, query.resultView, executionKey]);
  useEffect(() => {
    if (!documentIds) return;
    const live = new Set(documentIds);
    for (const id of scroll.current.keys()) if (!live.has(id)) scroll.current.delete(id);
    setGridStates((current) => {
      const kept = Object.entries(current).filter(([id]) => live.has(id));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [documentIds]);
  // A body that failed to parse is still shown verbatim; only a transport failure has none.
  const raw = lastPage?.rawResponse ?? entry?.rawResponse
    ?? (state.status === 'success' || state.status === 'partial' ? state.rawResponse : null);
  const formattedRaw = useMemo(() => raw === null ? null : formatRawJson(raw), [raw]);
  const summary = parsed?.ok ? parsed.summary : null;
  // Every received page contributes rows; each row remembers the page it came from, so the detail
  // view slices that page's verbatim body and never an offset into a newer one.
  const displayHits = useMemo(() => pages.flatMap((page, pageIndex) =>
    page.summary.hits.map((hit, position) => ({ hit, pageIndex, position }))), [pages]);
  const columns = useMemo(() => {
    const names = new Set<string>();
    for (const { hit } of displayHits) {
      for (const column of hit.columns) names.add(column.name);
    }
    return [...names];
  }, [displayHits]);
  const hits = displayHits;
  // Export rows are the same loaded hits the grid shows; nothing is fetched or re-parsed here.
  const exportHits = useMemo(() => displayHits.map((row) => row.hit), [displayHits]);
  const exportable = exportService !== undefined && (state.status === 'success' || state.status === 'partial') && exportHits.length > 0;
  // The export dialog follows the execution that is actually displayed: leaving it (running,
  // failed, another query or a new request) closes it, which also invalidates a pending attempt.
  useEffect(() => { if (!exportable) setExportOpen(false); }, [exportable]);
  useEffect(() => { setExportOpen(false); }, [query.id, requestKey, showAggregations]);
  const totals = summary?.totals ?? null;
  const totalText = totals === null ? '' : new Intl.NumberFormat(i18n.language, { useGrouping: grouping }).format(BigInt(totals.text));
  const hitsText = totals === null ? t('queryLive:hitsUnknown')
    : t(totals.relation === 'gte' ? 'queryLive:hitsGte' : 'queryLive:hitsEq', { value: totalText });
  const canContinue = (state.status === 'success' || state.status === 'partial') && lastPage !== undefined;
  const allLoaded = lastPage?.summary.hits.length === 0 || (totals?.relation === 'eq' && totals.text === String(hits.length));
  const hasSnapshot = entry?.pitId != null && continuationError !== 'notFound' && !endpointChanged;
  const managedPaging = useMemo(() => 'snapshot' in state && supportsSnapshotPaging(state.snapshot.rawDsl), [state]);
  const title = t(kind === 'preview' ? 'queryLive:dataPreview' : 'query:results');
  const errorKey = (code: string) => executionErrorKey(code, (key) => i18n.exists(key));

  const copyNote = copy.status === 'idle' ? null
    : <span className={`ql-copy-note ${copy.status === 'failed' ? 'failed' : 'done'}`} role="status">
      {copy.status === 'failed' ? t('queryLive:copyFailed') : t('queryLive:copied')}</span>;

  // The footer distinguishes local pages from fetching another page of the same snapshot.
  const pagingHint = [t('queryLive:loadMoreHint'), pages.length > 1 ? t('queryLive:loadedPages', { count: pages.length }) : null]
    .filter(Boolean).join('\n');
  const pagingNote = (text: string, complete = false) => <span className="ql-paging-note" role="img" tabIndex={0}
    aria-label={text} title={text}>{complete ? <CheckCheck size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}</span>;
  const continuation = canContinue ? <div className="ql-continuation">
    {allLoaded ? pagingNote(t('queryLive:allRowsLoaded'), true)
      : (lastPage?.cursor ?? null) !== null && hasSnapshot
      ? <button type="button" className="secondary compact-button ql-load-more" disabled={continuing} onClick={onLoadMore} title={pagingHint}>
        {continuing ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
        {t(continuing ? 'queryLive:loadingMore' : 'queryLive:loadMore')}
      </button>
      : (lastPage?.cursor ?? null) !== null && managedPaging
        ? <button type="button" className="secondary compact-button" disabled={!canRun} onClick={onRun}>{t('queryLive:rerun')}</button>
      : (lastPage?.cursor ?? null) !== null ? pagingNote(t('queryLive:unmanagedCursor'))
      : pagingNote(t('queryLive:loadMoreNeedsSort'))}
  </div> : null;

  // Scroll, native selection endpoints and virtualized controls belong to one live execution.
  const table = <QueryResultGrid key={JSON.stringify([query.id, executionKey])} rows={displayHits} fieldNames={columns} state={gridState} executionKey={executionKey}
    fieldFormats={'snapshot' in state ? state.snapshot.dataView?.definition.fieldFormats : undefined}
    active={active} scrollPosition={positions?.table} onScrollPositionChange={(position) => recordScroll('table', position)}
    onStateChange={(value) => {
      setGridStates((current) => ({ ...current, [query.id]: { executionKey, value } }));
      onLayoutChange?.(value);
    }}
    onDocument={(row) => {
      if (!active || (state.status !== 'success' && state.status !== 'partial') || state.snapshot.queryId !== query.id) return;
      setDetail({ snapshot: state.snapshot, result: inspectLoadedDocument(state.snapshot, entry?.endpoint ?? null, pages, row) });
    }}
    onCompare={(selection) => {
      if (!active || (state.status !== 'success' && state.status !== 'partial') || state.snapshot.queryId !== query.id) return;
      setComparison({ snapshot: state.snapshot, result: compareLoadedDocuments(state.snapshot, entry?.endpoint ?? null, pages, selection) });
    }}
    onFilterCell={onFilterCell ? ({ hit }, field) => {
      const column = hit.columns.find((item) => item.name === field);
      onFilterCell({ field, value: column?.value, origin: column?.runtime || !hit.hasSource ? 'fields' : 'source' });
    } : undefined}
    footerActions={continuation} />;

  const rawBlock = raw === null ? null : <>
    <pre ref={jsonViewport} className="ql-pre" data-wrap={wrapJson}
      onScroll={(event) => recordScroll('json', { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft })}>{formattedRaw}</pre>
    <div className="ql-result-footer">
      {summary ? <span className="ql-status">{t('resultGrid:rowsLoaded', { count: hits.length })}</span> : null}
      {pages.length > 1 ? <span className="ql-status">{t('queryLive:rawLatestPage')}</span> : null}
      <div className="ql-footer-actions">
        {copyNote}
        <IconButton icon={Copy} label={t('queryLive:copyResponse')} onClick={() => copy.copy(raw)} />
        {continuation}
      </div>
    </div>
  </>;

  let content: ReactNode = null;
  if (!available) {
    content = <EmptyState icon={MonitorX} title={t('queryLive:desktopOnly')} description={t('queryLive:desktopOnlyDetail')} />;
  } else if (state.status === 'idle') {
    content = <EmptyState icon={Search}
      title={t(kind === 'preview' ? 'queryLive:previewEmpty' : 'query:noResults')}
      description={t(kind === 'preview' ? 'queryLive:previewEmptyDetail' : 'query:noResultsDetail')} />;
  } else if (state.status === 'running') {
    content = <div className="empty-state"><LoaderCircle className="empty-icon spin" size={28} /><p>{t('queryLive:running')}</p></div>;
  } else if (state.status === 'cancelled') {
    content = <EmptyState icon={XCircle} title={t('queryLive:cancelledTitle')} description={t('queryLive:cancelledDetail')}>
      <button type="button" className="secondary" disabled={!canRun} onClick={onRun}>{t('queryLive:rerun')}</button></EmptyState>;
  } else if (state.status === 'failed') {
    content = <>
      <EmptyState icon={TriangleAlert} title={t('queryLive:failedTitle')} description={t(errorKey(state.code))}>
        <button type="button" className="secondary" disabled={!canRun} onClick={onRun}>{t('queryLive:rerun')}</button>
      </EmptyState>
      {query.resultView === 'json' ? rawBlock : null}
    </>;
  } else if (showAggregations && detailSnapshot) {
    content = <QueryAggregations snapshot={detailSnapshot} endpoint={entry?.endpoint ?? null} pages={pages} wrapJson={wrapJson} />;
  } else if (query.resultView === 'json') {
    content = rawBlock;
  } else if (summary === null) {
    content = <div className="ql-state error" role="alert"><span>{t(errorKey('invalidResponse'))}</span></div>;
  } else if (hits.length === 0) {
    content = <EmptyState icon={Search} title={t('queryLive:noHits')} description={t('queryLive:noHitsDetail')} />;
  } else {
    content = table;
  }

  const toolbarSummary = <div className="ql-summary">
      {state.status === 'running' ? <span className="ql-status" role="status"><LoaderCircle size={13} className="spin" />{t('queryLive:running')}</span> : null}
      {state.status === 'failed' ? <span className="ql-status-chip failed">{t('queryLive:failedTitle')}</span> : null}
      {state.status === 'cancelled' ? <span className="ql-status-chip cancelled">{t('queryLive:cancelledTitle')}</span> : null}
      {state.status === 'success' || state.status === 'partial' ? <>
        {kind === 'preview' && state.status === 'success'
          ? <span className="ql-status-indicator success" role="img" aria-label={t('queryLive:statusSuccess')} title={t('queryLive:statusSuccess')}>
            <Check size={15} aria-hidden="true" /></span>
          : <span className={`ql-status-chip ${state.status === 'partial' ? 'partial' : 'success'}`}>
            {state.status === 'partial' ? t('queryLive:statusPartial') : t('queryLive:statusSuccess')}</span>}
        <span className="ql-status ql-hit-count" title={hitsText}>{hitsText}</span>
        {summary?.tookMs != null ? <span className="ql-status ql-timing">
          {t(kind === 'preview' ? 'queryLive:tookCompact' : 'queryLive:took', { value: summary.tookMs })}</span> : null}
      </> : null}
    </div>;
  const toolbarControls = <div className="ql-toolbar-end">
        {onNestedFilters ? <IconButton icon={ListTree} label={t('queryFilters:nestedEditor')} onClick={onNestedFilters} /> : null}
        {exportable && !showAggregations ? <IconButton icon={Download} label={t('queryLibrary:exportLoaded')} onClick={() => setExportOpen(true)} /> : null}
        {onSnapshotExport ? <IconButton icon={FileDown} label={t('queryExport:open')} onClick={onSnapshotExport} /> : null}
        {state.status === 'running' || continuing ? <button type="button" className="secondary compact-button" onClick={onCancel}>{t('queryLive:cancel')}</button> : null}
        <div className="segment" role="group" aria-label={t('query:resultView')}>
          {(['table', 'json'] as const).map((view) => <button key={view} type="button"
            aria-pressed={!showAggregations && query.resultView === view} onClick={() => {
              setAggregationSnapshot(null); onViewChange(view);
            }}>{t(`query:${view}`)}</button>)}
          {canShowAggregations ? <button type="button" aria-pressed={showAggregations}
            onClick={() => setAggregationSnapshot(detailSnapshot)}>{t('queryAggregations:title')}</button> : null}
        </div>
      </div>;

  return <section className="results-section" data-kind={kind} aria-label={title}>
    {renderToolbar ? renderToolbar(toolbarSummary, toolbarControls) : <div className="results-toolbar">
      {kind === 'query' ? <h2>{title}</h2> : null}
      {toolbarSummary}{toolbarControls}
    </div>}
    {kind === 'query' && 'snapshot' in state ? <div className="ql-result-origin" aria-label={t('queryLive:executionTarget')}>
      <span>{entry?.endpoint}</span><span>{state.snapshot.index}</span>
    </div> : null}
    {stale || endpointChanged || state.status === 'partial' || continuationError !== null ? <div className="ql-notices">
      {stale ? <div className="notice warning" role="status"><span>{t('queryLive:staleResult')}</span></div> : null}
      {endpointChanged ? <div className="notice warning" role="status"><span>{t('queryLive:endpointChanged')}</span></div> : null}
      {continuationError !== null ? <div className={`notice ${continuationError === 'cancelled' ? 'neutral' : 'warning'}`} role="status">
        {continuationError !== 'cancelled' ? <TriangleAlert size={16} /> : null}<div>
        {continuationError === 'cancelled' ? t('queryLive:loadMoreCancelled')
          : continuationError === 'notFound' ? t('queryLive:pitExpired')
          : `${t('queryLive:loadMoreFailed')} ${t(errorKey(continuationError))}`}
      </div></div> : null}
      {state.status === 'partial' ? <div className="notice warning" role="status"><TriangleAlert size={16} /><div>
        <div>{t('queryLive:partialDetail')}</div>
        {summary?.timedOut ? <div>{t('queryLive:timedOut')}</div> : null}
        {summary && (summary.shards.failed ?? 0) > 0 ? <div>{t('queryLive:shardFailures', { count: summary.shards.failed ?? 0 })}</div> : null}
        {summary && summary.shards.failures.length > 0 ? <ul className="ql-failures">
          {summary.shards.failures.slice(0, 5).map((failure, position) => <li key={position}>
            {[failure.index, failure.shard !== null ? `#${failure.shard}` : null, failure.reason].filter(Boolean).join(' · ')}</li>)}
        </ul> : null}
      </div></div> : null}
    </div> : null}
    <div className="ql-results-body">{content}</div>
    {detail ? <DocumentDetailDialog result={detail.result} stale={stale} endpointChanged={endpointChanged}
      partial={state.status === 'partial'} wrapJson={wrapJson} onClose={() => setDetail(null)} /> : null}
    {exportService ? <ResultExportDialog open={exportOpen} service={exportService} hits={exportHits} pages={pages}
      baseName={'snapshot' in state ? state.snapshot.index : ''} partial={state.status === 'partial'}
      onClose={() => setExportOpen(false)} /> : null}
    {comparison ? <DocumentComparisonDialog result={comparison.result} stale={stale} endpointChanged={endpointChanged}
      partial={state.status === 'partial'} onClose={() => setComparison(null)} /> : null}
  </section>;
}
