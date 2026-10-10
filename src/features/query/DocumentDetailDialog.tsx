import { ChevronDown, ChevronLeft, ChevronRight, Copy, FileJson, FoldVertical, Search, UnfoldVertical } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import {
  DOCUMENT_DETAIL_PAGE_SIZE, MAX_DOCUMENT_DETAIL_SEARCH_LENGTH, documentFieldValue, visibleDocumentFields,
  type DocumentDetail, type DocumentDetailResult,
} from '../../domain/document-detail';
import type { LoadedDocumentSection } from '../../domain/loaded-document';
import { formatRawJson } from '../../domain/query-result';
import { useCopyText } from './useCopyText';
import '../../styles/document-detail.css';

interface Props {
  result: DocumentDetailResult;
  stale: boolean;
  endpointChanged: boolean;
  partial: boolean;
  wrapJson: boolean;
  onClose: () => void;
}

function RawDocument({ raw, wrap }: { raw: string; wrap: boolean }) {
  const { t } = useTranslation();
  const formatted = useMemo(() => formatRawJson(raw), [raw]);
  return <pre className="qdd-raw" data-wrap={wrap} tabIndex={0} aria-label={t('documentDetail:rawHit')}>{formatted}</pre>;
}

function DetailBody({ detail, stale, endpointChanged, partial, wrapJson }: Omit<Props, 'result' | 'onClose'> & { detail: DocumentDetail }) {
  const { t } = useTranslation();
  const [view, setView] = useState<'fields' | 'json'>('fields');
  const [section, setSection] = useState<LoadedDocumentSection | 'all'>('all');
  const [search, setSearch] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['/_source', '/fields']));
  const copy = useCopyText(JSON.stringify([detail.origin.requestId, detail.document.pageIndex, detail.document.position]));
  const filtered = useMemo(() => visibleDocumentFields(detail.rows, section, search, expanded), [detail, section, search, expanded]);
  const containers = useMemo(() => detail.rows.filter((row) => row.childCount > 0), [detail]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / DOCUMENT_DETAIL_PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount - 1);
  const rows = filtered.slice(page * DOCUMENT_DETAIL_PAGE_SIZE, (page + 1) * DOCUMENT_DETAIL_PAGE_SIZE);
  const source = detail.rows.find((row) => row.path === '/_source');
  const fields = detail.rows.find((row) => row.path === '/fields');
  const documentText = source && source.range !== null ? documentFieldValue(detail, source)
    : fields ? documentFieldValue(detail, fields) : null;
  const origin = detail.origin;
  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  return <div className="qdd-root">
    <details className="qdd-origin">
      <summary>{t('documentDetail:execution')}: <bdi>{origin.index}</bdi></summary>
      <dl>
        <dt>{t('documentDetail:connection')}</dt><dd>{origin.connectionId}</dd>
        <dt>{t('documentDetail:endpoint')}</dt><dd>{origin.endpoint ?? t('documentDetail:notRecorded')}</dd>
        <dt>{t('documentDetail:target')}</dt><dd>{origin.index}</dd>
        <dt>{t('documentDetail:execution')}</dt><dd>{origin.requestId}</dd>
        <dt>{t('documentDetail:startedAt')}</dt><dd>{origin.startedAt}</dd>
      </dl>
    </details>
    <p className="qdd-receipt">{t('documentDetail:receipt', { page: detail.document.pageIndex + 1, row: detail.document.position + 1 })}</p>
    {stale ? <p className="qdd-warning" role="status">{t('queryLive:staleResult')}</p> : null}
    {endpointChanged ? <p className="qdd-warning" role="status">{t('queryLive:endpointChanged')}</p> : null}
    {partial || detail.document.partial ? <p className="qdd-warning" role="status">{t('documentDetail:partial')}</p> : null}
    <div className="qdd-toolbar">
      <div className="segment" role="group" aria-label={t('documentDetail:view')}>
        {(['fields', 'json'] as const).map((value) => <button type="button" key={value} aria-pressed={view === value}
          onClick={() => setView(value)}>{t(`documentDetail:view_${value}`)}</button>)}
      </div>
      {view === 'fields' ? <label className="qdd-search"><Search size={14} aria-hidden="true" />
        <input type="search" value={search} maxLength={MAX_DOCUMENT_DETAIL_SEARCH_LENGTH} aria-label={t('documentDetail:search')}
          placeholder={t('documentDetail:search')} onChange={(event) => { setSearch(event.target.value); setPageIndex(0); }} />
      </label> : null}
    </div>
    {view === 'fields' ? <>
      <div className="qdd-toolbar">
        <div className="segment" role="group" aria-label={t('documentDetail:section')}>
          {(['all', 'source', 'fields', 'metadata'] as const).map((value) => <button type="button" key={value}
            aria-pressed={section === value} onClick={() => { setSection(value); setPageIndex(0); }}>
            {t(`documentDetail:section_${value}`)}
          </button>)}
        </div>
        <div className="qdd-fold-tools">
          <IconButton icon={UnfoldVertical} label={t('documentDetail:expandAll')}
            disabled={search !== '' || containers.every((row) => expanded.has(row.path))}
            onClick={() => { setExpanded(new Set(containers.map((row) => row.path))); setPageIndex(0); }} />
          <IconButton icon={FoldVertical} label={t('documentDetail:collapseAll')}
            disabled={search !== '' || containers.every((row) => !expanded.has(row.path))}
            onClick={() => { setExpanded(new Set()); setPageIndex(0); }} />
        </div>
      </div>
      <div className="qdd-scroll" role="region" aria-label={t('documentDetail:table')} tabIndex={0}>
        <table className="qdd-table">
          <colgroup><col className="qdd-path-column" /><col className="qdd-kind-column" /><col /></colgroup>
          <thead><tr><th scope="col">{t('documentDetail:path')}</th><th scope="col">{t('documentDetail:kind')}</th>
            <th scope="col">{t('documentDetail:value')}</th></tr></thead>
          <tbody>{rows.map((row) => {
            const raw = row.childCount > 0 ? null : documentFieldValue(detail, row);
            return <tr key={row.path} data-path={row.path} data-runtime={row.runtime} data-kind={row.kind}>
              <th scope="row">
                <div className="qdd-path-tools" style={{ paddingInlineStart: Math.min(row.depth, 5) * 8 }}>
                  {row.childCount > 0 && search === '' ? <IconButton icon={expanded.has(row.path) ? ChevronDown : ChevronRight}
                    label={t(expanded.has(row.path) ? 'documentDetail:collapse' : 'documentDetail:expand', { path: row.path })}
                    aria-expanded={expanded.has(row.path)} onClick={() => toggle(row.path)} />
                    : <span className="qdd-disclosure-space" aria-hidden="true" />}
                  <code className="qdd-path" tabIndex={0}>{row.path}</code>
                  <IconButton icon={Copy} label={t('documentDetail:copyPath', { path: row.path })} onClick={() => copy.copy(row.path)} />
                </div>
                <span className="qdd-source">{t(row.runtime ? 'documentDetail:runtimeSource' : `documentDetail:section_${row.section}`)}</span>
              </th>
              <td className="qdd-kind">{t(`documentDetail:kind_${row.kind}`)}</td>
              <td>
                <div className="qdd-value-tools">
                  <IconButton icon={Copy} label={t('documentDetail:copyValue', { path: row.path })} disabled={row.range === null}
                    onClick={() => { const value = documentFieldValue(detail, row); if (value !== null) copy.copy(value); }} />
                </div>
                {row.childCount > 0 ? <span className="qdd-container">{t('documentDetail:children', { count: row.childCount })}</span>
                  : raw === null ? <span className="qdd-missing">{t('documentDetail:notReturned')}</span>
                  : <pre className="qdd-value" tabIndex={0} aria-label={t('documentDetail:fieldValue', { path: row.path })}>{raw}</pre>}
              </td>
            </tr>;
          })}</tbody>
        </table>
        {rows.length === 0 ? <p className="qdd-empty">{t('documentDetail:noMatches')}</p> : null}
      </div>
    </> : <RawDocument raw={detail.document.raw} wrap={wrapJson} />}
    <div className="qdd-footer">
      {view === 'fields' ? <span role="status">{t('documentDetail:shown', { shown: filtered.length, total: detail.rows.length })}</span> : null}
      {view === 'fields' && pageCount > 1 ? <div className="qdd-pager">
        <IconButton icon={ChevronLeft} label={t('documentDetail:previousPage')} disabled={page <= 0} onClick={() => setPageIndex(page - 1)} />
        <span>{t('resultGrid:pageLabel', { page: page + 1, total: pageCount })}</span>
        <IconButton icon={ChevronRight} label={t('documentDetail:nextPage')} disabled={page >= pageCount - 1} onClick={() => setPageIndex(page + 1)} />
      </div> : null}
    </div>
    <div className="qdd-footer qdd-copy-actions">
      {copy.status !== 'idle' ? <span className={`ql-copy-note ${copy.status === 'failed' ? 'failed' : 'done'}`} role="status">
        {t(copy.status === 'failed' ? 'queryLive:copyFailed' : 'queryLive:copied')}
      </span> : null}
      <div className="qdd-copy-tools">
        <IconButton icon={Copy} label={t('queryLive:copyDocument')} disabled={documentText === null}
          onClick={() => { if (documentText !== null) copy.copy(documentText); }} />
        <IconButton icon={FileJson} label={t('documentDetail:copyHit')} onClick={() => copy.copy(detail.document.raw)} />
        <IconButton icon={Copy} label={t('queryLive:copyResponse')} onClick={() => copy.copy(detail.rawResponse)} />
      </div>
    </div>
  </div>;
}

export function DocumentDetailDialog({ result, onClose, ...context }: Props) {
  const { t } = useTranslation();
  const id: string | null = result.ok && result.detail.document.id.kind === 'string'
    ? JSON.parse(result.detail.document.id.raw!) as string : null;
  const title = id === null ? t('documentDetail:title')
    : t('queryLive:documentDetail', { id: id.length > 160 ? `${id.slice(0, 160)}...` : id });
  return <Modal open onClose={onClose} title={title} description={t('documentDetail:scope')}>
    {result.ok ? <DetailBody detail={result.detail} {...context} />
      : <div className="qdd-root"><p className="qdd-error" role="alert">{t(`documentDetail:error_${result.code}`)}</p></div>}
  </Modal>;
}
