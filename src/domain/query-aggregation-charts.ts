import {
  AGGREGATION_LIMITS,
  type AggregationBucket,
  type AggregationResult,
  type AggregationValue,
  type MetricAggregationType,
} from './query-aggregations';

export const CHART_LIMITS = Object.freeze({
  /** Buckets of one received-page entry that a single chart may plot; more is refused, never truncated. */
  buckets: 200,
  /** Category labels drawn on an axis; the bucket table stays the complete list. */
  axisLabels: 12,
  /** Skipped values listed inline before the remainder is summarised as a count. */
  listedSkipped: 10,
});

export const DOC_COUNT_MEASURE = 'doc_count';

export type ChartKind = 'singleValue' | 'bars' | 'line';
export type ChartMeasureType = typeof DOC_COUNT_MEASURE | MetricAggregationType;
/** Why a returned value is not drawn. A skipped value is never substituted with zero. */
export type ChartSkipReason = 'missing' | 'null' | 'notNumeric' | 'invalidToken' | 'outOfRange';
export type ChartSkipField = 'value' | 'key';
export type ChartNotice = 'approximate' | 'valueCount' | 'imprecise' | 'errorUnknown' | 'errorNotReported'
  | 'omittedBuckets' | 'termsScope' | 'bucketStarts' | 'sparseSeries';

export interface ChartMeasure {
  readonly name: string;
  readonly type: ChartMeasureType;
}

/** A value that passed the independent range and precision checks; `raw` stays the verbatim token. */
export interface ChartValue {
  readonly value: number;
  readonly raw: string;
  /** False when the plotted double is not the exact decimal value of `raw`. */
  readonly precise: boolean;
}

export interface ChartSkipped {
  /** 1-based bucket row of the same received page, matching the bucket table. */
  readonly row: number;
  readonly label: string;
  readonly field: ChartSkipField;
  readonly raw: string | null;
  readonly reason: ChartSkipReason;
}

export interface ChartBar extends ChartValue {
  readonly slot: number;
  readonly row: number;
  readonly label: string;
}

export interface ChartMarker extends ChartValue {
  readonly row: number;
  readonly label: string;
  /** Numeric bucket key: a returned bucket start, never an inferred end boundary. */
  readonly position: number;
}

interface ChartBase {
  readonly aggregation: string;
  readonly aggregationType: string;
  readonly measure: ChartMeasure;
  /** Extent of plotted values only; a skipped value contributes nothing, not even zero. */
  readonly valueExtent: { readonly min: number; readonly max: number };
  readonly skipped: readonly ChartSkipped[];
  readonly notices: readonly ChartNotice[];
  readonly impreciseCount: number;
  /** Buckets returned for this entry in this received page. */
  readonly buckets: number;
  readonly plotted: number;
}

export type PlottedChart =
  | (ChartBase & { readonly kind: 'singleValue'; readonly single: ChartValue })
  | (ChartBase & {
    readonly kind: 'bars';
    readonly slots: number;
    readonly slotLabels: readonly string[];
    readonly bars: readonly ChartBar[];
  })
  | (ChartBase & {
    readonly kind: 'line';
    /** Extent of returned bucket keys whose position could be read, including skipped values. */
    readonly positionExtent: { readonly min: number; readonly max: number };
    /** Consecutive returned rows; a skipped bucket splits the line instead of dropping to zero. */
    readonly series: readonly (readonly ChartMarker[])[];
  });

export type AggregationChartResult =
  | { readonly ok: false; readonly code: 'unplottable' | 'unknownMeasure' }
  | {
    readonly ok: false;
    readonly code: 'noBuckets' | 'tooManyBuckets' | 'noPlottableValues';
    readonly buckets: number;
    readonly skipped: readonly ChartSkipped[];
  }
  | { readonly ok: true; readonly chart: PlottedChart };

const NUMBER_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const COUNT_TOKEN = /^\d+$/;
const INTEGER_TOKEN = /^-?\d+$/;
const MISSING: AggregationValue = Object.freeze({ kind: 'missing', raw: null });

type Conversion = ChartValue | ChartSkipReason;

/**
 * `digits × 10^power` without trailing zeros, so two spellings of one decimal compare equal and a
 * double can be checked against the token it was produced from without any decimal library.
 */
function canonicalDecimal(token: string): string | null {
  const parsed = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!parsed) return null;
  const [, sign, integer, fraction = '', exponent = '0'] = parsed;
  const digits = integer + fraction;
  let power = Number(exponent) - fraction.length;
  if (!Number.isSafeInteger(power)) return null;
  let end = digits.length;
  while (end > 0 && digits[end - 1] === '0') end -= 1;
  power += digits.length - end;
  const significant = digits.slice(0, end).replace(/^0+/, '');
  return significant === '' ? '0' : `${sign}${significant}e${power}`;
}

/**
 * Independent plotting conversion: the aggregation reader guarantees a token, not a double.
 * Anything that cannot be represented exactly enough to draw is reported with its reason and
 * original token instead of being rounded silently or drawn as zero.
 */
function convert(value: AggregationValue): Conversion {
  if (value.kind === 'missing') return 'missing';
  if (value.kind === 'null') return 'null';
  if (value.kind !== 'number' || value.raw === null) return 'notNumeric';
  const { raw } = value;
  if (raw.length > AGGREGATION_LIMITS.numberLength || !NUMBER_TOKEN.test(raw)) return 'invalidToken';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 'outOfRange';
  const exact = canonicalDecimal(raw);
  if (exact === null) return 'invalidToken';
  // A token that underflows to zero would draw a value the server never returned.
  if (parsed === 0 && exact !== '0') return 'outOfRange';
  return { value: parsed, raw, precise: exact === canonicalDecimal(String(parsed)) };
}

/** A count is only plottable while it is still an exact integer; a rounded count is not drawn. */
function convertCount(value: AggregationValue): Conversion {
  const converted = convert(value);
  if (typeof converted === 'string') return converted;
  return Number.isSafeInteger(converted.value) ? converted : 'outOfRange';
}

function convertPosition(value: AggregationValue): Conversion {
  if (value.kind === 'number' && value.raw !== null && !INTEGER_TOKEN.test(value.raw)) return 'invalidToken';
  const converted = convert(value);
  if (typeof converted === 'string') return converted;
  // A rounded key would draw the bucket at a position it was never returned for.
  return converted.precise && Number.isSafeInteger(converted.value) ? converted : 'outOfRange';
}

/** Server-returned text first; a date is never parsed or reformatted on the client. */
function bucketLabel(bucket: AggregationBucket): string {
  return bucket.keyAsString.raw ?? bucket.key.raw ?? '';
}

export function chartMeasures(entry: AggregationResult): readonly ChartMeasure[] {
  if (entry.status !== 'buckets') return [];
  return [
    { name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE },
    ...entry.metrics.map(({ name, type }): ChartMeasure => ({ name, type })),
  ];
}

/** Evenly spaced slot indices, always including the first and last returned bucket. */
export function chartAxisSlots(slots: number, limit: number = CHART_LIMITS.axisLabels): readonly number[] {
  if (slots <= 0) return [];
  if (slots <= limit) return Array.from({ length: slots }, (_, index) => index);
  const step = (slots - 1) / (limit - 1);
  const result: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    const slot = Math.round(index * step);
    if (result[result.length - 1] !== slot) result.push(slot);
  }
  return result;
}

/** The value axis always contains zero so a small spread is not exaggerated. */
export function chartValueDomain(extent: { min: number; max: number }): { min: number; max: number } {
  const min = Math.min(0, extent.min);
  const max = Math.max(0, extent.max);
  return min === max ? { min, max: max + 1 } : { min, max };
}

/** Bucket starts are plotted as returned; a single key is padded so it stays inside the view. */
export function chartPositionDomain(extent: { min: number; max: number }): { min: number; max: number } {
  return extent.min === extent.max ? { min: extent.min - 1, max: extent.max + 1 } : extent;
}

function singleValueChart(
  entry: Extract<AggregationResult, { status: 'metric' }>,
  measure: string | null,
): AggregationChartResult {
  if (measure !== null && measure !== entry.name) return { ok: false, code: 'unknownMeasure' };
  const converted = convert(entry.metric.value);
  if (typeof converted === 'string') {
    return {
      ok: false, code: 'noPlottableValues', buckets: 0,
      skipped: [{ row: 1, label: entry.name, field: 'value', raw: entry.metric.value.raw, reason: converted }],
    };
  }
  const notices: ChartNotice[] = [];
  if (entry.type === 'cardinality') notices.push('approximate');
  if (entry.type === 'value_count') notices.push('valueCount');
  if (!converted.precise) notices.push('imprecise');
  return {
    ok: true,
    chart: {
      kind: 'singleValue', aggregation: entry.name, aggregationType: entry.type,
      measure: { name: entry.name, type: entry.type }, single: converted,
      valueExtent: { min: converted.value, max: converted.value },
      skipped: [], notices, impreciseCount: converted.precise ? 0 : 1, buckets: 0, plotted: 1,
    },
  };
}

/**
 * Build bounded plot data for one entry of one received page. Types come from the executed
 * definition already resolved by the aggregation reader, never from the response shape, and the
 * result never combines pages, adds missing buckets or reorders buckets into another semantics.
 */
export function buildAggregationChart(entry: AggregationResult, measure: string | null): AggregationChartResult {
  if (entry.status === 'metric') return singleValueChart(entry, measure);
  if (entry.status !== 'buckets') return { ok: false, code: 'unplottable' };
  if (entry.buckets.length > CHART_LIMITS.buckets) {
    return { ok: false, code: 'tooManyBuckets', buckets: entry.buckets.length, skipped: [] };
  }
  if (entry.buckets.length === 0) return { ok: false, code: 'noBuckets', buckets: 0, skipped: [] };
  const selected = chartMeasures(entry).find((item) => item.name === (measure ?? DOC_COUNT_MEASURE));
  if (!selected) return { ok: false, code: 'unknownMeasure' };
  const counts = selected.type === DOC_COUNT_MEASURE;
  const histogram = entry.type === 'date_histogram';
  const skipped: ChartSkipped[] = [];
  const slotLabels: string[] = [];
  const bars: ChartBar[] = [];
  const markers: ChartMarker[] = [];
  const positions: number[] = [];
  let imprecise = 0;
  entry.buckets.forEach((bucket, index) => {
    const row = index + 1;
    const label = bucketLabel(bucket);
    slotLabels.push(label);
    const source = counts ? bucket.docCount : bucket.metrics.find((item) => item.name === selected.name)?.value ?? MISSING;
    const value = counts ? convertCount(source) : convert(source);
    const key = histogram ? convertPosition(bucket.key) : null;
    if (key !== null && typeof key !== 'string') positions.push(key.value);
    if (typeof value === 'string') {
      skipped.push({ row, label, field: 'value', raw: source.raw, reason: value });
      return;
    }
    if (key !== null && typeof key === 'string') {
      skipped.push({ row, label, field: 'key', raw: bucket.key.raw, reason: key });
      return;
    }
    if (!value.precise) imprecise += 1;
    if (key === null) bars.push({ slot: index, row, label, ...value });
    else markers.push({ row, label, position: key.value, ...value });
  });
  const plotted = bars.length + markers.length;
  if (plotted === 0) {
    return { ok: false, code: 'noPlottableValues', buckets: entry.buckets.length, skipped };
  }
  const values = histogram ? markers : bars;
  const extent = {
    min: Math.min(...values.map(({ value }) => value)),
    max: Math.max(...values.map(({ value }) => value)),
  };
  const notices: ChartNotice[] = [];
  if (selected.type === 'cardinality') notices.push('approximate');
  if (selected.type === 'value_count') notices.push('valueCount');
  if (imprecise > 0) notices.push('imprecise');
  if (histogram) {
    notices.push('bucketStarts');
    if (skipped.length > 0) notices.push('sparseSeries');
  } else {
    if (entry.docCountError.raw === '-1') notices.push('errorUnknown');
    else if (entry.docCountError.kind === 'missing') notices.push('errorNotReported');
    const other = entry.sumOtherDocCount.raw;
    if (other !== null && COUNT_TOKEN.test(other) && BigInt(other) > 0n) notices.push('omittedBuckets');
    notices.push('termsScope');
  }
  const base = {
    aggregation: entry.name, aggregationType: entry.type, measure: selected, valueExtent: extent,
    skipped, notices, impreciseCount: imprecise, buckets: entry.buckets.length, plotted,
  };
  if (!histogram) return { ok: true, chart: { ...base, kind: 'bars', slots: slotLabels.length, slotLabels, bars } };
  const series: ChartMarker[][] = [];
  for (const marker of markers) {
    const previous = series[series.length - 1];
    if (previous && marker.row === previous[previous.length - 1]!.row + 1) previous.push(marker);
    else series.push([marker]);
  }
  return {
    ok: true,
    chart: {
      ...base, kind: 'line', series,
      positionExtent: { min: Math.min(...positions), max: Math.max(...positions) },
    },
  };
}
