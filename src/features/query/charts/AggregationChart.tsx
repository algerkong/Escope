import { LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, SelectControl, Toggle } from '../../../components/controls';
import {
  CHART_LIMITS, DOC_COUNT_MEASURE, buildAggregationChart, chartMeasures,
  type ChartMeasure, type ChartNotice, type ChartSkipped,
} from '../../../domain/query-aggregation-charts';
import type { AggregationResult } from '../../../domain/query-aggregations';
import type { TimeRangeBounds } from '../../../domain/query-time-range';
import { loadAggregationChart, type AggregationChartRuntime } from './chart-loader';
import { AggregationChartReferences } from './AggregationChartReferences';
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
  onMeasureChange?: (measure: string) => void;
}

/** Bucket selection and key caveats belong to both measures, not to either value axis. */
const SHARED_NOTICES: ReadonlySet<ChartNotice> = new Set([
  'bucketStarts', 'termsScope', 'errorUnknown', 'errorNotReported', 'omittedBuckets',
]);

/**
 * Session-local chart of one aggregation entry of one received page. The plot model is rebuilt
 * from the already bounded reader output, so a refused value is reported instead of drawn as zero,
 * and nothing here queries, reorders buckets or persists a chart definition.
 */
export function AggregationChart({ entry, scope, onMeasureChange }: Props) {
  const { t } = useTranslation();
  const controls = useId();
  const [measure, setMeasure] = useState<string | null>(null);
  const [secondary, setSecondary] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<AggregationChartRuntime | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const result = useMemo(() => buildAggregationChart(entry, measure, secondary), [entry, measure, secondary]);
  const measures = useMemo(() => chartMeasures(entry), [entry]);
  const chart = result.ok ? result.chart : null;
  const primaryName = measure ?? DOC_COUNT_MEASURE;
  const leftMeasure = chart ? chart.measure : measures.find((item) => item.name === primaryName) ?? null;
  const rightMeasure = secondary === null ? null : measures.find((item) => item.name === secondary) ?? null;
  const needsCanvas = chart !== null && chart.kind !== 'singleValue';
  const secondarySeries = chart !== null && chart.kind !== 'singleValue' ? chart.secondary : null;
  const dual = rightMeasure !== null;
  const dualOffered = entry.status === 'buckets' && measures.length > 1;
  const secondaryOptions = measures.filter((item) => item.name !== primaryName || item.name === secondary);
  const skipped: readonly ChartSkipped[] = chart ? chart.skipped : 'skipped' in result ? result.skipped : [];

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
  const axisText = (side: 'left' | 'right') => t(`queryAggregationCharts:axis_${side}`);
  const summary = chart === null ? '' : chart.kind !== 'singleValue' && chart.secondary
    ? t(chart.kind === 'bars' ? 'queryAggregationCharts:summary_dualBars' : 'queryAggregationCharts:summary_dual', {
    name: chart.aggregation, primary: measureText(chart.measure), secondary: measureText(chart.secondary.measure),
    plottedPrimary: chart.plotted, plottedSecondary: chart.secondary.plotted, buckets: chart.buckets,
    target: scope.target, page: scope.page,
  }) : t(`queryAggregationCharts:summary_${chart.kind}`, {
    name: chart.aggregation, measure: measureText(chart.measure), target: scope.target,
    page: scope.page, plotted: chart.plotted, buckets: chart.buckets,
  });
  const noticeGroups: readonly { title: string | null; items: readonly ChartNotice[]; imprecise: number }[] = !chart
    ? [] : chart.kind === 'singleValue' || !chart.secondary
      ? [{ title: null, items: chart.notices, imprecise: chart.impreciseCount }]
      : [
        {
          title: t(chart.kind === 'bars' ? 'queryAggregationCharts:noticesSharedTerms' : 'queryAggregationCharts:noticesShared'),
          items: chart.notices.filter((item) => SHARED_NOTICES.has(item)),
          imprecise: 0,
        },
        {
          title: t('queryAggregationCharts:noticesAxis', { measure: measureText(chart.measure), axis: axisText('left') }),
          items: chart.notices.filter((item) => !SHARED_NOTICES.has(item)),
          imprecise: chart.impreciseCount,
        },
        {
          title: t('queryAggregationCharts:noticesAxis', {
            measure: measureText(chart.secondary.measure), axis: axisText('right'),
          }),
          items: chart.secondary.notices,
          imprecise: chart.secondary.impreciseCount,
        },
      ];
  const skippedBlocks: readonly { title: string | null; items: readonly ChartSkipped[] }[] = chart
    ? chart.kind !== 'singleValue' && chart.secondary
      ? [
        { title: t('queryAggregationCharts:skippedForAxis', { measure: measureText(chart.measure), axis: axisText('left') }), items: chart.skipped },
        { title: t('queryAggregationCharts:skippedForAxis', { measure: measureText(chart.secondary.measure), axis: axisText('right') }), items: chart.secondary.skipped },
      ]
      : [{ title: null, items: skipped }]
      // A refusal reports only the list that caused it: the second measure is read after the first plots.
      : !result.ok && dual && leftMeasure && rightMeasure ? [{
        title: t('queryAggregationCharts:skippedForAxis', {
          measure: measureText(result.code === 'secondaryNoValues' ? rightMeasure : leftMeasure),
          axis: axisText(result.code === 'secondaryNoValues' ? 'right' : 'left'),
        }),
        items: skipped,
      }] : [{ title: null, items: skipped }];
  const visibleSkipped = skippedBlocks.filter((block) => block.items.length > 0);

  return <div className="qac-panel">
    <ul className="qac-scope" aria-label={t('queryAggregationCharts:scope')}>
      <li><span>{t('documentDetail:target')}</span><code>{scope.target}</code></li>
      <li><span>{t('queryAggregations:receivedPage')}</span>{t('queryAggregations:pageOption', { page: scope.page })}</li>
      {dual ? <>
        {leftMeasure ? <li><span>{t('queryAggregationCharts:measureLeft')}</span>{measureText(leftMeasure)}</li> : null}
        {rightMeasure ? <li><span>{t('queryAggregationCharts:measureRight')}</span>{measureText(rightMeasure)}</li> : null}
      </> : leftMeasure ? <li><span>{t('queryAggregationCharts:measure')}</span>{measureText(leftMeasure)}</li> : null}
      {chart && chart.kind !== 'singleValue' ? <li>
        <span>{dual ? t('queryAggregationCharts:plottedAxis', { axis: axisText('left') })
          : t('queryAggregationCharts:plotted')}</span>
        {t('queryAggregationCharts:plottedOf', { plotted: chart.plotted, buckets: chart.buckets })}
      </li> : null}
      {chart && secondarySeries ? <li>
        <span>{t('queryAggregationCharts:plottedAxis', { axis: axisText('right') })}</span>
        {t('queryAggregationCharts:plottedOf', { plotted: secondarySeries.plotted, buckets: chart.buckets })}
      </li> : null}
      {scope.bounds ? <li><span>{t('queryAggregationCharts:frozenRange')}</span>
        <code>{scope.bounds.from}</code><code>{scope.bounds.to}</code></li> : null}
    </ul>
    {measures.length > 1 ? <label className="qac-measure">{t('queryAggregationCharts:measure')}
      <SelectControl value={measure ?? DOC_COUNT_MEASURE} onChange={(event) => {
        setMeasure(event.currentTarget.value); onMeasureChange?.(event.currentTarget.value);
      }}>
        {measures.map((item) => <option key={item.name} value={item.name}>{measureText(item)}</option>)}
      </SelectControl>
    </label> : null}
    {dualOffered ? <div className="qac-dual">
      <Toggle id={`${controls}-dual`} checked={dual} label={t('queryAggregationCharts:dualToggle')}
        onChange={(value) => {
          const next = measures.find((item) => item.name !== primaryName);
          setSecondary(value && next ? next.name : null);
        }} />
      {secondary === null ? null : <label className="qac-measure">{t('queryAggregationCharts:measureRight')}
        <SelectControl value={secondary} onChange={(event) => setSecondary(event.currentTarget.value)}>
          {secondaryOptions.map((item) => <option key={item.name} value={item.name}>{measureText(item)}</option>)}
        </SelectControl>
      </label>}
    </div> : null}
    {dual && chart ? <p className="qac-dual-note">{t('queryAggregationCharts:axesIndependent')}</p> : null}
    {noticeGroups.some((group) => group.items.length > 0) ? <div className="qac-notice-groups">
      {noticeGroups.filter((group) => group.items.length > 0).map((group) => <ul className="qac-notices"
        key={group.title ?? 'own'} aria-label={group.title ?? undefined}>
        {group.items.map((notice) => <li key={notice}>{notice === 'imprecise'
          ? t('queryAggregationCharts:notice_imprecise', { count: group.imprecise })
          : t(`queryAggregationCharts:notice_${notice}`)}</li>)}
      </ul>)}
    </div> : null}
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
      : <AggregationChartReferences key={JSON.stringify([scope.target, scope.page])}
        chart={result.chart} Canvas={runtime.AggregationChartCanvas} label={summary} axes={{
        left: measureText(result.chart.measure),
        right: result.chart.secondary ? measureText(result.chart.secondary.measure) : '',
      }} />)
      : <p className="qac-warning" role="status">{t(`queryAggregationCharts:error_${result.code}`,
        { buckets: 'buckets' in result ? result.buckets : 0, limit: CHART_LIMITS.buckets })}</p>}
    {visibleSkipped.map((block) => <div className="qac-skipped" key={block.title ?? 'own'}>
      {block.title ? <p className="qac-skipped-scope">{block.title}</p> : null}
      <p>{t('queryAggregationCharts:skippedCount', { count: block.items.length })}</p>
      <ul>{block.items.slice(0, CHART_LIMITS.listedSkipped).map((item) => <li key={item.row}>
        <span>{t('queryAggregationCharts:skipRow', { row: item.row })}</span>
        <code>{item.label}</code>
        <span>{t(`queryAggregationCharts:skipField_${item.field}`)}</span>
        <code>{item.raw ?? t('queryAggregations:notReturned')}</code>
        <span className="qac-warning">{t(`queryAggregationCharts:reason_${item.reason}`)}</span>
      </li>)}
      {block.items.length > CHART_LIMITS.listedSkipped ? <li className="qac-skipped-more">
        {t('queryAggregationCharts:skippedMore', { count: block.items.length - CHART_LIMITS.listedSkipped })}</li> : null}
      </ul>
    </div>)}
    <p className="qac-display-note">{t('queryAggregationCharts:displayOnly')}</p>
  </div>;
}
