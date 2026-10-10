import { describe, expect, it } from 'vitest';
import {
  CHART_LIMITS, DOC_COUNT_MEASURE, buildAggregationChart, chartAxisSlots, chartMeasures,
  chartPositionDomain, chartValueDomain,
} from '../../src/domain/query-aggregation-charts';
import { readAggregationPage, type AggregationResult } from '../../src/domain/query-aggregations';

function pageEntries(dsl: string, aggregations: string): readonly AggregationResult[] {
  const response = `{"timed_out":false,"_shards":{"total":1,"successful":1,"failed":0},"aggregations":${aggregations}}`;
  const result = readAggregationPage(dsl, response);
  if (!result.ok) throw new Error(`fixture rejected: ${result.code}`);
  return result.entries;
}

function pageEntry(dsl: string, aggregations: string, name: string): AggregationResult {
  const found = pageEntries(dsl, aggregations).find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture entry missing: ${name}`);
  return found;
}

const TERMS = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind","size":4}}}}';
const TERMS_METRIC = '{"size":0,"aggs":{"kinds":{"terms":{"field":"kind","size":4},'
  + '"aggs":{"total":{"sum":{"field":"amount"}}}}}}';
const HISTOGRAM = '{"size":0,"aggs":{"per":{"date_histogram":{"field":"at","fixed_interval":"1h"}}}}';
const METRICS = '{"size":0,"aggs":{"total":{"sum":{"field":"a"}},"uniq":{"cardinality":{"field":"b"}},'
  + '"cnt":{"value_count":{"field":"c"}},"nil":{"avg":{"field":"d"}},"absent":{"max":{"field":"e"}}}}';

function terms(buckets: string): AggregationResult {
  return pageEntry(TERMS, `{"kinds":{"buckets":[${buckets}]}}`, 'kinds');
}

function termsWithMetric(buckets: string): AggregationResult {
  return pageEntry(TERMS_METRIC, `{"kinds":{"buckets":[${buckets}]}}`, 'kinds');
}

function histogram(buckets: string): AggregationResult {
  return pageEntry(HISTOGRAM, `{"per":{"buckets":[${buckets}]}}`, 'per');
}

function plotted(result: ReturnType<typeof buildAggregationChart>) {
  if (!result.ok) throw new Error(`expected a chart, got ${result.code}`);
  return result.chart;
}

describe('aggregation chart measures', () => {
  it('offers doc_count plus the executed direct metrics and nothing for a single-value entry', () => {
    expect(chartMeasures(terms('{"key":"a","doc_count":1}'))).toEqual([
      { name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE },
    ]);
    expect(chartMeasures(termsWithMetric('{"key":"a","doc_count":1,"total":{"value":2}}'))).toEqual([
      { name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE },
      { name: 'total', type: 'sum' },
    ]);
    expect(chartMeasures(pageEntry(METRICS, '{"total":{"value":1}}', 'total'))).toEqual([]);
  });

  it('refuses an unknown measure instead of falling back to doc_count', () => {
    const entry = termsWithMetric('{"key":"a","doc_count":9,"total":{"value":2}}');
    expect(buildAggregationChart(entry, 'missing-metric')).toEqual({ ok: false, code: 'unknownMeasure' });
    expect(buildAggregationChart(entry, DOC_COUNT_MEASURE).ok).toBe(true);
    expect(buildAggregationChart(pageEntry(METRICS, '{"total":{"value":1}}', 'total'), 'other'))
      .toEqual({ ok: false, code: 'unknownMeasure' });
  });
});

describe('aggregation bar chart', () => {
  it('plots returned terms in order with raw key labels and a real zero', () => {
    const chart = plotted(buildAggregationChart(terms('{"key":"a","doc_count":3},{"key":"b"},{"key":"c","doc_count":0}'), null));
    if (chart.kind !== 'bars') throw new Error('expected bars');
    expect(chart.aggregation).toBe('kinds');
    expect(chart).toMatchObject({
      aggregationType: 'terms', measure: { name: DOC_COUNT_MEASURE, type: DOC_COUNT_MEASURE },
      slots: 3, buckets: 3, plotted: 2, valueExtent: { min: 0, max: 3 },
    });
    expect(chart.slotLabels).toEqual(['"a"', '"b"', '"c"']);
    expect(chart.bars).toEqual([
      { slot: 0, row: 1, label: '"a"', value: 3, raw: '3', precise: true },
      { slot: 2, row: 3, label: '"c"', value: 0, raw: '0', precise: true },
    ]);
    // The bucket without a returned count keeps its slot and is reported, never drawn as zero.
    expect(chart.skipped).toEqual([{ row: 2, label: '"b"', field: 'value', raw: null, reason: 'missing' }]);
    expect(chart.notices).toContain('termsScope');
  });

  it('plots an explicitly selected metric and keeps null values out of the drawing', () => {
    const chart = plotted(buildAggregationChart(termsWithMetric(
      '{"key":"a","doc_count":1,"total":{"value":2.5}},{"key":"b","doc_count":1,"total":{"value":null}},'
      + '{"key":"c","doc_count":1}',
    ), 'total'));
    if (chart.kind !== 'bars') throw new Error('expected bars');
    expect(chart.measure).toEqual({ name: 'total', type: 'sum' });
    expect(chart.bars.map(({ value, raw }) => [value, raw])).toEqual([[2.5, '2.5']]);
    expect(chart.skipped).toEqual([
      { row: 2, label: '"b"', field: 'value', raw: 'null', reason: 'null' },
      { row: 3, label: '"c"', field: 'value', raw: null, reason: 'missing' },
    ]);
    expect(chart.valueExtent).toEqual({ min: 2.5, max: 2.5 });
  });

  it('reports counts that exceed the exact integer range instead of drawing a rounded bar', () => {
    const chart = plotted(buildAggregationChart(terms('{"key":"a","doc_count":99999999999999999999},{"key":"b","doc_count":2}'), null));
    if (chart.kind !== 'bars') throw new Error('expected bars');
    expect(chart.bars).toHaveLength(1);
    expect(chart.skipped).toEqual([{
      row: 1, label: '"a"', field: 'value', raw: '99999999999999999999', reason: 'outOfRange',
    }]);
  });

  it.each([
    ['overflow', '1e400'], ['underflow', '1e-400'], ['negative overflow', '-1e400'],
  ])('refuses to plot a %s metric value as a bar', (_name, token) => {
    const result = buildAggregationChart(termsWithMetric(`{"key":"a","doc_count":1,"total":{"value":${token}}}`), 'total');
    expect(result).toEqual({
      ok: false, code: 'noPlottableValues', buckets: 1,
      skipped: [{ row: 1, label: '"a"', field: 'value', raw: token, reason: 'outOfRange' }],
    });
  });

  it('flags a plotted double that is not the exact returned token and keeps the token', () => {
    const chart = plotted(buildAggregationChart(termsWithMetric(
      '{"key":"a","doc_count":1,"total":{"value":9007199254740993}},{"key":"b","doc_count":1,"total":{"value":1.50}}',
    ), 'total'));
    if (chart.kind !== 'bars') throw new Error('expected bars');
    expect(chart.bars).toEqual([
      { slot: 0, row: 1, label: '"a"', value: 9007199254740992, raw: '9007199254740993', precise: false },
      { slot: 1, row: 2, label: '"b"', value: 1.5, raw: '1.50', precise: true },
    ]);
    expect(chart.impreciseCount).toBe(1);
    expect(chart.notices).toContain('imprecise');
  });

  it('keeps terms error bounds, unknown bounds and omitted counts visible next to the bars', () => {
    const notices = (aggregations: string) => plotted(buildAggregationChart(
      pageEntry(TERMS, aggregations, 'kinds'), null)).notices;
    expect(notices('{"kinds":{"doc_count_error_upper_bound":-1,"sum_other_doc_count":17,"buckets":[{"key":"a","doc_count":1}]}}'))
      .toEqual(expect.arrayContaining(['errorUnknown', 'omittedBuckets', 'termsScope']));
    expect(notices('{"kinds":{"sum_other_doc_count":0,"buckets":[{"key":"a","doc_count":1}]}}'))
      .toEqual(expect.arrayContaining(['errorNotReported']));
    expect(notices('{"kinds":{"doc_count_error_upper_bound":0,"sum_other_doc_count":0,"buckets":[{"key":"a","doc_count":1}]}}'))
      .not.toEqual(expect.arrayContaining(['errorUnknown', 'errorNotReported', 'omittedBuckets']));
  });

  it('marks an approximate or count measure without changing the plotted values', () => {
    const dsl = '{"size":0,"aggs":{"kinds":{"terms":{"field":"k"},"aggs":{"uniq":{"cardinality":{"field":"u"}},'
      + '"cnt":{"value_count":{"field":"c"}}}}}}';
    const entry = (metric: string) => pageEntry(dsl, `{"kinds":{"buckets":[{"key":"a","doc_count":4,"${metric}":{"value":4}}]}}`, 'kinds');
    expect(plotted(buildAggregationChart(entry('uniq'), 'uniq')).notices).toContain('approximate');
    expect(plotted(buildAggregationChart(entry('cnt'), 'cnt')).notices).toContain('valueCount');
    expect(plotted(buildAggregationChart(entry('cnt'), DOC_COUNT_MEASURE)).notices).not.toContain('valueCount');
  });
});

describe('aggregation line chart', () => {
  it('plots returned bucket starts as positions and prefers the server string for labels', () => {
    const chart = plotted(buildAggregationChart(histogram(
      '{"key":0,"key_as_string":"1970-01-01T00:00:00.000Z","doc_count":1},'
      + '{"key":3600000,"doc_count":2},{"key":-3600000,"doc_count":3}',
    ), null));
    if (chart.kind !== 'line') throw new Error('expected a line');
    expect(chart.aggregationType).toBe('date_histogram');
    expect(chart.series).toHaveLength(1);
    expect(chart.series[0]!.map(({ row, position, label, value }) => [row, position, label, value])).toEqual([
      [1, 0, '"1970-01-01T00:00:00.000Z"', 1],
      [2, 3600000, '3600000', 2],
      [3, -3600000, '-3600000', 3],
    ]);
    expect(chart.positionExtent).toEqual({ min: -3600000, max: 3600000 });
    expect(chart.notices).toContain('bucketStarts');
    expect(chart.notices).not.toContain('sparseSeries');
    expect(chart.skipped).toEqual([]);
  });

  it('splits the line at a bucket whose value was not returned and keeps its position on the axis', () => {
    const chart = plotted(buildAggregationChart(histogram(
      '{"key":0,"doc_count":1},{"key":3600000},{"key":7200000,"doc_count":3}',
    ), null));
    if (chart.kind !== 'line') throw new Error('expected a line');
    expect(chart.series.map((segment) => segment.map(({ row }) => row))).toEqual([[1], [3]]);
    expect(chart.skipped).toEqual([{ row: 2, label: '3600000', field: 'value', raw: null, reason: 'missing' }]);
    expect(chart.positionExtent).toEqual({ min: 0, max: 7200000 });
    expect(chart.notices).toContain('sparseSeries');
  });

  it('skips a key outside the exactly representable range instead of drawing it at a rounded position', () => {
    const chart = plotted(buildAggregationChart(histogram(
      '{"key":9007199254740993,"doc_count":1},{"key":0,"doc_count":2}',
    ), null));
    if (chart.kind !== 'line') throw new Error('expected a line');
    expect(chart.skipped).toEqual([{
      row: 1, label: '9007199254740993', field: 'key', raw: '9007199254740993', reason: 'outOfRange',
    }]);
    expect(chart.series).toEqual([[expect.objectContaining({ row: 2, position: 0, value: 2 })]]);
    expect(chart.positionExtent).toEqual({ min: 0, max: 0 });
  });

  it('does not plot a histogram entry whose key is not an integer bucket start', () => {
    expect(buildAggregationChart(histogram('{"key":1.5,"doc_count":1}'), null))
      .toEqual({ ok: false, code: 'unplottable' });
  });

  it('plots a keyed histogram by its numeric key without promoting the member name', () => {
    const dsl = '{"size":0,"aggs":{"per":{"date_histogram":{"field":"at","fixed_interval":"1d","keyed":true}}}}';
    const entry = pageEntry(dsl, '{"per":{"buckets":{"first":{"key":0,"doc_count":1}}}}', 'per');
    const chart = plotted(buildAggregationChart(entry, null));
    if (chart.kind !== 'line') throw new Error('expected a line');
    expect(chart.series[0]![0]).toMatchObject({ label: '0', position: 0, value: 1, raw: '1' });
    expect(chart.series[0]![0]!.label).not.toBe('first');
  });
});

describe('aggregation single value chart', () => {
  const metric = (name: string) => pageEntry(METRICS, '{"total":{"value":42},"uniq":{"value":7},"cnt":{"value":8},"nil":{"value":null}}', name);

  it('keeps the original token as the displayed value', () => {
    const chart = plotted(buildAggregationChart(metric('total'), null));
    expect(chart).toMatchObject({
      kind: 'singleValue', aggregation: 'total', aggregationType: 'sum', plotted: 1, buckets: 0,
      single: { value: 42, raw: '42', precise: true }, notices: [],
    });
  });

  it('labels approximate and count measures and an inexact double', () => {
    expect(plotted(buildAggregationChart(metric('uniq'), null)).notices).toEqual(['approximate']);
    expect(plotted(buildAggregationChart(metric('cnt'), null)).notices).toEqual(['valueCount']);
    const imprecise = pageEntry('{"size":0,"aggs":{"total":{"sum":{"field":"a"}}}}', '{"total":{"value":9007199254740993}}', 'total');
    const chart = plotted(buildAggregationChart(imprecise, null));
    if (chart.kind !== 'singleValue') throw new Error('expected a single value');
    expect(chart.single).toEqual({ value: 9007199254740992, raw: '9007199254740993', precise: false });
    expect(chart.notices).toEqual(['imprecise']);
    expect(chart.impreciseCount).toBe(1);
  });

  it('reports a null or absent metric instead of drawing zero', () => {
    expect(buildAggregationChart(metric('nil'), null)).toEqual({
      ok: false, code: 'noPlottableValues', buckets: 0,
      skipped: [{ row: 1, label: 'nil', field: 'value', raw: 'null', reason: 'null' }],
    });
    expect(buildAggregationChart(metric('absent'), null)).toEqual({ ok: false, code: 'unplottable' });
  });
});

describe('aggregation chart refusals', () => {
  it.each(['unrequested', 'unsupported', 'invalid'] as const)('does not plot a %s entry', (status) => {
    const entries = pageEntries(
      '{"size":0,"aggs":{"known":{"terms":{"field":"k"}},"advanced":{"percentiles":{"field":"n"}}}}',
      '{"unknown":{"buckets":[]},"advanced":{"values":{"1.0":2}},"known":{"buckets":[{"doc_count":1}]}}',
    );
    const entry = entries.find((item) => item.status === status);
    expect(entry?.status).toBe(status);
    expect(buildAggregationChart(entry!, null)).toEqual({ ok: false, code: 'unplottable' });
  });

  it('refuses an empty bucket list and an over-budget one as a whole', () => {
    expect(buildAggregationChart(terms(''), null)).toEqual({ ok: false, code: 'noBuckets', buckets: 0, skipped: [] });
    const many = Array.from({ length: CHART_LIMITS.buckets + 1 }, (_, index) => `{"key":"k${index}","doc_count":1}`).join(',');
    expect(buildAggregationChart(terms(many), null)).toEqual({
      ok: false, code: 'tooManyBuckets', buckets: CHART_LIMITS.buckets + 1, skipped: [],
    });
    const budget = Array.from({ length: CHART_LIMITS.buckets }, (_, index) => `{"key":"k${index}","doc_count":1}`).join(',');
    expect(plotted(buildAggregationChart(terms(budget), null)).plotted).toBe(CHART_LIMITS.buckets);
  });

  it('refuses to draw an empty plot when every returned value was skipped', () => {    const result = buildAggregationChart(terms('{"key":"a"},{"key":"b"}'), null);
    expect(result).toEqual({
      ok: false, code: 'noPlottableValues', buckets: 2,
      skipped: [
        { row: 1, label: '"a"', field: 'value', raw: null, reason: 'missing' },
        { row: 2, label: '"b"', field: 'value', raw: null, reason: 'missing' },
      ],
    });
  });

  it('plots a prototype-named aggregation and key without treating them as inherited members', () => {
    const entry = pageEntry('{"size":0,"aggs":{"__proto__":{"terms":{"field":"constructor"}}}}',
      '{"__proto__":{"buckets":[{"key":"__proto__","doc_count":1}]}}', '__proto__');
    const chart = plotted(buildAggregationChart(entry, null));
    if (chart.kind !== 'bars') throw new Error('expected bars');
    expect(chart.aggregation).toBe('__proto__');
    expect(chart.slotLabels).toEqual(['"__proto__"']);
    expect(chart.bars[0]!.label).toBe('"__proto__"');
  });

  it('reads the entry without changing it and repeats the same model', () => {
    const entry = termsWithMetric('{"key":"a","doc_count":1,"total":{"value":2.5}}');
    const before = JSON.stringify(entry);
    const first = buildAggregationChart(entry, 'total');
    const second = buildAggregationChart(entry, 'total');
    expect(JSON.stringify(entry)).toBe(before);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('chart axis helpers', () => {
  it('labels every slot within the limit and an even subset beyond it', () => {
    expect(chartAxisSlots(0)).toEqual([]);
    expect(chartAxisSlots(3)).toEqual([0, 1, 2]);
    expect(chartAxisSlots(CHART_LIMITS.axisLabels)).toEqual(Array.from({ length: CHART_LIMITS.axisLabels }, (_, index) => index));
    const sparse = chartAxisSlots(200);
    expect(sparse).toHaveLength(CHART_LIMITS.axisLabels);
    expect(sparse[0]).toBe(0);
    expect(sparse.at(-1)).toBe(199);
    expect(new Set(sparse).size).toBe(sparse.length);
    expect(sparse).toEqual([...sparse].sort((left, right) => left - right));
    expect(chartAxisSlots(4, 2)).toEqual([0, 3]);
  });

  it('keeps zero inside the value domain and pads a degenerate one', () => {
    expect(chartValueDomain({ min: 3, max: 9 })).toEqual({ min: 0, max: 9 });
    expect(chartValueDomain({ min: -9, max: -3 })).toEqual({ min: -9, max: 0 });
    expect(chartValueDomain({ min: 0, max: 0 })).toEqual({ min: 0, max: 1 });
  });

  it('plots bucket positions as returned and pads a single position', () => {
    expect(chartPositionDomain({ min: 0, max: 7200000 })).toEqual({ min: 0, max: 7200000 });
    expect(chartPositionDomain({ min: 5, max: 5 })).toEqual({ min: 4, max: 6 });
  });
});
