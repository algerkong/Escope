import { LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, SelectControl } from '../../../components/controls';
import {
  CHART_LIMITS, DOC_COUNT_MEASURE, buildAggregationChart, chartMeasures,
  type ChartMeasure, type ChartSkipped,
} from '../../../domain/query-aggregation-charts';
import type { AggregationResult } from '../../../domain/query-aggregations';
import type { TimeRangeBounds } from '../../../domain/query-time-range';
import { loadAggregationChart, type AggregationChartRuntime } from './chart-loader';
import '../../../styles/query-aggregation-charts.css';

export interface AggregationChartScope {
  /** Frozen execution target, never the current editor target. */
  readonly target: string;
  /** 1-based received page this chart plots; pages are never combined. */
  readonly page: number;
  /** Frozen absolute bounds of a managed time range, rendered verbatim. */
  readonly bounds: TimeRangeBounds | null;
  /** The plotted page reported partial results, a timeout, shard failures or a limited scope. */
  readonly limited: boolean;
}

interface Props {
  entry: AggregationResult;
  scope: AggregationChartScope;
}

/**
 * Session-local chart of one aggregation entry of one received page. The plot model is rebuilt
 * from the already bounded reader output, so a refused value is reported instead of drawn as zero,
 * and nothing here queries, reorders buckets or persists a chart definition.
 */
export function AggregationChart({ entry, scope }: Props) {
  const { t } = useTranslation();
  const [measure, setMeasure] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<AggregationChartRuntime | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const result = useMemo(() => buildAggregationChart(entry, measure), [entry, measure]);
  const measures = useMemo(() => chartMeasures(entry), [entry]);
  const selected = result.ok ? result.chart.measure : measures.find((item) => item.name === measure) ?? null;
  const needsCanvas = result.ok && result.chart.kind !== 'singleValue';
  const skipped: readonly ChartSkipped[] = result.ok ? result.chart.skipped : 'skipped' in result ? result.skipped : [];

  useEffect(() => {
    if (!needsCanvas) return;
    let disposed = false;
    setFailed(false);
    setRuntime(null);
    try {
      const loading = loadAggregationChart();
      if (loading instanceof Promise) {
        void loading.then((value) => { if (!disposed) setRuntime(value); }, () => { if (!disposed) setFailed(true); });
      } else setRuntime(loading);
    } catch {
      setFailed(true);
    }
    return () => { disposed = true; };
  }, [needsCanvas, attempt]);

  const measureText = (item: ChartMeasure | null) => item === null ? '' : item.type === DOC_COUNT_MEASURE
    ? t('queryAggregationCharts:measureDocCount')
    : t('queryAggregationCharts:measureMetric', { name: item.name, type: item.type });
  const summary = result.ok ? t(`queryAggregationCharts:summary_${result.chart.kind}`, {
    name: result.chart.aggregation, measure: measureText(result.chart.measure), target: scope.target,
    page: scope.page, plotted: result.chart.plotted, buckets: result.chart.buckets,
  }) : '';

  return <div className="qac-panel">
    <ul className="qac-scope" aria-label={t('queryAggregationCharts:scope')}>
      <li><span>{t('documentDetail:target')}</span><code>{scope.target}</code></li>
      <li><span>{t('queryAggregations:receivedPage')}</span>{t('queryAggregations:pageOption', { page: scope.page })}</li>
      {selected ? <li><span>{t('queryAggregationCharts:measure')}</span>{measureText(selected)}</li> : null}
      {result.ok && result.chart.kind !== 'singleValue' ? <li>
        <span>{t('queryAggregationCharts:plotted')}</span>
        {t('queryAggregationCharts:plottedOf', { plotted: result.chart.plotted, buckets: result.chart.buckets })}
      </li> : null}
      {scope.bounds ? <li><span>{t('queryAggregationCharts:frozenRange')}</span>
        <code>{scope.bounds.from}</code><code>{scope.bounds.to}</code></li> : null}
    </ul>
    {measures.length > 1 ? <label className="qac-measure">{t('queryAggregationCharts:measure')}
      <SelectControl value={measure ?? DOC_COUNT_MEASURE} onChange={(event) => setMeasure(event.currentTarget.value)}>
        {measures.map((item) => <option key={item.name} value={item.name}>{measureText(item)}</option>)}
      </SelectControl>
    </label> : null}
    {result.ok && result.chart.notices.length > 0 ? <ul className="qac-notices">
      {result.chart.notices.map((notice) => <li key={notice}>{notice === 'imprecise'
        ? t('queryAggregationCharts:notice_imprecise', { count: result.chart.impreciseCount })
        : t(`queryAggregationCharts:notice_${notice}`)}</li>)}
    </ul> : null}
    {scope.limited ? <p className="qac-warning">{t('queryAggregationCharts:pageLimits')}</p> : null}
    {result.ok ? (result.chart.kind === 'singleValue'
      ? <p className="qac-single" role="group" aria-label={summary}><code>{result.chart.single.raw}</code>
        {result.chart.single.precise ? null
          : <span className="qac-warning">{t('queryAggregationCharts:plottedAs',
            { raw: result.chart.single.raw, value: result.chart.single.value })}</span>}
      </p>
      : failed ? <div className="notice error" role="alert"><TriangleAlert size={16} aria-hidden="true" />
        <span>{t('queryAggregationCharts:loadFailed')}</span>
        <IconButton icon={RotateCw} label={t('retry')} onClick={() => setAttempt((value) => value + 1)} /></div>
      : runtime === null ? <p className="qac-state" role="status">
        <LoaderCircle className="spin" size={14} aria-hidden="true" />{t('queryAggregationCharts:loading')}</p>
      : <runtime.AggregationChartCanvas chart={result.chart} label={summary} />)
      : <p className="qac-warning" role="status">{t(`queryAggregationCharts:error_${result.code}`,
        { buckets: 'buckets' in result ? result.buckets : 0, limit: CHART_LIMITS.buckets })}</p>}
    {skipped.length > 0 ? <div className="qac-skipped">
      <p>{t('queryAggregationCharts:skippedCount', { count: skipped.length })}</p>
      <ul>{skipped.slice(0, CHART_LIMITS.listedSkipped).map((item) => <li key={item.row}>
        <span>{t('queryAggregationCharts:skipRow', { row: item.row })}</span>
        <code>{item.label}</code>
        <span>{t(`queryAggregationCharts:skipField_${item.field}`)}</span>
        <code>{item.raw ?? t('queryAggregations:notReturned')}</code>
        <span className="qac-warning">{t(`queryAggregationCharts:reason_${item.reason}`)}</span>
      </li>)}
      {skipped.length > CHART_LIMITS.listedSkipped ? <li className="qac-skipped-more">
        {t('queryAggregationCharts:skippedMore', { count: skipped.length - CHART_LIMITS.listedSkipped })}</li> : null}
      </ul>
    </div> : null}
    <p className="qac-display-note">{t('queryAggregationCharts:displayOnly')}</p>
  </div>;
}
