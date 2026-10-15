import type { AggregationBucket, AggregationMetric, AggregationValue } from './query-aggregations';

export type ChartViewMode = 'table' | 'chart';

export interface ChartPlottableValue {
  readonly valid: boolean;
  readonly numericValue: number | null;
  readonly raw: string | null;
  readonly label: string;
}

export interface MetricChartData {
  readonly name: string;
  readonly type: string;
  readonly value: ChartPlottableValue;
  readonly valueAsString: string | null;
  readonly isApproximate: boolean;
  readonly isValueCount: boolean;
}

export interface BarChartItem {
  readonly key: string;
  readonly member: string | null;
  readonly docCount: ChartPlottableValue;
  readonly errorBound: string | null;
  readonly metricValues: readonly { readonly name: string; readonly value: ChartPlottableValue }[];
}

export interface TermsBarChartData {
  readonly name: string;
  readonly items: readonly BarChartItem[];
  readonly unplottableCount: number;
  readonly docCountError: string | null;
  readonly sumOtherDocCount: string | null;
  readonly maxValue: number;
  readonly metricOptions: readonly string[];
  readonly selectedMetric: string | null; // null represents doc_count
}

export interface LineChartPoint {
  readonly xLabel: string;
  readonly rawTimestamp: string | null;
  readonly value: ChartPlottableValue;
}

export interface DateHistogramChartData {
  readonly name: string;
  readonly points: readonly LineChartPoint[];
  readonly unplottableCount: number;
  readonly minValue: number;
  readonly maxValue: number;
  readonly metricOptions: readonly string[];
  readonly selectedMetric: string | null; // null represents doc_count
  readonly options: readonly { readonly name: string; readonly raw: string }[];
}

/**
 * Safely parse a raw string token into a plottable finite number.
 * Never converts NaN, Infinity, null, or out-of-range exponent strings to 0.
 */
export function parsePlottableNumber(value: AggregationValue, fallbackLabel: string): ChartPlottableValue {
  if (value.kind === 'missing' || value.raw === null) {
    return { valid: false, numericValue: null, raw: null, label: fallbackLabel };
  }
  if (value.kind === 'null') {
    return { valid: false, numericValue: null, raw: 'null', label: fallbackLabel };
  }

  const rawTrimmed = value.raw.trim();
  // ES numeric tokens can be integers, decimals, or scientific notation.
  // We guard against non-numeric tokens.
  const num = Number(rawTrimmed);
  if (!Number.isFinite(num)) {
    return { valid: false, numericValue: null, raw: rawTrimmed, label: fallbackLabel };
  }

  return {
    valid: true,
    numericValue: num,
    raw: rawTrimmed,
    label: fallbackLabel,
  };
}

export function buildMetricChartData(metric: AggregationMetric): MetricChartData {
  const plottable = parsePlottableNumber(metric.value, metric.name);
  return {
    name: metric.name,
    type: metric.type,
    value: plottable,
    valueAsString: metric.valueAsString.raw,
    isApproximate: metric.type === 'cardinality',
    isValueCount: metric.type === 'value_count',
  };
}

export function stripQuotes(raw: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function buildTermsBarChartData(
  entry: {
    readonly name: string;
    readonly buckets: readonly AggregationBucket[];
    readonly metrics: readonly { readonly name: string; readonly type: string }[];
    readonly docCountError: AggregationValue;
    readonly sumOtherDocCount: AggregationValue;
  },
  selectedMetricName: string | null = null,
): TermsBarChartData {
  const metricOptions = entry.metrics.map((m) => m.name);
  const activeMetric = selectedMetricName && metricOptions.includes(selectedMetricName) ? selectedMetricName : null;

  let unplottableCount = 0;
  let max = 0;

  const items: BarChartItem[] = entry.buckets.map((bucket, index) => {
    const rawKey = bucket.keyAsString.raw ?? bucket.key.raw ?? (bucket.member ? `member:${bucket.member}` : `#${index + 1}`);
    const keyLabel = stripQuotes(rawKey);
    const docCountVal = parsePlottableNumber(bucket.docCount, keyLabel);

    const metricValues = bucket.metrics.map((m) => ({
      name: m.name,
      value: parsePlottableNumber(m.value, `${keyLabel} - ${m.name}`),
    }));

    // Choose target value to plot based on activeMetric
    const targetPlottable = activeMetric
      ? metricValues.find((m) => m.name === activeMetric)?.value
      : docCountVal;

    if (!targetPlottable || !targetPlottable.valid || targetPlottable.numericValue === null) {
      unplottableCount++;
    } else {
      if (targetPlottable.numericValue > max) {
        max = targetPlottable.numericValue;
      }
    }

    return {
      key: keyLabel,
      member: bucket.member,
      docCount: docCountVal,
      errorBound: bucket.docCountError.raw,
      metricValues,
    };
  });

  return {
    name: entry.name,
    items,
    unplottableCount,
    docCountError: entry.docCountError.raw,
    sumOtherDocCount: entry.sumOtherDocCount.raw,
    maxValue: max,
    metricOptions,
    selectedMetric: activeMetric,
  };
}

export function buildDateHistogramChartData(
  entry: {
    readonly name: string;
    readonly buckets: readonly AggregationBucket[];
    readonly metrics: readonly { readonly name: string; readonly type: string }[];
    readonly options: readonly { readonly name: string; readonly raw: string }[];
  },
  selectedMetricName: string | null = null,
): DateHistogramChartData {
  const metricOptions = entry.metrics.map((m) => m.name);
  const activeMetric = selectedMetricName && metricOptions.includes(selectedMetricName) ? selectedMetricName : null;

  let unplottableCount = 0;
  let min = Infinity;
  let max = -Infinity;

  const points: LineChartPoint[] = entry.buckets.map((bucket, index) => {
    const rawKey = bucket.keyAsString.raw ?? bucket.key.raw ?? `#${index + 1}`;
    const xLabel = stripQuotes(rawKey);
    const rawTimestamp = bucket.key.raw;

    const targetVal = activeMetric
      ? bucket.metrics.find((m) => m.name === activeMetric)?.value
      : bucket.docCount;

    const plottable = targetVal ? parsePlottableNumber(targetVal, xLabel) : { valid: false, numericValue: null, raw: null, label: xLabel };

    if (!plottable.valid || plottable.numericValue === null) {
      unplottableCount++;
    } else {
      if (plottable.numericValue < min) min = plottable.numericValue;
      if (plottable.numericValue > max) max = plottable.numericValue;
    }

    return {
      xLabel,
      rawTimestamp,
      value: plottable,
    };
  });

  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 0;

  return {
    name: entry.name,
    points,
    unplottableCount,
    minValue: min,
    maxValue: max,
    metricOptions,
    selectedMetric: activeMetric,
    options: entry.options,
  };
}
