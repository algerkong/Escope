import { ArrowLeftRight, ChevronLeft, ChevronRight, Copy, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Modal } from '../../components/controls';
import {
  COMPARISON_PAGE_SIZE, isComparisonDifference,
  type ComparedDocument, type ComparisonSection, type ComparisonStatus, type ComparisonValue,
  type DocumentComparison, type DocumentComparisonResult,
} from '../../domain/document-comparison';
import { useCopyText } from './useCopyText';
import '../../styles/document-comparison.css';

interface Props {
  result: DocumentComparisonResult;
  stale: boolean;
  endpointChanged: boolean;
  partial: boolean;
  onClose: () => void;
}

function ComparisonBody({ comparison, stale, endpointChanged, partial }: Omit<Props, 'result' | 'onClose'> & { comparison: DocumentComparison }) {
  const { t } = useTranslation();
  const [swapped, setSwapped] = useState(false);
  const [section, setSection] = useState<ComparisonSection | 'all'>('all');
  const [search, setSearch] = useState('');
  const [differencesOnly, setDifferencesOnly] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  const copy = useCopyText(comparison.origin.requestId);
  const filtered = useMemo(() => {
    const needle = search.toLowerCase();
    return comparison.rows.filter((row) => (section === 'all' || row.section === section)
      && (!differencesOnly || isComparisonDifference(row.status))
      && (row.field ?? (row.section === 'source' ? '_source' : 'fields')).toLowerCase().includes(needle));
  }, [comparison, section, search, differencesOnly]);
  const counts = useMemo(() => ({
    changed: comparison.rows.filter((row) => isComparisonDifference(row.status)).length,
    equal: comparison.rows.filter((row) => row.status === 'equal').length,
    unavailable: comparison.rows.filter((row) => row.status === 'unavailable').length,
  }), [comparison]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / COMPARISON_PAGE_SIZE));
  const page = Math.min(pageIndex, pageCount - 1);
  const rows = filtered.slice(page * COMPARISON_PAGE_SIZE, (page + 1) * COMPARISON_PAGE_SIZE);
  const left = swapped ? comparison.right : comparison.left;
  const right = swapped ? comparison.left : comparison.right;
  const origin = comparison.origin;
  const valueText = (value: ComparisonValue) => value.raw ?? t('documentComparison:notReturned');
  const sideLabel = (side: 'left' | 'right') => t(`documentComparison:${side}`);
  const statusOf = (status: ComparisonStatus) => !swapped ? status
    : status === 'leftOnly' ? 'rightOnly' : status === 'rightOnly' ? 'leftOnly' : status;

  const documentHeading = (document: ComparedDocument, side: 'left' | 'right') => <section
    className="qdc-document" aria-label={sideLabel(side)}>
    <div className="qdc-document-heading"><h3>{sideLabel(side)}</h3>
      <IconButton icon={Copy} label={t(`documentComparison:copy_${side}`)} onClick={() => copy.copy(document.raw)} />
    </div>
    <dl>
      <dt>_index</dt><dd tabIndex={0}>{valueText(document.index)}</dd>
      <dt>_id</dt><dd tabIndex={0}>{valueText(document.id)}</dd>
    </dl>
    <span className="qdc-receipt">{t('documentComparison:receipt', { page: document.pageIndex + 1, row: document.position + 1 })}</span>
  </section>;

  const cell = (value: ComparisonValue, side: 'left' | 'right', field: string, source: string) => <td>
    <div className="qdc-value-tools"><span>{t(`documentComparison:kind_${value.kind}`)}</span>
      <IconButton icon={Copy} label={t('documentComparison:copyValue', { side: sideLabel(side), field, source })}
        disabled={value.raw === null} onClick={() => { if (value.raw !== null) copy.copy(value.raw); }} />
    </div>
    {value.raw === null ? <span className="qdc-missing">{t('documentComparison:notReturned')}</span>
      : <pre className="qdc-value" tabIndex={0}
        aria-label={t('documentComparison:value', { side: sideLabel(side), field, source })}>{value.raw}</pre>}
  </td>;

  return <div className="qdc-root">
    <details className="qdc-origin">
      <summary>{t('documentComparison:execution')}: <bdi>{origin.index}</bdi></summary>
      <dl>
        <dt>{t('documentComparison:connection')}</dt><dd>{origin.connectionId}</dd>
        <dt>{t('documentComparison:endpoint')}</dt><dd>{origin.endpoint ?? t('documentComparison:notRecorded')}</dd>
        <dt>{t('documentComparison:target')}</dt><dd>{origin.index}</dd>
        <dt>{t('documentComparison:execution')}</dt><dd>{origin.requestId}</dd>
        <dt>{t('documentComparison:startedAt')}</dt><dd>{origin.startedAt}</dd>
      </dl>
    </details>
    {stale ? <p className="qdc-warning" role="status">{t('queryLive:staleResult')}</p> : null}
    {endpointChanged ? <p className="qdc-warning" role="status">{t('queryLive:endpointChanged')}</p> : null}
    {partial || left.partial || right.partial ? <p className="qdc-warning" role="status">{t('documentComparison:partial')}</p> : null}
    <div className="qdc-documents">{documentHeading(left, 'left')}{documentHeading(right, 'right')}</div>
    <div className="qdc-toolbar">
      <div className="segment" role="group" aria-label={t('documentComparison:section')}>
        {(['all', 'source', 'fields', 'metadata'] as const).map((value) => <button type="button" key={value}
          aria-pressed={section === value} onClick={() => { setSection(value); setPageIndex(0); }}>
          {t(`documentComparison:section_${value}`)}
        </button>)}
      </div>
      <IconButton icon={ArrowLeftRight} label={t('documentComparison:swap')} onClick={() => setSwapped((value) => !value)} />
      <label className="qdc-differences"><input type="checkbox" checked={differencesOnly}
        onChange={(event) => { setDifferencesOnly(event.target.checked); setPageIndex(0); }} />
        {t('documentComparison:differencesOnly')}</label>
      <label className="qdc-search"><Search size={14} aria-hidden="true" />
        <input type="search" value={search} maxLength={1024} aria-label={t('documentComparison:search')}
          placeholder={t('documentComparison:search')}
          onChange={(event) => { setSearch(event.target.value); setPageIndex(0); }} />
      </label>
    </div>
    <p className="qdc-summary" role="status">{t('documentComparison:summary', counts)}</p>
    <div className="qdc-scroll" role="region" aria-label={t('documentComparison:table')} tabIndex={0}>
      <table className="qdc-table">
        <colgroup><col className="qdc-field-column" /><col /><col /></colgroup>
        <thead><tr><th scope="col">{t('documentComparison:field')}</th>
          <th scope="col">{sideLabel('left')}</th><th scope="col">{sideLabel('right')}</th></tr></thead>
        <tbody>{rows.map((row) => {
          const field = row.field ?? (row.section === 'source' ? '_source' : 'fields');
          const source = t(`documentComparison:section_${row.section}`);
          const status = statusOf(row.status);
          return <tr key={row.key} data-status={status}>
            <th scope="row">
              <span className="qdc-field-name" tabIndex={0}>{row.field === null ? field : JSON.stringify(field)}</span>
              <span className="qdc-source">{row.runtime ? t('documentComparison:runtimeSource') : source}</span>
              <span className="qdc-status">{t(`documentComparison:status_${status}`)}</span>
            </th>
            {cell(swapped ? row.right : row.left, 'left', field, source)}
            {cell(swapped ? row.left : row.right, 'right', field, source)}
          </tr>;
        })}</tbody>
      </table>
      {rows.length === 0 ? <p className="qdc-empty">{t(search ? 'documentComparison:noMatches' : 'documentComparison:noDifferences')}</p> : null}
    </div>
    <div className="qdc-footer">
      <span>{t('documentComparison:shown', { count: filtered.length })}</span>
      {copy.status !== 'idle' ? <span className={`ql-copy-note ${copy.status === 'failed' ? 'failed' : 'done'}`} role="status">
        {t(copy.status === 'failed' ? 'queryLive:copyFailed' : 'queryLive:copied')}
      </span> : null}
      {pageCount > 1 ? <div className="qdc-pager">
        <IconButton icon={ChevronLeft} label={t('documentComparison:previousPage')} disabled={page <= 0}
          onClick={() => setPageIndex(page - 1)} />
        <span>{t('resultGrid:pageLabel', { page: page + 1, total: pageCount })}</span>
        <IconButton icon={ChevronRight} label={t('documentComparison:nextPage')} disabled={page >= pageCount - 1}
          onClick={() => setPageIndex(page + 1)} />
      </div> : null}
    </div>
  </div>;
}

export function DocumentComparisonDialog({ result, onClose, ...context }: Props) {
  const { t } = useTranslation();
  return <Modal open onClose={onClose} title={t('documentComparison:title')} description={t('documentComparison:scope')}>
    {result.ok ? <ComparisonBody comparison={result.comparison} {...context} />
      : <div className="qdc-root"><p className="qdc-error" role="alert">{t(`documentComparison:error_${result.code}`)}</p></div>}
  </Modal>;
}
