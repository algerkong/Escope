import { ChartColumn, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, SelectControl } from '../../components/controls';
import { AGGREGATION_LIMITS, readAggregationPage, type AggregationResult, type AggregationValue } from '../../domain/query-aggregations';
import type { ExecutionSnapshot } from '../../domain/query';
import type { ExecutionPage } from './useQueryExecutions';
import { AggregationChart, type AggregationChartScope } from './charts/AggregationChart';
import { useCopyText } from './useCopyText';
import '../../styles/query-aggregations.css';

interface Props {
  snapshot: ExecutionSnapshot;
  endpoint: string | null;
  pages: readonly ExecutionPage[];
  wrapJson: boolean;
}

type CopyText = (raw: string) => void;

function RawText({ label, raw, copyLabel, onCopy, wrap, limit = AGGREGATION_LIMITS.responseBytes }: {
  label: string; raw: string; copyLabel: string; onCopy: CopyText; wrap: boolean; limit?: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details className="qa-raw" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open ? <>
      <div className="qa-raw-actions"><IconButton icon={Copy} label={copyLabel} onClick={() => onCopy(raw)} /></div>
      {raw.length <= limit && new TextEncoder().encode(raw).length <= limit
        ? <pre className="ql-pre" data-wrap={wrap} aria-label={label}>{raw}</pre>
        : <p className="qa-warning" role="status">{t('queryAggregations:rawTooLarge')}</p>}
    </> : null}
  </details>;
}

function Value({ value, label, onCopy }: { value: AggregationValue; label: string; onCopy?: CopyText }) {
  const { t } = useTranslation();
  return <span className="qa-value" data-kind={value.kind}>
    <code aria-label={label}>{value.raw ?? t('queryAggregations:notReturned')}</code>
    {onCopy ? <IconButton icon={Copy} label={t('queryAggregations:copyValue', { name: label })}
      disabled={value.raw === null} onClick={() => { if (value.raw !== null) onCopy(value.raw); }} /> : null}
  </span>;
}

function MetricNote({ type }: { type: string }) {
  const { t } = useTranslation();
  return type === 'cardinality' || type === 'value_count'
    ? <span className="qa-metric-note">{t(`queryAggregations:${type === 'cardinality' ? 'approximate' : 'valueCount'}`)}</span> : null;
}

function BucketTable({ entry, onCopy }: { entry: Extract<AggregationResult, { status: 'buckets' }>; onCopy: CopyText }) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const from = pageIndex * AGGREGATION_LIMITS.pageSize;
  const rows = entry.buckets.slice(from, from + AGGREGATION_LIMITS.pageSize);
  const keyed = entry.buckets.some((bucket) => bucket.member !== null);
  const label = (name: string, row: number) => t('queryAggregations:bucketValue', { name, row });
  return <>
    <p className="qa-scope">{t(`queryAggregations:${entry.type === 'terms' ? 'termsScope' : 'histogramScope'}`)}</p>
    {entry.type === 'terms' ? <>
      <dl className="qa-metadata">
        <dt>{t('queryAggregations:errorBound')}</dt><dd><Value value={entry.docCountError} label={t('queryAggregations:errorBound')} onCopy={onCopy} />
          {entry.docCountError.kind === 'missing' || entry.docCountError.raw === '-1'
            ? <span className="qa-warning">{t(`queryAggregations:${entry.docCountError.kind === 'missing' ? 'errorNotReported' : 'unknownError'}`)}</span> : null}</dd>
        <dt>{t('queryAggregations:otherCount')}</dt><dd><Value value={entry.sumOtherDocCount} label={t('queryAggregations:otherCount')} onCopy={onCopy} />
          {entry.sumOtherDocCount.raw !== null && BigInt(entry.sumOtherDocCount.raw) > 0n
            ? <span className="qa-warning">{t('queryAggregations:omittedBuckets')}</span> : null}</dd>
      </dl>
    </> : null}
    {entry.options.length > 0 ? <dl className="qa-metadata" aria-label={t('queryAggregations:requestOptions')}>
      {entry.options.map(({ name, raw }) => <div className="qa-option" key={name}><dt>{name}</dt><dd><code>{raw}</code></dd></div>)}
    </dl> : null}
    {entry.buckets.length === 0 ? <p className="qa-scope">{t('queryAggregations:noBuckets')}</p> : <>
      <div className="qa-table-scroll" role="region" aria-label={t('queryAggregations:table')} tabIndex={0}>
        <table className="qa-table">
          <thead><tr>
            <th scope="col">#</th>
            {keyed ? <th scope="col">{t('queryAggregations:keyedMember')}</th> : null}
            <th scope="col">{t('queryAggregations:key')}</th><th scope="col">{t('queryAggregations:keyAsString')}</th>
            <th scope="col">{t('queryAggregations:docCount')}</th>
            {entry.type === 'terms' ? <th scope="col">{t('queryAggregations:bucketError')}</th> : null}
            {entry.metrics.map(({ name, type }) => <th scope="col" key={name}>
              <span>{t('queryAggregations:metricColumn', { name, type })}</span><MetricNote type={type} />
            </th>)}
            <th scope="col"><span className="sr-only">{t('queryAggregations:rawAggregation')}</span></th>
          </tr></thead>
          <tbody>{rows.map((bucket, position) => {
            const row = from + position + 1;
            return <tr key={row}>
              <td>{row}</td>{keyed ? <td><code>{bucket.member}</code></td> : null}
              <td><Value value={bucket.key} label={label('key', row)} onCopy={onCopy} /></td>
              <td><Value value={bucket.keyAsString} label={label('key_as_string', row)} /></td>
              <td><Value value={bucket.docCount} label={label('doc_count', row)} onCopy={onCopy} /></td>
              {entry.type === 'terms' ? <td><Value value={bucket.docCountError} label={label('doc_count_error_upper_bound', row)} />
                {bucket.docCountError.raw === '-1' ? <span className="qa-warning">{t('queryAggregations:unknownError')}</span> : null}</td> : null}
              {bucket.metrics.map((metric) => <td key={metric.name}>
                <Value value={metric.value} label={label(metric.name, row)} onCopy={onCopy} />
                {metric.valueAsString.kind !== 'missing' ? <Value value={metric.valueAsString}
                  label={label(`${metric.name}.value_as_string`, row)} /> : null}
              </td>)}
              <td><IconButton icon={Copy} label={t('queryAggregations:copyBucket', { row })} onClick={() => onCopy(bucket.raw)} /></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="qa-pagination">
        <span>{t('queryAggregations:bucketRange', { from: from + 1, to: from + rows.length, total: entry.buckets.length })}</span>
        <IconButton icon={ChevronLeft} label={t('queryAggregations:previousPage')} disabled={pageIndex === 0}
          onClick={() => setPageIndex((page) => page - 1)} />
        <IconButton icon={ChevronRight} label={t('queryAggregations:nextPage')}
          disabled={from + rows.length >= entry.buckets.length} onClick={() => setPageIndex((page) => page + 1)} />
      </div>
    </>}
  </>;
}

function Entry({ entry, scope, onCopy, wrapJson }: {
  entry: AggregationResult; scope: AggregationChartScope; onCopy: CopyText; wrapJson: boolean;
}) {
  const { t } = useTranslation();
  const [chartOpen, setChartOpen] = useState(false);
  return <div className="qa-entry">
    <div className="qa-entry-title"><h3>{entry.name}</h3>
      {entry.type !== null ? <code>{entry.type}</code> : null}
      <MetricNote type={entry.type ?? ''} />
      <span className="qa-entry-actions">
        <IconButton icon={ChartColumn} aria-pressed={chartOpen} onClick={() => setChartOpen((open) => !open)}
          label={t(chartOpen ? 'queryAggregationCharts:close' : 'queryAggregationCharts:open')} />
      </span>
    </div>
    {chartOpen ? <AggregationChart entry={entry} scope={scope} /> : null}
    {entry.status === 'metric' ? <dl className="qa-metadata">
      <dt>{t('queryAggregations:originalValue')}</dt><dd><Value value={entry.metric.value} label={entry.name} onCopy={onCopy} /></dd>
      {entry.metric.valueAsString.kind !== 'missing' ? <>
        <dt>{t('queryAggregations:returnedString')}</dt>
        <dd><Value value={entry.metric.valueAsString} label={`${entry.name}.value_as_string`} onCopy={onCopy} /></dd>
      </> : null}
    </dl> : entry.status === 'buckets' ? <BucketTable entry={entry} onCopy={onCopy} />
      : <p className="qa-warning" role="status">{t(`queryAggregations:status_${entry.status}`)}</p>}
    {entry.rawDefinition !== null ? <RawText raw={entry.rawDefinition} label={t('queryAggregations:rawDefinition')}
      copyLabel={t('queryAggregations:copyDefinition')} onCopy={onCopy} wrap={wrapJson} limit={AGGREGATION_LIMITS.dslBytes} /> : null}
    {entry.rawResponse !== null ? <RawText raw={entry.rawResponse} label={t('queryAggregations:rawAggregation')}
      copyLabel={t('queryAggregations:copyAggregation')} onCopy={onCopy} wrap={wrapJson} /> : null}
  </div>;
}

/** Mounted only for the session-local aggregation view. A newer received page never replaces a selected one. */
export function QueryAggregations({ snapshot, endpoint, pages, wrapJson }: Props) {
  const { t } = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const [name, setName] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const page = pages[pageIndex];
  const result = useMemo(() => page ? readAggregationPage(snapshot.rawDsl, page.rawResponse) : null, [snapshot.rawDsl, page]);
  const entry = result?.ok ? result.entries.find((item) => item.name === name) ?? result.entries[0] : undefined;
  const copy = useCopyText(JSON.stringify([snapshot.queryId, snapshot.requestId, pageIndex, entry?.name]));
  const onCopy: CopyText = (raw) => { void copy.copy(raw); };
  // Chart annotation only: the frozen target, the plotted page and that page's own limitations.
  const chartScope: AggregationChartScope = {
    target: snapshot.index, page: pageIndex + 1, bounds: snapshot.timeRange?.bounds ?? null,
    limited: Boolean(page?.partial) || Boolean(result?.ok && result.notices.length > 0),
  };
  return <section className="qa-results" aria-label={t('queryAggregations:title')}>
    <p className="qa-scope">{t('queryAggregations:scope')}</p>
    <div className="qa-selectors">
      <label>{t('queryAggregations:receivedPage')}<SelectControl value={pageIndex} onChange={(event) => {
        setPageIndex(Number(event.currentTarget.value)); setName(null);
      }}>{pages.map((_, position) => <option key={position} value={position}>
        {t('queryAggregations:pageOption', { page: position + 1 })}
      </option>)}</SelectControl></label>
      {result?.ok && result.entries.length > 0 ? <label>{t('queryAggregations:selected')}
        <SelectControl value={entry?.name ?? ''} onChange={(event) => setName(event.currentTarget.value)}>
          {result.entries.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </SelectControl>
      </label> : null}
      {page ? <IconButton icon={Copy} label={t('queryAggregations:copyPage')} onClick={() => onCopy(page.rawResponse)} /> : null}
    </div>
    {pages.length > 1 ? <p className="qa-scope">{t('queryAggregations:independentPages')}</p> : null}
    <details className="qa-source" onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
      <summary>{t('queryAggregations:source')}</summary>
      {sourceOpen ? <dl className="qa-metadata">
        {([
          ['documentDetail:execution', snapshot.requestId], ['documentDetail:connection', snapshot.connectionId],
          ['documentDetail:endpoint', endpoint ?? t('documentDetail:notRecorded')], ['documentDetail:target', snapshot.index],
          ['documentDetail:startedAt', snapshot.startedAt],
        ] as const).map(([key, value]) => <div className="qa-option" key={key}><dt>{t(key)}</dt><dd><code>{value}</code></dd></div>)}
      </dl> : null}
    </details>
    <div className="qa-copy-status" role="status">
      {copy.status !== 'idle' ? <span className={`ql-copy-note ${copy.status === 'failed' ? 'failed' : 'done'}`}>
        {t(`queryLive:${copy.status === 'failed' ? 'copyFailed' : 'copied'}`)}</span> : null}
    </div>
    {page?.partial ? <p className="qa-warning" role="status">{t('queryAggregations:partial')}</p> : null}
    {result?.ok ? <>
      {result.notices.length > 0 ? <ul className="qa-notices">{result.notices.map((notice) =>
        <li key={notice}>{t(`queryAggregations:notice_${notice}`)}</li>)}</ul> : null}
      {result.responseState !== 'present' ? <p className="qa-scope">{t(`queryAggregations:${result.responseState === 'empty' ? 'responseEmpty' : 'responseMissing'}`)}</p> : null}
      {entry ? <Entry key={JSON.stringify([pageIndex, entry.name])} entry={entry} scope={chartScope}
        onCopy={onCopy} wrapJson={wrapJson} />
        : <p className="qa-scope">{t('queryAggregations:noAggregations')}</p>}
    </> : result ? <p className="qa-warning" role="alert">{t(`queryAggregations:error_${result.code}`)}</p> : null}
    <RawText key={`dsl-${pageIndex}`} raw={snapshot.rawDsl} label={t('queryAggregations:rawDsl')}
      copyLabel={t('queryAggregations:copyDsl')} onCopy={onCopy} wrap={wrapJson} limit={AGGREGATION_LIMITS.dslBytes} />
    {page ? <RawText key={`page-${pageIndex}`} raw={page.rawResponse} label={t('queryAggregations:rawPage')}
      copyLabel={t('queryAggregations:copyPage')} onCopy={onCopy} wrap={wrapJson} /> : null}
  </section>;
}
