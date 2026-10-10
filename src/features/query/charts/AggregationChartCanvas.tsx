import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Bar, LinePath } from '@visx/shape';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  chartAxisSlots, chartPositionDomain, chartValueDomain, type PlottedChart,
} from '../../../domain/query-aggregation-charts';

const HEIGHT = 240;
const MARGIN = Object.freeze({ top: 10, right: 14, bottom: 46, left: 62 });
const SLOT_WIDTH = 26;
const MARKER_STEP = 16;
const MIN_INNER = 420;
const MAX_INNER = 4000 - MARGIN.left - MARGIN.right;
const LABEL_LENGTH = 20;

type BarChart = Extract<PlottedChart, { kind: 'bars' }>;
type LineChart = Extract<PlottedChart, { kind: 'line' }>;
export type PlottableChart = BarChart | LineChart;

/** Intrinsic geometry: the panel scrolls instead of shrinking text or dropping returned buckets. */
function innerWidthFor(inner: number): number {
  return Math.min(MAX_INNER, Math.max(MIN_INNER, Math.round(inner)));
}

/** Display only; the full token stays in the tooltip and in the bucket table. */
function truncate(label: string): string {
  return label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1)}…` : label;
}

function Frame({ width, label, children }: { width: number; label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return <div className="qac-canvas" role="region" aria-label={t('queryAggregationCharts:scrollRegion')} tabIndex={0}>
    <svg className="qac-svg" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label}>
      <Group top={MARGIN.top} left={MARGIN.left}>{children}</Group>
    </svg>
  </div>;
}

function ValueAxis({ position, ticks, innerWidth, innerHeight, label }: {
  position: (value: number) => number; ticks: readonly number[]; innerWidth: number; innerHeight: number; label: string;
}) {
  return <g aria-hidden="true">
    {ticks.map((tick) => <g key={tick} transform={`translate(0 ${position(tick)})`}>
      <line className="qac-grid" x2={innerWidth} />
      <text className="qac-tick" x={-8} dy="0.32em" textAnchor="end">{String(tick)}</text>
    </g>)}
    <line className="qac-baseline" x2={innerWidth} y1={innerHeight} y2={innerHeight} />
    <line className="qac-baseline" x1={0} x2={0} y2={innerHeight} />
    <text className="qac-axis-title" textAnchor="middle"
      transform={`translate(${-MARGIN.left + 14} ${innerHeight / 2}) rotate(-90)`}>{label}</text>
  </g>;
}

function BarChartView({ chart, label }: { chart: BarChart; label: string }) {
  const { t } = useTranslation();
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const innerWidth = innerWidthFor(chart.slots * SLOT_WIDTH);
  const domain = chartValueDomain(chart.valueExtent);
  const y = scaleLinear<number>({ domain: [domain.min, domain.max], range: [innerHeight, 0] });
  const x = scaleBand<number>({
    domain: chart.slotLabels.map((_, slot) => slot), range: [0, innerWidth], padding: 0.25,
  });
  const zero = y(0);
  const tooltip = (item: { label: string; raw: string; value: number; precise: boolean }) =>
    `${item.label}: ${item.precise ? item.raw : t('queryAggregationCharts:plottedAs', { raw: item.raw, value: item.value })}`;
  return <Frame width={innerWidth + MARGIN.left + MARGIN.right} label={label}>
    <ValueAxis position={(value) => y(value)} ticks={y.ticks(5)} innerWidth={innerWidth} innerHeight={innerHeight}
      label={t('queryAggregationCharts:axisValue')} />
    {chart.bars.map((bar) => <Bar key={bar.row} className="qac-bar" data-row={bar.row} data-precise={bar.precise}
      x={x(bar.slot) ?? 0} y={Math.min(zero, y(bar.value))} width={x.bandwidth()}
      height={Math.abs(zero - y(bar.value))}>
      <title>{tooltip(bar)}</title>
    </Bar>)}
    <g aria-hidden="true">
      {chartAxisSlots(chart.slots).map((slot) => <text key={slot} className="qac-tick" textAnchor="middle"
        x={(x(slot) ?? 0) + x.bandwidth() / 2} y={innerHeight + 16}>{truncate(chart.slotLabels[slot] ?? '')}</text>)}
      <text className="qac-axis-title" textAnchor="middle" x={innerWidth / 2} y={innerHeight + 36}>
        {t('queryAggregationCharts:axisCategory')}
      </text>
    </g>
  </Frame>;
}

function LineChartView({ chart, label }: { chart: LineChart; label: string }) {
  const { t } = useTranslation();
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const markers = chart.series.flat();
  const innerWidth = innerWidthFor(markers.length * MARKER_STEP);
  const valueDomain = chartValueDomain(chart.valueExtent);
  const positionDomain = chartPositionDomain(chart.positionExtent);
  const y = scaleLinear<number>({ domain: [valueDomain.min, valueDomain.max], range: [innerHeight, 0] });
  const x = scaleLinear<number>({ domain: [positionDomain.min, positionDomain.max], range: [0, innerWidth] });
  const tooltip = (item: { label: string; raw: string; value: number; precise: boolean }) =>
    `${item.label}: ${item.precise ? item.raw : t('queryAggregationCharts:plottedAs', { raw: item.raw, value: item.value })}`;
  return <Frame width={innerWidth + MARGIN.left + MARGIN.right} label={label}>
    <ValueAxis position={(value) => y(value)} ticks={y.ticks(5)} innerWidth={innerWidth} innerHeight={innerHeight}
      label={t('queryAggregationCharts:axisValue')} />
    {chart.series.map((segment) => <LinePath key={segment[0]!.row} className="qac-line" data={[...segment]}
      x={(marker) => x(marker.position)} y={(marker) => y(marker.value)} />)}
    {markers.map((marker) => <circle key={marker.row} className="qac-marker" data-row={marker.row}
      data-precise={marker.precise} cx={x(marker.position)} cy={y(marker.value)} r={3}>
      <title>{tooltip(marker)}</title>
    </circle>)}
    <g aria-hidden="true">
      {chartAxisSlots(markers.length).map((index) => {
        const marker = markers[index]!;
        return <text key={marker.row} className="qac-tick" textAnchor="middle"
          x={x(marker.position)} y={innerHeight + 16}>{truncate(marker.label)}</text>;
      })}
      <text className="qac-axis-title" textAnchor="middle" x={innerWidth / 2} y={innerHeight + 36}>
        {t('queryAggregationCharts:axisPosition')}
      </text>
    </g>
  </Frame>;
}

/** Drawn only from an already bounded plot model; nothing here reads JSON, combines pages or queries. */
export function AggregationChartCanvas({ chart, label }: { chart: PlottableChart; label: string }) {
  return chart.kind === 'bars' ? <BarChartView chart={chart} label={label} /> : <LineChartView chart={chart} label={label} />;
}
