import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Bar, LinePath } from '@visx/shape';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  chartAxisSlots, chartPositionDomain, chartValueDomain, type ChartMarker, type PlottedChart,
} from '../../../domain/query-aggregation-charts';

const HEIGHT = 240;
const MARGIN = Object.freeze({ top: 10, right: 14, bottom: 46, left: 62 });
/** Room for a second value axis; only a dual chart pays it. */
const RIGHT_MARGIN = 62;
const SLOT_WIDTH = 26;
const MARKER_STEP = 16;
const MIN_INNER = 420;
const MAX_INNER = 4000 - MARGIN.left - MARGIN.right;
const LABEL_LENGTH = 20;

type BarChart = Extract<PlottedChart, { kind: 'bars' }>;
type LineChart = Extract<PlottedChart, { kind: 'line' }>;
export type PlottableChart = BarChart | LineChart;
type Margin = { top: number; right: number; bottom: number; left: number };
type Plotted = { label: string; raw: string; value: number; precise: boolean };

/** Intrinsic geometry: the panel scrolls instead of shrinking text or dropping returned buckets. */
function innerWidthFor(inner: number): number {
  return Math.min(MAX_INNER, Math.max(MIN_INNER, Math.round(inner)));
}

/** Display only; the full token stays in the tooltip and in the bucket table. */
function truncate(label: string): string {
  return label.length > LABEL_LENGTH ? `${label.slice(0, LABEL_LENGTH - 1)}…` : label;
}

function Frame({ width, margin, label, children }: {
  width: number; margin: Margin; label: string; children: ReactNode;
}) {
  const { t } = useTranslation();
  return <div className="qac-canvas" role="region" aria-label={t('queryAggregationCharts:scrollRegion')} tabIndex={0}>
    <svg className="qac-svg" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label}>
      <Group top={margin.top} left={margin.left}>{children}</Group>
    </svg>
  </div>;
}

function ValueAxis({ position, ticks, innerWidth, innerHeight, margin, label, side = 'left', grid = true }: {
  position: (value: number) => number; ticks: readonly number[]; innerWidth: number; innerHeight: number;
  margin: Margin; label: string; side?: 'left' | 'right'; grid?: boolean;
}) {
  const right = side === 'right';
  return <g className="qac-axis" data-axis={side} aria-hidden="true">
    {ticks.map((tick) => <g key={tick} transform={`translate(0 ${position(tick)})`}>
      {grid ? <line className="qac-grid" x2={innerWidth} /> : null}
      <text className={`qac-tick${right ? ' qac-tick-right' : ''}`} x={right ? innerWidth + 8 : -8} dy="0.32em"
        textAnchor={right ? 'start' : 'end'}>{String(tick)}</text>
    </g>)}
    {grid ? <line className="qac-baseline" x2={innerWidth} y1={innerHeight} y2={innerHeight} /> : null}
    <line className="qac-baseline" x1={right ? innerWidth : 0} x2={right ? innerWidth : 0} y2={innerHeight} />
    <text className="qac-axis-title" textAnchor="middle"
      transform={right ? `translate(${innerWidth + RIGHT_MARGIN - 10} ${innerHeight / 2}) rotate(90)`
        : `translate(${-margin.left + 14} ${innerHeight / 2}) rotate(-90)`}>{label}</text>
  </g>;
}

function BarChartView({ chart, label, axes }: { chart: BarChart; label: string; axes: Record<'left' | 'right', string> }) {
  const { t } = useTranslation();
  const secondary = chart.secondary;
  const margin: Margin = { ...MARGIN, right: secondary === null ? MARGIN.right : RIGHT_MARGIN };
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const innerWidth = innerWidthFor(chart.slots * SLOT_WIDTH);
  const domain = chartValueDomain(chart.valueExtent);
  const y = scaleLinear<number>({ domain: [domain.min, domain.max], range: [innerHeight, 0] });
  const x = scaleBand<number>({
    domain: chart.slotLabels.map((_, slot) => slot), range: [0, innerWidth], padding: 0.25,
  });
  const zero = y(0);
  const gap = secondary ? Math.min(3, x.bandwidth() / 5) : 0;
  const barWidth = secondary ? (x.bandwidth() - gap) / 2 : x.bandwidth();
  const secondaryDomain = secondary ? chartValueDomain(secondary.valueExtent) : null;
  const secondaryY = secondaryDomain ? scaleLinear<number>({
    domain: [secondaryDomain.min, secondaryDomain.max], range: [innerHeight, 0],
  }) : null;
  const tooltip = (item: Plotted) =>
    `${item.label}: ${item.precise ? item.raw : t('queryAggregationCharts:plottedAs', { raw: item.raw, value: item.value })}`;
  return <Frame width={innerWidth + margin.left + margin.right} margin={margin} label={label}>
    <ValueAxis position={(value) => y(value)} ticks={y.ticks(5)} innerWidth={innerWidth} innerHeight={innerHeight}
      margin={margin} label={secondary === null ? t('queryAggregationCharts:axisValue')
        : t('queryAggregationCharts:axisValueLeft', { measure: truncate(axes.left) })} />
    {chart.bars.map((bar) => <Bar key={bar.row} className="qac-bar" data-row={bar.row} data-precise={bar.precise}
      x={x(bar.slot) ?? 0} y={Math.min(zero, y(bar.value))} width={barWidth}
      height={Math.abs(zero - y(bar.value))}>
      <title>{secondary ? `${axes.left} ${tooltip(bar)}` : tooltip(bar)}</title>
    </Bar>)}
    {secondary && secondaryY ? <>
      <ValueAxis side="right" grid={false} position={(value) => secondaryY(value)} ticks={secondaryY.ticks(5)}
        innerWidth={innerWidth} innerHeight={innerHeight} margin={margin}
        label={t('queryAggregationCharts:axisValueRight', { measure: truncate(axes.right) })} />
      {secondary.bars.map((bar) => <Bar key={bar.row} className="qac-bar qac-bar-secondary"
        data-row={bar.row} data-precise={bar.precise} x={(x(bar.slot) ?? 0) + barWidth + gap}
        y={Math.min(secondaryY(0), secondaryY(bar.value))} width={barWidth}
        height={Math.abs(secondaryY(0) - secondaryY(bar.value))}>
        <title>{`${axes.right} ${tooltip(bar)}`}</title>
      </Bar>)}
    </> : null}
    <g aria-hidden="true">
      {chartAxisSlots(chart.slots).map((slot) => <text key={slot} className="qac-tick" textAnchor="middle"
        x={(x(slot) ?? 0) + x.bandwidth() / 2} y={innerHeight + 16}>{truncate(chart.slotLabels[slot] ?? '')}</text>)}
      <text className="qac-axis-title" textAnchor="middle" x={innerWidth / 2} y={innerHeight + 36}>
        {t('queryAggregationCharts:axisCategory')}
      </text>
    </g>
  </Frame>;
}

function SecondarySeries({ series, extent, x, innerWidth, innerHeight, margin, measure }: {
  series: readonly (readonly ChartMarker[])[];
  extent: { min: number; max: number }; x: (value: number) => number;
  innerWidth: number; innerHeight: number; margin: Margin; measure: string;
}) {
  const { t } = useTranslation();
  const domain = chartValueDomain(extent);
  const y = scaleLinear<number>({ domain: [domain.min, domain.max], range: [innerHeight, 0] });
  const markers = series.flat();
  return <>
    <ValueAxis side="right" grid={false} position={(value) => y(value)} ticks={y.ticks(5)}
      innerWidth={innerWidth} innerHeight={innerHeight} margin={margin}
      label={t('queryAggregationCharts:axisValueRight', { measure: truncate(measure) })} />
    <g className="qac-series-secondary">
      {series.map((segment) => <LinePath key={`s${segment[0]!.row}`} className="qac-line" data={[...segment]}
        x={(marker) => x(marker.position)} y={(marker) => y(marker.value)} />)}
      {markers.map((marker) => <circle key={marker.row} className="qac-marker" data-row={marker.row}
        data-precise={marker.precise} cx={x(marker.position)} cy={y(marker.value)} r={3}>
        <title>{`${measure} ${marker.label}: ${marker.precise
          ? marker.raw : t('queryAggregationCharts:plottedAs', { raw: marker.raw, value: marker.value })}`}</title>
      </circle>)}
    </g>
  </>;
}

function LineChartView({ chart, label, axes }: { chart: LineChart; label: string; axes: Record<'left' | 'right', string> }) {
  const { t } = useTranslation();
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const secondary = chart.secondary;
  const margin: Margin = { ...MARGIN, right: secondary === null ? MARGIN.right : RIGHT_MARGIN };
  const markers = chart.series.flat();
  const innerWidth = innerWidthFor(markers.length * MARKER_STEP);
  const valueDomain = chartValueDomain(chart.valueExtent);
  const positionDomain = chartPositionDomain(chart.positionExtent);
  const y = scaleLinear<number>({ domain: [valueDomain.min, valueDomain.max], range: [innerHeight, 0] });
  const x = scaleLinear<number>({ domain: [positionDomain.min, positionDomain.max], range: [0, innerWidth] });
  const tooltip = (item: Plotted) =>
    `${item.label}: ${item.precise ? item.raw : t('queryAggregationCharts:plottedAs', { raw: item.raw, value: item.value })}`;
  return <Frame width={innerWidth + margin.left + margin.right} margin={margin} label={label}>
    <ValueAxis position={(value) => y(value)} ticks={y.ticks(5)} innerWidth={innerWidth} innerHeight={innerHeight}
      margin={margin}
      label={secondary === null ? t('queryAggregationCharts:axisValue')
        : t('queryAggregationCharts:axisValueLeft', { measure: truncate(axes.left) })} />
    {chart.series.map((segment) => <LinePath key={segment[0]!.row} className="qac-line" data={[...segment]}
      x={(marker) => x(marker.position)} y={(marker) => y(marker.value)} />)}
    {markers.map((marker) => <circle key={marker.row} className="qac-marker" data-row={marker.row}
      data-precise={marker.precise} cx={x(marker.position)} cy={y(marker.value)} r={3}>
      <title>{tooltip(marker)}</title>
    </circle>)}
    {secondary ? <SecondarySeries series={secondary.series} extent={secondary.valueExtent} x={(value) => x(value)}
      innerWidth={innerWidth} innerHeight={innerHeight} margin={margin} measure={axes.right} /> : null}
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
export function AggregationChartCanvas({ chart, label, axes }: {
  chart: PlottableChart; label: string; axes: Record<'left' | 'right', string>;
}) {
  return chart.kind === 'bars' ? <BarChartView chart={chart} label={label} axes={axes} />
    : <LineChartView chart={chart} label={label} axes={axes} />;
}
