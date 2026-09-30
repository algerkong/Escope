import { FileSearch, LoaderCircle, MonitorX, Search, TriangleAlert, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState, IconButton, Modal } from '../../components/controls';
import type { ExecutionState, QueryDocument } from '../../domain/query';
import { sliceRaw, type ResultHit } from '../../domain/query-result';
import type { ExecutionEntry } from './useQueryExecutions';
import { executionErrorKey } from './error-message';
import { useCopyText } from './useCopyText';

/** Bounded page size: a large response never renders every row into the DOM at once. */
const PAGE_SIZE = 50;
const MAX_COLUMNS = 8;
const IDLE: ExecutionState = { status: 'idle' };

interface Props {
  query: QueryDocument;
  entry: ExecutionEntry | undefined;
  available: boolean;
  stale: boolean;
  endpointChanged: boolean;
  onCancel: () => void;
  onRun: () => void;
  onViewChange: (view: QueryDocument['resultView']) => void;
}

/**
 * Result surface for one query. The verbatim response is kept for the JSON view and every
 * copy path; the table reads lossless slices of `_source`/`fields` and never re-serializes a
 * number. Failed, cancelled and partial executions stay visually distinct from success, and
 * an unavailable (browser) workspace offers neither a request nor a retry.
 */
export function QueryResults({ query, entry, available, stale, endpointChanged, onCancel, onRun, onViewChange }: Props) {
  const { t, i18n } = useTranslation();
  const copy = useCopyText();
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState<ResultHit | null>(null);
  const state = entry?.state ?? IDLE;
  const parsed = entry?.parsed ?? null;
  const requestKey = 'snapshot' in state ? state.snapshot.requestId : null;
  useEffect(() => { setPage(0); setDetail(null); }, [requestKey]);
  // A body that failed to parse is still shown verbatim; only a transport failure has none.
  const raw = state.status === 'success' || state.status === 'partial' ? state.rawResponse : entry?.rawResponse ?? null;
  const summary = parsed?.ok ? parsed.summary : null;
  const columns = useMemo(() => {
    const names: string[] = [];
    for (const hit of summary?.hits ?? []) {
      for (const column of hit.columns) if (!names.includes(column.name)) names.push(column.name);
      if (names.length >= MAX_COLUMNS) break;
    }
    return names;
  }, [summary]);
  const hits = summary?.hits ?? [];
  const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = hits.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const totals = summary?.totals ?? null;
  const documentText = detail && raw
    ? detail.source ? sliceRaw(raw, detail.source) : detail.fields ? sliceRaw(raw, detail.fields) : ''
    : '';
  const errorKey = (code: string) => executionErrorKey(code, (key) => i18n.exists(key));

  const copyNote = copy.status === 'idle' ? null
    : <span className={`ql-copy-note ${copy.status === 'failed' ? 'failed' : 'done'}`} role="status">
      {copy.status === 'failed' ? t('queryLive:copyFailed') : t('queryLive:copied')}</span>;

  const table = <div className="ql-table-wrap"><table className="ql-table">
    <thead><tr><th>#</th><th>_index</th><th>_id</th>{columns.map((name) => <th key={name}>{name}</th>)}</tr></thead>
    <tbody>{rows.map((hit, offset) => {
      const position = currentPage * PAGE_SIZE + offset;
      return <tr key={`${hit.id}-${position}`}>
        <td className="muted">{position + 1}</td>
        <td>{hit.index ?? '—'}</td>
        <td><span className="ql-document-id">{hit.id}<IconButton icon={FileSearch}
          label={t('queryLive:documentDetail', { id: hit.id })} onClick={() => setDetail(hit)} /></span></td>
        {columns.map((name) => {
          const column = hit.columns.find((entryColumn) => entryColumn.name === name);
          return <td key={name} className={column?.nested ? 'ql-cell-nested' : undefined}>{column?.preview ?? '—'}</td>;
        })}
      </tr>;
    })}</tbody>
  </table></div>;

  const pager = hits.length > PAGE_SIZE ? <div className="ql-page">
    <span>{t('queryLive:rowsCapped', { shown: rows.length, total: hits.length })}</span>
    <button type="button" className="secondary compact-button" disabled={currentPage === 0}
      onClick={() => setPage(currentPage - 1)}>{t('queryLive:prevPage')}</button>
    <span>{t('queryLive:pageLabel', { page: currentPage + 1, total: pageCount })}</span>
    <button type="button" className="secondary compact-button" disabled={currentPage >= pageCount - 1}
      onClick={() => setPage(currentPage + 1)}>{t('queryLive:nextPage')}</button>
  </div> : null;

  const rawBlock = raw === null ? null : <>
    <pre className="ql-pre">{raw}</pre>
    <div className="ql-detail-actions">
      <button type="button" className="secondary compact-button" onClick={() => copy.copy(raw)}>{t('queryLive:copyResponse')}</button>
      {copyNote}
    </div>
  </>;

  let content: ReactNode = null;
  if (!available) {
    content = <EmptyState icon={MonitorX} title={t('queryLive:desktopOnly')} description={t('queryLive:desktopOnlyDetail')} />;
  } else if (state.status === 'idle') {
    content = <EmptyState icon={Search} title={t('query:noResults')} description={t('query:noResultsDetail')} />;
  } else if (state.status === 'running') {
    content = <div className="empty-state"><LoaderCircle className="empty-icon spin" size={28} /><p>{t('queryLive:running')}</p></div>;
  } else if (state.status === 'cancelled') {
    content = <EmptyState icon={XCircle} title={t('queryLive:cancelledTitle')} description={t('queryLive:cancelledDetail')}>
      <button type="button" className="secondary" onClick={onRun}>{t('queryLive:rerun')}</button></EmptyState>;
  } else if (state.status === 'failed') {
    content = <>
      <EmptyState icon={TriangleAlert} title={t('queryLive:failedTitle')} description={t(errorKey(state.code))}>
        <button type="button" className="secondary" onClick={onRun}>{t('queryLive:rerun')}</button>
      </EmptyState>
      {query.resultView === 'json' ? rawBlock : null}
    </>;
  } else if (query.resultView === 'json') {
    content = rawBlock;
  } else if (summary === null) {
    content = <div className="ql-state error" role="alert"><span>{t(errorKey('invalidResponse'))}</span></div>;
  } else if (hits.length === 0) {
    content = <EmptyState icon={Search} title={t('queryLive:noHits')} description={t('queryLive:noHitsDetail')} />;
  } else {
    content = <>{table}{pager}</>;
  }

  return <section className="results-section" aria-label={t('query:results')}>
    <div className="results-toolbar">
      <h2>{t('query:results')}</h2>
      {state.status === 'running' ? <span className="ql-status" role="status"><LoaderCircle size={13} className="spin" />{t('queryLive:running')}</span> : null}
      {state.status === 'failed' ? <span className="ql-status-chip failed">{t('queryLive:failedTitle')}</span> : null}
      {state.status === 'cancelled' ? <span className="ql-status-chip cancelled">{t('queryLive:cancelledTitle')}</span> : null}
      {state.status === 'success' || state.status === 'partial' ? <>
        <span className={`ql-status-chip ${state.status === 'partial' ? 'partial' : 'success'}`}>
          {state.status === 'partial' ? t('queryLive:statusPartial') : t('queryLive:statusSuccess')}</span>
        <span className="ql-status">{totals === null ? t('queryLive:hitsUnknown')
          : totals.relation === 'gte' ? t('queryLive:hitsGte', { value: totals.text })
          : t('queryLive:hitsEq', { value: totals.text })}</span>
        {summary?.tookMs != null ? <span className="ql-status">{t('queryLive:took', { value: summary.tookMs })}</span> : null}
        <span className="ql-status">{t('queryLive:returnedRows', { count: hits.length })}</span>
      </> : null}
      <div className="ql-toolbar-end">
        {state.status === 'running' ? <button type="button" className="secondary compact-button" onClick={onCancel}>{t('queryLive:cancel')}</button> : null}
        <div className="segment" role="group" aria-label={t('query:resultView')}>
          {(['table', 'json'] as const).map((view) => <button key={view} type="button"
            aria-pressed={query.resultView === view} onClick={() => onViewChange(view)}>{t(`query:${view}`)}</button>)}
        </div>
      </div>
    </div>
    {'snapshot' in state ? <div className="ql-result-origin" aria-label={t('queryLive:executionTarget')}>
      <span>{entry?.endpoint}</span><span>{state.snapshot.index}</span>
    </div> : null}
    {stale || endpointChanged || state.status === 'partial' ? <div className="ql-notices">
      {stale ? <div className="notice warning" role="status"><span>{t('queryLive:staleResult')}</span></div> : null}
      {endpointChanged ? <div className="notice warning" role="status"><span>{t('queryLive:endpointChanged')}</span></div> : null}
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
    <Modal open={detail !== null} onClose={() => setDetail(null)}
      title={t('queryLive:documentDetail', { id: detail?.id ?? '' })} description={t('queryLive:detailHint')}>
      {detail ? <>
        <dl className="ql-detail-meta">
          <dt>_index</dt><dd>{detail.index ?? '—'}</dd>
          <dt>_id</dt><dd>{detail.id}</dd>
          <dt>_score</dt><dd>{detail.score ?? '—'}</dd>
        </dl>
        {detail.hasSource && detail.source && raw ? <>
          <h3 className="subheading">{t('queryLive:detailSource')}</h3>
          <pre className="ql-pre">{sliceRaw(raw, detail.source)}</pre>
        </> : <p className="muted small">{t('queryLive:noSource')}</p>}
        {detail.fields && raw ? <>
          <h3 className="subheading">{t('queryLive:detailFields')}</h3>
          <pre className="ql-pre">{sliceRaw(raw, detail.fields)}</pre>
        </> : null}
        <div className="ql-detail-actions">
          <button type="button" className="secondary compact-button" disabled={documentText === ''}
            onClick={() => copy.copy(documentText)}>{t('queryLive:copyDocument')}</button>
          <button type="button" className="secondary compact-button" disabled={raw === null}
            onClick={() => { if (raw !== null) copy.copy(raw); }}>{t('queryLive:copyResponse')}</button>
          {copyNote}
        </div>
      </> : null}
    </Modal>
  </section>;
}
