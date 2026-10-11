import { describe, expect, it } from 'vitest';
import {
  CHART_LIMITS, DOC_COUNT_MEASURE, buildAggregationChart, chartMeasures, chartValueDomain,
} from '../../src/domain/query-aggregation-charts';
import { readAggregationPage, type AggregationResult } from '../../src/domain/query-aggregations';

const HISTOGRAM = '{"size":0,"aggs":{"per":{"date_histogram":{"field":"at","fixed_interval":"1h"}}}}';
const HISTOGRAM_METRICS = '{"size":0,"aggs":{"per":{"date_histogram":{"field":"at","fixed_interval":"1h"},'
  + '"aggs":{"total":{"sum":{"field":"amount"}},"uniq":{"cardinality":{"field":"id"}}}}}}';
const TERMS_METRICS = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind"},'
  + '"aggs":{"total":{"sum":{"field":"amount"}}}}}}';
const METRIC = '{"size":0,"aggs":{"amount":{"sum":{"field":"a"}}}}';

function entryOf(dsl: string, aggregations: string, name: string): AggregationResult {
  const response = `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"aggregations":${aggregations}}`;
  const result = readAggregationPage(dsl, response);
  if (!result.ok) throw new Error(`fixture rejected: ${result.code}`);
  const found = result.entries.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture entry missing: ${name}`);
  return found;
}

const histogram = (buckets: string) => entryOf(HISTOGRAM, `{"per":{"buckets":[${buckets}]}}`, 'per');
const withMetrics = (buckets: string) => entryOf(HISTOGRAM_METRICS, `{"per":{"buckets":[${buckets}]}}`, 'per');
const terms = (buckets: string) => entryOf(TERMS_METRICS, `{"kinds":{"buckets":[${buckets}]}}`, 'kinds');

function line(result: ReturnType<typeof buildAggregationChart>) {
  if (!result.ok) throw new Error(`expected a chart, got ${result.code}`);
  if (result.chart.kind !== 'line') throw new Error(`expected a line, got ${result.chart.kind}`);
  return result.chart;
}

const rows = (segments: readonly (readonly { row: number }[])[]) => segments.map((segment) => segment.map(({ row }) => row));

describe('second measure of one verified entry', () => {
  it('offers only measures of the same entry and keeps doc_count first', () => {
    expect(chartMeasures(withMetrics('{"key":0,"doc_count":1,"total":{"value":2},"uniq":{"value":3}}')))
      .toEqual([
        { name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE },
        { name: 'total', type: 'sum' },
        { name: 'uniq', type: 'cardinality' },
      ]);
  });

  it('plots a second series over the same returned buckets, positions and labels', () => {
    const entry = withMetrics(
      '{"key":0,"key_as_string":"1970-01-01T00:00:00.000Z","doc_count":1,"total":{"value":900}},'
      + '{"key":3600000,"doc_count":3,"total":{"value":1800}}',
    );
    const chart = line(buildAggregationChart(entry, null, 'total'));
    expect(chart.secondary).not.toBeNull();
    const secondary = chart.secondary!;
    expect(secondary.measure).toEqual({ name: 'total', type: 'sum' });
    expect(secondary.valueExtent).toEqual({ min: 900, max: 1800 });
    expect(secondary.plotted).toBe(2);
    expect(secondary.skipped).toEqual([]);
    expect(secondary.series).toEqual([[
      { row: 1, label: '"1970-01-01T00:00:00.000Z"', position: 0, value: 900, raw: '900', precise: true },
      { row: 2, label: '3600000', position: 3600000, value: 1800, raw: '1800', precise: true },
    ]]);
    // The primary keeps its own measure, extent and counts; nothing is merged into one axis.
    expect(chart.measure).toEqual({ name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE });
    expect(chart.valueExtent).toEqual({ min: 1, max: 3 });
    expect(chartValueDomain(chart.valueExtent)).toEqual({ min: 0, max: 3 });
    expect(chartValueDomain(secondary.valueExtent)).toEqual({ min: 0, max: 1800 });
    expect(chart.positionExtent).toEqual({ min: 0, max: 3600000 });
    expect(chart.buckets).toBe(2);
  });

  it('checks precision per measure and keeps each original token next to its own drawn value', () => {
    const entry = withMetrics(
      '{"key":0,"doc_count":1,"total":{"value":9007199254740993}},{"key":3600000,"doc_count":2,"total":{"value":1.50}}',
    );
    const chart = line(buildAggregationChart(entry, null, 'total'));
    const secondary = chart.secondary!;
    expect(chart.impreciseCount).toBe(0);
    expect(chart.notices).not.toContain('imprecise');
    expect(secondary.impreciseCount).toBe(1);
    expect(secondary.notices).toContain('imprecise');
    expect(secondary.series.flat().map(({ raw, value, precise }) => [raw, value, precise])).toEqual([
      ['9007199254740993', 9007199254740992, false],
      ['1.50', 1.5, true],
    ]);
    expect(chart.series.flat().map(({ raw, precise }) => [raw, precise])).toEqual([['1', true], ['2', true]]);
  });

  it('lists unplotted values per measure instead of hiding one measure behind the other', () => {
    const entry = withMetrics(
      '{"key":0,"total":{"value":5}},{"key":3600000,"doc_count":2,"total":{"value":null}},'
      + '{"key":7200000,"doc_count":4,"total":{"value":9}}',
    );
    const chart = line(buildAggregationChart(entry, null, 'total'));
    expect(chart.skipped).toEqual([
      { row: 1, label: '0', field: 'value', raw: null, reason: 'missing' },
    ]);
    expect(chart.secondary!.skipped).toEqual([
      { row: 2, label: '3600000', field: 'value', raw: 'null', reason: 'null' },
    ]);
    expect(rows(chart.series)).toEqual([[2, 3]]);
    expect(rows(chart.secondary!.series)).toEqual([[1], [3]]);
    expect(chart.notices).toContain('sparseSeries');
    expect(chart.secondary!.notices).toContain('sparseSeries');
  });

  it('reports the shared unreadable bucket key in both series without drawing either there', () => {
    const entry = withMetrics(
      '{"key":9007199254740993,"doc_count":1,"total":{"value":7}},{"key":0,"doc_count":2,"total":{"value":8}}',
    );
    const chart = line(buildAggregationChart(entry, null, 'total'));
    const skippedKey = { row: 1, label: '9007199254740993', field: 'key', raw: '9007199254740993', reason: 'outOfRange' };
    expect(chart.skipped).toEqual([expect.objectContaining(skippedKey)]);
    expect(chart.secondary!.skipped).toEqual([expect.objectContaining(skippedKey)]);
    expect(rows(chart.series)).toEqual([[2]]);
    expect(rows(chart.secondary!.series)).toEqual([[2]]);
    expect(chart.positionExtent).toEqual({ min: 0, max: 0 });
  });

  it('never reorders buckets, fills a missing interval or infers an end boundary for either series', () => {
    const entry = withMetrics(
      '{"key":7200000,"doc_count":1,"total":{"value":10}},{"key":0,"doc_count":5,"total":{"value":20}}',
    );
    const chart = line(buildAggregationChart(entry, null, 'total'));
    expect(chart.series.flat().map(({ row, position }) => [row, position])).toEqual([[1, 7200000], [2, 0]]);
    expect(chart.secondary!.series.flat().map(({ row, position }) => [row, position])).toEqual([[1, 7200000], [2, 0]]);
    expect(chart.positionExtent).toEqual({ min: 0, max: 7200000 });
    expect(chart.notices).toContain('bucketStarts');
    expect(chart.secondary!.notices).not.toContain('bucketStarts');
  });

  it('marks an approximate second measure without touching the first measure notices', () => {
    const entry = withMetrics('{"key":0,"doc_count":1,"total":{"value":2},"uniq":{"value":9007199254740993}}');
    const chart = line(buildAggregationChart(entry, DOC_COUNT_MEASURE, 'uniq'));
    expect(chart.notices).toEqual(['bucketStarts']);
    expect(chart.secondary!.notices).toEqual(['approximate', 'imprecise']);
    expect(chart.secondary!.valueExtent).toEqual({ min: 9007199254740992, max: 9007199254740992 });
    expect(chart.secondary!.series.flat()[0]).toMatchObject({ raw: '9007199254740993', precise: false });
  });

  it('gives each measure its own value domain so neither axis is normalized to the other', () => {
    const entry = withMetrics(
      '{"key":0,"doc_count":1,"total":{"value":400000}},{"key":3600000,"doc_count":3,"total":{"value":800000}}',
    );
    const chart = line(buildAggregationChart(entry, null, 'total'));
    expect(chartValueDomain(chart.valueExtent)).toEqual({ min: 0, max: 3 });
    expect(chartValueDomain(chart.secondary!.valueExtent)).toEqual({ min: 0, max: 800000 });
  });
});

describe('second measure refusals', () => {
  it('refuses an unknown or foreign second measure instead of falling back to one series', () => {
    const entry = withMetrics('{"key":0,"doc_count":1,"total":{"value":2}}');
    expect(buildAggregationChart(entry, null, 'other')).toEqual({ ok: false, code: 'unknownSecondary' });
    expect(buildAggregationChart(entry, null, DOC_COUNT_MEASURE)).toEqual({ ok: false, code: 'secondarySame' });
    expect(buildAggregationChart(entry, 'total', 'total')).toEqual({ ok: false, code: 'secondarySame' });
    expect(line(buildAggregationChart(entry, 'total', DOC_COUNT_MEASURE)).secondary!.measure).toEqual(
      { name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE },
    );
    expect(buildAggregationChart(entry, 'missing-metric', 'total')).toEqual({ ok: false, code: 'unknownMeasure' });
  });

  it('refuses a second measure where the chart kind does not offer one', () => {
    expect(buildAggregationChart(terms('{"key":"a","doc_count":1,"total":{"value":2}}'), null, 'total'))
      .toEqual({ ok: false, code: 'secondaryUnsupported' });
    expect(buildAggregationChart(entryOf(METRIC, '{"amount":{"value":4}}', 'amount'), null, 'amount'))
      .toEqual({ ok: false, code: 'secondaryUnsupported' });
    expect(buildAggregationChart(histogram('{"key":0,"doc_count":1}'), null, 'nope'))
      .toEqual({ ok: false, code: 'unknownSecondary' });
  });

  it('refuses the whole plot when the second measure has nothing plottable', () => {
    const entry = withMetrics('{"key":0,"doc_count":1},{"key":3600000,"doc_count":2}');
    expect(buildAggregationChart(entry, null, 'total')).toEqual({
      ok: false, code: 'secondaryNoValues', buckets: 2,
      skipped: [
        { row: 1, label: '0', field: 'value', raw: null, reason: 'missing' },
        { row: 2, label: '3600000', field: 'value', raw: null, reason: 'missing' },
      ],
    });
    // The first measure alone still plots, so the refusal is about the requested pair, not a silent
    // fallback to one series.
    expect(line(buildAggregationChart(entry, null)).secondary).toBeNull();
  });

  it('refuses the first measure before the second one is even read', () => {
    const entry = withMetrics('{"key":0,"total":{"value":1}},{"key":3600000,"total":{"value":2}}');
    expect(buildAggregationChart(entry, null, 'total')).toEqual({
      ok: false, code: 'noPlottableValues', buckets: 2,
      skipped: [
        { row: 1, label: '0', field: 'value', raw: null, reason: 'missing' },
        { row: 2, label: '3600000', field: 'value', raw: null, reason: 'missing' },
      ],
    });
  });

  it('keeps the bucket quota for the shared entry: 200 plots both, 201 refuses both', () => {
    const budget = Array.from({ length: CHART_LIMITS.buckets }, (_, index) =>
      `{"key":${index * 3600000},"doc_count":1,"total":{"value":2}}`).join(',');
    const chart = line(buildAggregationChart(withMetrics(budget), null, 'total'));
    expect(chart.buckets).toBe(CHART_LIMITS.buckets);
    expect(chart.plotted).toBe(CHART_LIMITS.buckets);
    expect(chart.secondary!.plotted).toBe(CHART_LIMITS.buckets);
    const over = Array.from({ length: CHART_LIMITS.buckets + 1 }, (_, index) =>
      `{"key":${index * 3600000},"doc_count":1,"total":{"value":2}}`).join(',');
    expect(buildAggregationChart(withMetrics(over), null, 'total'))
      .toEqual({ ok: false, code: 'tooManyBuckets', buckets: CHART_LIMITS.buckets + 1, skipped: [] });
  });

  it('reads the entry without changing it and repeats the same dual model', () => {
    const entry = withMetrics('{"key":0,"doc_count":1,"total":{"value":2.5}}');
    const before = JSON.stringify(entry);
    const first = buildAggregationChart(entry, null, 'total');
    const second = buildAggregationChart(entry, null, 'total');
    expect(JSON.stringify(entry)).toBe(before);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});
