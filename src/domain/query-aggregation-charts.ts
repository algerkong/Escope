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

/**
 * One measure plotted over the same already verified received-page entry. Its extent, unplotted
 * list, notices and precision accounting stay separate from any other measure of the chart.
 */
export interface ChartMeasureSeries {
  readonly measure: ChartMeasure;
  readonly valueExtent: { readonly min: number; readonly max: number };
  readonly series: readonly (readonly ChartMarker[])[];
  readonly skipped: readonly ChartSkipped[];
  readonly notices: readonly ChartNotice[];
  readonly impreciseCount: number;
  readonly plotted: number;
}

export interface ChartMeasureBars extends Omit<ChartMeasureSeries, 'series'> {
  readonly bars: readonly ChartBar[];
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
    readonly secondary: ChartMeasureBars | null;
  })
  | (ChartBase & {
    readonly kind: 'line';
    /** Extent of returned bucket keys whose position could be read, including skipped values. */
    readonly positionExtent: { readonly min: number; readonly max: number };
    /** Consecutive returned rows; a skipped bucket splits the line instead of dropping to zero. */
    readonly series: readonly (readonly ChartMarker[])[];
    /** A second measure of the same entry drawn on its own axis, or null when only one is plotted. */
    readonly secondary: ChartMeasureSeries | null;
  });

export type AggregationChartResult =
  | {
    readonly ok: false;
    readonly code: 'unplottable' | 'unknownMeasure' | 'unknownSecondary' | 'secondarySame' | 'secondaryUnsupported'
      | 'valueDomainOutOfRange' | 'secondaryDomainOutOfRange';
  }
  | {
    readonly ok: false;
    readonly code: 'noBuckets' | 'tooManyBuckets' | 'noPlottableValues' | 'secondaryNoValues';
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
  secondary: string | null,
): AggregationChartResult {
  if (measure !== null && measure !== entry.name) return { ok: false, code: 'unknownMeasure' };
  if (secondary !== null) return { ok: false, code: 'secondaryUnsupported' };
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

type BucketEntry = Extract<AggregationResult, { status: 'buckets' }>;
type SeriesPlot<Item> = { readonly items: readonly Item[]; readonly skipped: ChartSkipped[]; readonly imprecise: number };

function measureSource(bucket: AggregationBucket, measure: ChartMeasure): AggregationValue {
  return measure.type === DOC_COUNT_MEASURE ? bucket.docCount
    : bucket.metrics.find((item) => item.name === measure.name)?.value ?? MISSING;
}

function readValue(bucket: AggregationBucket, measure: ChartMeasure): Conversion {
  return measure.type === DOC_COUNT_MEASURE
    ? convertCount(measureSource(bucket, measure)) : convert(measureSource(bucket, measure));
}

function extentOf(values: readonly ChartValue[]): { readonly min: number; readonly max: number } {
  const list = values.map(({ value }) => value);
  return { min: Math.min(...list), max: Math.max(...list) };
}

function finiteValueSpan(values: readonly ChartValue[]): boolean {
  const domain = chartValueDomain(extentOf(values));
  return Number.isFinite(domain.max - domain.min);
}

function measureNotices(measure: ChartMeasure, imprecise: number): ChartNotice[] {
  const notices: ChartNotice[] = [];
  if (measure.type === 'cardinality') notices.push('approximate');
  if (measure.type === 'value_count') notices.push('valueCount');
  if (imprecise > 0) notices.push('imprecise');
  return notices;
}

function plotBase(entry: BucketEntry, measure: ChartMeasure, plot: SeriesPlot<ChartBar | ChartMarker>,
  notices: readonly ChartNotice[]) {
  return {
    aggregation: entry.name, aggregationType: entry.type, measure, valueExtent: extentOf(plot.items),
    skipped: plot.skipped, notices, impreciseCount: plot.imprecise, buckets: entry.buckets.length,
    plotted: plot.items.length,
  };
}

/** Terms keep the returned slot of every bucket, including one whose value could not be plotted. */
function plotTerms(measure: ChartMeasure, buckets: readonly AggregationBucket[]): SeriesPlot<ChartBar> {
  const bars: ChartBar[] = [];
  const skipped: ChartSkipped[] = [];
  let imprecise = 0;
  buckets.forEach((bucket, index) => {
    const row = index + 1;
    const label = bucketLabel(bucket);
    const value = readValue(bucket, measure);
    if (typeof value === 'string') {
      skipped.push({ row, label, field: 'value', raw: measureSource(bucket, measure).raw, reason: value });
      return;
    }
    if (!value.precise) imprecise += 1;
    bars.push({ slot: index, row, label, ...value });
  });
  return { items: bars, skipped, imprecise };
}

/** A line breaks where its own value or the shared bucket key could not be read; a gap is never zero. */
function plotHistogram(measure: ChartMeasure, buckets: readonly AggregationBucket[],
  keys: readonly Conversion[],
): SeriesPlot<ChartMarker> {
  const markers: ChartMarker[] = [];
  const skipped: ChartSkipped[] = [];
  let imprecise = 0;
  buckets.forEach((bucket, index) => {
    const row = index + 1;
    const label = bucketLabel(bucket);
    const value = readValue(bucket, measure);
    if (typeof value === 'string') {
      skipped.push({ row, label, field: 'value', raw: measureSource(bucket, measure).raw, reason: value });
      return;
    }
    const key = keys[index]!;
    if (typeof key === 'string') {
      skipped.push({ row, label, field: 'key', raw: bucket.key.raw, reason: key });
      return;
    }
    if (!value.precise) imprecise += 1;
    markers.push({ row, label, position: key.value, ...value });
  });
  return { items: markers, skipped, imprecise };
}

function toSegments(markers: readonly ChartMarker[]): ChartMarker[][] {
  const segments: ChartMarker[][] = [];
  for (const marker of markers) {
    const previous = segments[segments.length - 1];
    if (previous && marker.row === previous[previous.length - 1]!.row + 1) previous.push(marker);
    else segments.push([marker]);
  }
  return segments;
}

/**
 * Build bounded plot data for one entry of one received page. Types come from the executed
 * definition already resolved by the aggregation reader, never from the response shape, and the
 * result never combines pages, adds missing buckets or reorders buckets into another semantics.
 * A second measure only adds another series over the very same entry, kept fully separate.
 */
export function buildAggregationChart(
  entry: AggregationResult, measure: string | null, secondary: string | null = null,
): AggregationChartResult {
  if (entry.status === 'metric') return singleValueChart(entry, measure, secondary);
  if (entry.status !== 'buckets') return { ok: false, code: 'unplottable' };
  if (entry.buckets.length > CHART_LIMITS.buckets) {
    return { ok: false, code: 'tooManyBuckets', buckets: entry.buckets.length, skipped: [] };
  }
  if (entry.buckets.length === 0) return { ok: false, code: 'noBuckets', buckets: 0, skipped: [] };
  const all = chartMeasures(entry);
  const selected = all.find((item) => item.name === (measure ?? DOC_COUNT_MEASURE));
  if (!selected) return { ok: false, code: 'unknownMeasure' };
  const second = secondary === null ? null : all.find((item) => item.name === secondary) ?? null;
  if (secondary !== null && !second) return { ok: false, code: 'unknownSecondary' };
  if (second && second.name === selected.name) return { ok: false, code: 'secondarySame' };
  const refused = (skipped: readonly ChartSkipped[]): AggregationChartResult => ({
    ok: false, code: 'noPlottableValues', buckets: entry.buckets.length, skipped,
  });

  if (entry.type === 'terms') {
    const bars = plotTerms(selected, entry.buckets);
    if (bars.items.length === 0) return refused(bars.skipped);
    if (!finiteValueSpan(bars.items)) return { ok: false, code: 'valueDomainOutOfRange' };
    let secondaryBars: ChartMeasureBars | null = null;
    if (second) {
      const other = plotTerms(second, entry.buckets);
      if (other.items.length === 0) {
        return { ok: false, code: 'secondaryNoValues', buckets: entry.buckets.length, skipped: other.skipped };
      }
      if (!finiteValueSpan(other.items)) return { ok: false, code: 'secondaryDomainOutOfRange' };
      secondaryBars = {
        measure: second, valueExtent: extentOf(other.items), bars: other.items,
        skipped: other.skipped, notices: measureNotices(second, other.imprecise),
        impreciseCount: other.imprecise, plotted: other.items.length,
      };
    }
    const notices = measureNotices(selected, bars.imprecise);
    if (entry.docCountError.raw === '-1') notices.push('errorUnknown');
    else if (entry.docCountError.kind === 'missing') notices.push('errorNotReported');
    const other = entry.sumOtherDocCount.raw;
    if (other !== null && COUNT_TOKEN.test(other) && BigInt(other) > 0n) notices.push('omittedBuckets');
    notices.push('termsScope');
    return {
      ok: true,
      chart: {
        ...plotBase(entry, selected, bars, notices), kind: 'bars',
        slots: entry.buckets.length, slotLabels: entry.buckets.map(bucketLabel), bars: bars.items,
        secondary: secondaryBars,
      },
    };
  }

  const keys = entry.buckets.map((bucket) => convertPosition(bucket.key));
  const positions = keys.flatMap((key) => (typeof key === 'string' ? [] : [key.value]));
  const first = plotHistogram(selected, entry.buckets, keys);
  if (first.items.length === 0) return refused(first.skipped);
  if (!finiteValueSpan(first.items)) return { ok: false, code: 'valueDomainOutOfRange' };
  const notices = measureNotices(selected, first.imprecise);
  notices.push('bucketStarts');
  if (first.skipped.length > 0) notices.push('sparseSeries');
  let secondarySeries: ChartMeasureSeries | null = null;
  if (second) {
    const other = plotHistogram(second, entry.buckets, keys);
    if (other.items.length === 0) {
      return { ok: false, code: 'secondaryNoValues', buckets: entry.buckets.length, skipped: other.skipped };
    }
    if (!finiteValueSpan(other.items)) return { ok: false, code: 'secondaryDomainOutOfRange' };
    const otherNotices = measureNotices(second, other.imprecise);
    if (other.skipped.length > 0) otherNotices.push('sparseSeries');
    secondarySeries = {
      measure: second, valueExtent: extentOf(other.items), series: toSegments(other.items),
      skipped: other.skipped, notices: otherNotices, impreciseCount: other.imprecise, plotted: other.items.length,
    };
  }
  return {
    ok: true,
    chart: {
      ...plotBase(entry, selected, first, notices), kind: 'line', series: toSegments(first.items),
      positionExtent: { min: Math.min(...positions), max: Math.max(...positions) },
      secondary: secondarySeries,
    },
  };
}
