import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Copy, Table } from 'lucide-react';
import { IconButton, SelectControl } from '../../components/controls';
import type {
  DateHistogramChartData,
  MetricChartData,
  TermsBarChartData,
} from '../../domain/query-chart';

export interface ChartProps {
  onCopy?: (text: string) => void;
}

function useChartContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return [ref, width] as const;
}

export function MetricStatCard({ data, onCopy }: { data: MetricChartData } & ChartProps) {
  const { t } = useTranslation();

  return (
    <div className="qa-stat-card" role="region" aria-label={t('queryAggregations:metricCard', { name: data.name })}>
      <div className="qa-stat-header">
        <span className="qa-stat-name">{data.name}</span>
        <span className="qa-stat-type"><code>{data.type}</code></span>
        {data.isApproximate ? (
          <span className="qa-stat-tag warning">{t('queryAggregations:approximate')}</span>
        ) : null}
        {data.isValueCount ? (
          <span className="qa-stat-tag info">{t('queryAggregations:valueCount')}</span>
        ) : null}
      </div>

      <div className="qa-stat-body">
        {data.value.valid && data.value.raw !== null ? (
          <div className="qa-stat-number-row">
            <span className="qa-stat-number" aria-label={data.name}>
              {data.value.raw}
            </span>
            {onCopy ? (
              <IconButton
                icon={Copy}
                label={t('queryAggregations:copyValue', { name: data.name })}
                onClick={() => onCopy(data.value.raw!)}
              />
            ) : null}
          </div>
        ) : (
          <div className="qa-stat-unplottable" role="alert">
            <span>{t('queryAggregations:notReturned')}</span>
          </div>
        )}

        {data.valueAsString ? (
          <div className="qa-stat-string-sub">
            <span className="qa-sub-label">{t('queryAggregations:returnedString')}:</span>
            <code>{data.valueAsString}</code>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TermsBarChart({
  data,
  onSelectMetric,
}: {
  data: TermsBarChartData;
  onSelectMetric: (metric: string | null) => void;
}) {
  const { t } = useTranslation();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [containerRef, containerWidth] = useChartContainerWidth<HTMLDivElement>();

  const chartHeight = 240;
  const paddingBottom = 40;
  const paddingTop = 20;
  const plotHeight = chartHeight - paddingTop - paddingBottom;

  const availableWidth = containerWidth > 0 ? Math.max(containerWidth - 36, 320) : 500;
  const minBarWidth = 18;
  const minBarGap = 12;
  const minNeededWidth = data.items.length * (minBarWidth + minBarGap) + 40;
  const totalWidth = Math.max(availableWidth, minNeededWidth);

  const slotWidth = (totalWidth - 40) / Math.max(1, data.items.length);
  const barWidth = Math.min(48, Math.max(16, Math.round(slotWidth * 0.55)));

  const activeMetricLabel = data.selectedMetric ?? t('queryAggregations:docCount');

  return (
    <div ref={containerRef} className="qa-chart-container" role="region" aria-label={t('queryAggregations:barChartTitle', { name: data.name })}>
      <div className="qa-chart-toolbar">
        <div className="qa-chart-metric-selector">
          {data.metricOptions.length > 0 ? (
            <label className="qa-selector-label">
              <span>{t('queryAggregations:chartMetric')}:</span>
              <SelectControl
                value={data.selectedMetric ?? ''}
                onChange={(e) => onSelectMetric(e.currentTarget.value || null)}
              >
                <option value="">{t('queryAggregations:docCount')}</option>
                {data.metricOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </SelectControl>
            </label>
          ) : (
            <span className="qa-chart-title-tag">{t('queryAggregations:docCount')}</span>
          )}
        </div>

        {data.unplottableCount > 0 ? (
          <span className="qa-chart-warn-tag">
            {t('queryAggregations:unplottableNotice', { count: data.unplottableCount })}
          </span>
        ) : null}
      </div>

      <div className="qa-svg-scroll-container">
        <svg
          className="qa-bar-svg"
          width={totalWidth}
          height={chartHeight}
          role="img"
          aria-label={t('queryAggregations:barChartTitle', { name: data.name })}
        >
          {/* Baseline horizontal axis */}
          <line
            x1={10}
            y1={chartHeight - paddingBottom}
            x2={totalWidth - 10}
            y2={chartHeight - paddingBottom}
            className="qa-axis-line"
          />

          {data.items.map((item, index) => {
            const x = 20 + index * slotWidth + (slotWidth - barWidth) / 2;
            const val = data.selectedMetric
              ? item.metricValues.find((m) => m.name === data.selectedMetric)?.value
              : item.docCount;

            const isPlottable = val?.valid && val.numericValue !== null;
            const numeric = isPlottable ? val.numericValue! : 0;
            const height = data.maxValue > 0 ? (numeric / data.maxValue) * plotHeight : 0;
            const y = chartHeight - paddingBottom - height;

            const isHovered = hoveredIndex === index;
            const maxKeyLen = slotWidth > 75 ? 12 : slotWidth > 50 ? 8 : 5;
            const labelText = item.key.length > maxKeyLen ? `${item.key.slice(0, maxKeyLen - 1)}…` : item.key;

            return (
              <g
                key={index}
                className="qa-bar-group"
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={`${item.key}: ${val?.raw ?? 'N/A'}`}
              >
                {isPlottable ? (
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(2, height)}
                    rx={3}
                    className={`qa-bar-rect ${isHovered ? 'hovered' : ''}`}
                  />
                ) : (
                  <rect
                    x={x}
                    y={chartHeight - paddingBottom - 4}
                    width={barWidth}
                    height={4}
                    className="qa-bar-rect unplottable"
                  />
                )}

                {/* X Axis Label */}
                <text
                  x={x + barWidth / 2}
                  y={chartHeight - paddingBottom + 16}
                  className="qa-axis-text"
                  textAnchor="middle"
                >
                  {labelText}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {hoveredIndex !== null && data.items[hoveredIndex] ? (
        <div className="qa-chart-tooltip" role="tooltip">
          <div className="qa-tooltip-header">
            <strong>{data.items[hoveredIndex].key}</strong>
            {data.items[hoveredIndex].member ? (
              <code>({data.items[hoveredIndex].member})</code>
            ) : null}
          </div>
          <div className="qa-tooltip-body">
            <div>
              <span>{activeMetricLabel}: </span>
              <strong>
                {data.selectedMetric
                  ? data.items[hoveredIndex].metricValues.find((m) => m.name === data.selectedMetric)?.value.raw ?? t('queryAggregations:notReturned')
                  : data.items[hoveredIndex].docCount.raw}
              </strong>
            </div>
            {data.items[hoveredIndex].errorBound ? (
              <div className="qa-tooltip-sub">
                <span>{t('queryAggregations:bucketError')}: </span>
                <code>{data.items[hoveredIndex].errorBound}</code>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Footer Notices */}
      <div className="qa-chart-footer">
        {data.docCountError && data.docCountError !== '-1' ? (
          <span className="qa-footer-meta">
            {t('queryAggregations:errorBound')}: <code>{data.docCountError}</code>
          </span>
        ) : null}
        {data.sumOtherDocCount && BigInt(data.sumOtherDocCount) > 0n ? (
          <span className="qa-footer-warn">
            {t('queryAggregations:omittedBuckets')} ({t('queryAggregations:otherCount')}: <code>{data.sumOtherDocCount}</code>)
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function DateHistogramLineChart({
  data,
  onSelectMetric,
}: {
  data: DateHistogramChartData;
  onSelectMetric: (metric: string | null) => void;
}) {
  const { t } = useTranslation();
  const gradientId = useId();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [containerRef, containerWidth] = useChartContainerWidth<HTMLDivElement>();

  const chartHeight = 220;
  const paddingLeft = 50;
  const paddingRight = 30;
  const paddingTop = 20;
  const paddingBottom = 40;
  const availablePlotWidth = containerWidth > 0 ? Math.max(containerWidth - paddingLeft - paddingRight - 36, 260) : 450;
  const minPointSpacing = 28;
  const minNeededPlotWidth = Math.max(260, data.points.length * minPointSpacing);
  const plotWidth = Math.max(availablePlotWidth, minNeededPlotWidth);
  const totalWidth = paddingLeft + plotWidth + paddingRight;
  const plotHeight = chartHeight - paddingTop - paddingBottom;

  const activeMetricLabel = data.selectedMetric ?? t('queryAggregations:docCount');

  // Compute SVG polyline points
  const plottablePoints = data.points.map((pt, index) => {
    const x = paddingLeft + (index / Math.max(1, data.points.length - 1)) * plotWidth;
    const isPlottable = pt.value.valid && pt.value.numericValue !== null;
    const val = isPlottable ? pt.value.numericValue! : 0;
    const range = data.maxValue - data.minValue || 1;
    const y = paddingTop + plotHeight - ((val - data.minValue) / range) * plotHeight;
    return { x, y, isPlottable, raw: pt.value.raw, xLabel: pt.xLabel, index };
  });

  const validPoints = plottablePoints.filter((p) => p.isPlottable);
  const pathD = validPoints.length > 0
    ? validPoints.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`, '')
    : '';

  const firstPoint = validPoints[0];
  const lastPoint = validPoints[validPoints.length - 1];
  const areaD = firstPoint && lastPoint
    ? `${pathD} L ${lastPoint.x} ${chartHeight - paddingBottom} L ${firstPoint.x} ${chartHeight - paddingBottom} Z`
    : '';

  return (
    <div ref={containerRef} className="qa-chart-container" role="region" aria-label={t('queryAggregations:lineChartTitle', { name: data.name })}>
      <div className="qa-chart-toolbar">
        <div className="qa-chart-metric-selector">
          {data.metricOptions.length > 0 ? (
            <label className="qa-selector-label">
              <span>{t('queryAggregations:chartMetric')}:</span>
              <SelectControl
                value={data.selectedMetric ?? ''}
                onChange={(e) => onSelectMetric(e.currentTarget.value || null)}
              >
                <option value="">{t('queryAggregations:docCount')}</option>
                {data.metricOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </SelectControl>
            </label>
          ) : (
            <span className="qa-chart-title-tag">{t('queryAggregations:docCount')}</span>
          )}
        </div>

        {data.unplottableCount > 0 ? (
          <span className="qa-chart-warn-tag">
            {t('queryAggregations:unplottableNotice', { count: data.unplottableCount })}
          </span>
        ) : null}
      </div>

      <div className="qa-svg-scroll-container">
        <svg
          className="qa-line-svg"
          width={totalWidth}
          height={chartHeight}
          role="img"
          aria-label={t('queryAggregations:lineChartTitle', { name: data.name })}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary-base, #3b82f6)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-primary-base, #3b82f6)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines and axes */}
          <line
            x1={paddingLeft}
            y1={chartHeight - paddingBottom}
            x2={totalWidth - paddingRight}
            y2={chartHeight - paddingBottom}
            className="qa-axis-line"
          />

          {/* Area fill */}
          {areaD ? (
            <path d={areaD} fill={`url(#${gradientId})`} />
          ) : null}

          {/* Path line */}
          {pathD ? (
            <path d={pathD} fill="none" className="qa-chart-path" />
          ) : null}

          {/* Data Points */}
          {plottablePoints.map((p) => (
            <g
              key={p.index}
              className="qa-point-group"
              onMouseEnter={() => setHoveredIndex(p.index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              {p.isPlottable ? (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={hoveredIndex === p.index ? 5 : 3.5}
                  className={`qa-point-circle ${hoveredIndex === p.index ? 'hovered' : ''}`}
                />
              ) : null}
              {/* Point X Axis Label */}
              <text
                x={p.x}
                y={chartHeight - paddingBottom + 16}
                className="qa-axis-text"
                textAnchor="middle"
              >
                {p.xLabel.length > 12 ? `${p.xLabel.slice(0, 10)}…` : p.xLabel}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {hoveredIndex !== null && data.points[hoveredIndex] ? (
        <div className="qa-chart-tooltip" role="tooltip">
          <div className="qa-tooltip-header">
            <strong>{data.points[hoveredIndex].xLabel}</strong>
          </div>
          <div className="qa-tooltip-body">
            <div>
              <span>{activeMetricLabel}: </span>
              <strong>{data.points[hoveredIndex].value.raw ?? t('queryAggregations:notReturned')}</strong>
            </div>
          </div>
        </div>
      ) : null}

      <div className="qa-chart-footer">
        <span className="qa-footer-meta">{t('queryAggregations:noInferredEnd')}</span>
      </div>
    </div>
  );
}

export function ViewModeSwitch({
  mode,
  onChange,
}: {
  mode: 'table' | 'chart';
  onChange: (mode: 'table' | 'chart') => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="qa-view-switch" role="group" aria-label={t('queryAggregations:viewMode')}>
      <button
        type="button"
        className={`qa-switch-btn ${mode === 'table' ? 'active' : ''}`}
        aria-pressed={mode === 'table'}
        onClick={() => onChange('table')}
      >
        <Table size={14} aria-hidden="true" />
        <span>{t('queryAggregations:tableView')}</span>
      </button>
      <button
        type="button"
        className={`qa-switch-btn ${mode === 'chart' ? 'active' : ''}`}
        aria-pressed={mode === 'chart'}
        onClick={() => onChange('chart')}
      >
        <BarChart3 size={14} aria-hidden="true" />
        <span>{t('queryAggregations:chartView')}</span>
      </button>
    </div>
  );
}
